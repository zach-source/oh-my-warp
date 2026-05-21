//! A local web app that **wraps Claude Code**: type a prompt in the browser and
//! watch the agent's text and tool calls stream in live.
//!
//! It runs `claude -p <prompt> --output-format stream-json --verbose` as a
//! subprocess, parses Claude Code's newline-delimited JSON event stream, and
//! re-emits it to the page over **Server-Sent Events** — the same SSE shape
//! Warp's own agent UI consumes (see ../../BACKEND_INTERFACE.md). It's the
//! smallest end-to-end example of wrapping a coding-harness CLI as a service.
//!
//! Run:  `cargo run`  then open http://127.0.0.1:8787
//!
//! Env knobs:
//!   PORT                     listen port (default 8787)
//!   CLAUDE_MAX_BUDGET_USD    spend cap per run (default "1.00"; "off"/"0" disables)
//!   CLAUDE_PERMISSION_MODE   plan|acceptEdits|bypassPermissions|default|dontAsk|auto
//!   CLAUDE_SKIP_PERMISSIONS  "1" → --dangerously-skip-permissions (sandboxes only!)
//!   CLAUDE_WORKDIR           directory Claude runs in (default: the server's cwd)

use std::convert::Infallible;
use std::process::Stdio;

use axum::{
    extract::Query,
    response::{
        sse::{Event, KeepAlive, Sse},
        Html,
    },
    routing::get,
    Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::StreamExt;

#[derive(Deserialize)]
struct RunParams {
    prompt: String,
    /// Carry the session id back to continue a conversation (`claude --resume`).
    #[serde(default)]
    session: Option<String>,
}

#[tokio::main]
async fn main() {
    let port = std::env::var("PORT").unwrap_or_else(|_| "8787".into());
    let addr = format!("127.0.0.1:{port}");
    let app = Router::new().route("/", get(index)).route("/run", get(run));

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| panic!("failed to bind {addr}: {e}"));
    println!("claude-web → http://{addr}   (Ctrl-C to stop)");
    axum::serve(listener, app).await.expect("server error");
}

async fn index() -> Html<&'static str> {
    Html(include_str!("../static/index.html"))
}

/// SSE endpoint: spawn a Claude Code run for `prompt` and stream its events.
async fn run(
    Query(params): Query<RunParams>,
) -> Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>> {
    let (tx, rx) = mpsc::channel::<Event>(64);
    tokio::spawn(async move {
        if let Err(e) = drive_claude(params, &tx).await {
            let _ = tx
                .send(sse("error", json!({ "text": e.to_string() })))
                .await;
        }
        // Always close the turn so the browser stops listening (no SSE reconnect).
        let _ = tx.send(sse("done", json!({}))).await;
    });
    Sse::new(ReceiverStream::new(rx).map(Ok::<_, Infallible>)).keep_alive(KeepAlive::default())
}

/// Spawn `claude` and pump its stdout/stderr into the SSE channel as typed events.
async fn drive_claude(params: RunParams, tx: &mpsc::Sender<Event>) -> anyhow::Result<()> {
    let mut cmd = Command::new("claude");
    cmd.arg("--print")
        .arg(&params.prompt)
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose");

    if let Some(session) = params.session.as_deref().filter(|s| !s.is_empty()) {
        cmd.arg("--resume").arg(session);
    }
    // Safety cap on spend (default $1.00); set "off"/"0" to disable.
    let budget = std::env::var("CLAUDE_MAX_BUDGET_USD").unwrap_or_else(|_| "1.00".into());
    if !matches!(budget.as_str(), "" | "0" | "off" | "none") {
        cmd.arg("--max-budget-usd").arg(&budget);
    }
    if let Ok(mode) = std::env::var("CLAUDE_PERMISSION_MODE") {
        if !mode.is_empty() {
            cmd.arg("--permission-mode").arg(&mode);
        }
    }
    if std::env::var("CLAUDE_SKIP_PERMISSIONS").ok().as_deref() == Some("1") {
        cmd.arg("--dangerously-skip-permissions");
    }
    if let Ok(dir) = std::env::var("CLAUDE_WORKDIR") {
        if !dir.is_empty() {
            cmd.current_dir(dir);
        }
    }

    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| {
        anyhow::anyhow!("failed to spawn `claude`: {e}. Is Claude Code installed and on PATH?")
    })?;

    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");

    // Surface stderr lines (warnings, permission denials) alongside the stream.
    {
        let tx = tx.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = tx.send(sse("stderr", json!({ "text": line }))).await;
            }
        });
    }

    let mut lines = BufReader::new(stdout).lines();
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        for ev in to_events(&line) {
            // Client disconnected → stop (kill_on_drop reaps the child).
            if tx.send(ev).await.is_err() {
                return Ok(());
            }
        }
    }

    let status = child.wait().await?;
    let _ = tx.send(sse("exit", json!({ "code": status.code() }))).await;
    Ok(())
}

/// Translate one line of Claude Code `stream-json` into zero or more page events.
fn to_events(line: &str) -> Vec<Event> {
    let v: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return vec![sse("stderr", json!({ "text": line }))],
    };

    match v.get("type").and_then(Value::as_str) {
        Some("system") if v.get("subtype").and_then(Value::as_str) == Some("init") => {
            vec![sse(
                "session",
                json!({
                    "session_id": v.get("session_id"),
                    "model": v.get("model"),
                    "cwd": v.get("cwd"),
                    "tools": v.get("tools").and_then(Value::as_array).map(|a| a.len()),
                }),
            )]
        }
        Some("assistant") => content_blocks(&v)
            .into_iter()
            .filter_map(|block| match block.get("type").and_then(Value::as_str) {
                Some("text") => block
                    .get("text")
                    .and_then(Value::as_str)
                    .map(|t| sse("text", json!({ "text": t }))),
                Some("tool_use") => Some(sse(
                    "tool_use",
                    json!({ "name": block.get("name"), "input": block.get("input") }),
                )),
                _ => None,
            })
            .collect(),
        Some("user") => content_blocks(&v)
            .into_iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_result"))
            .map(|b| {
                sse(
                    "tool_result",
                    json!({
                        "text": truncate(&stringify(b.get("content")), 4000),
                        "is_error": b.get("is_error"),
                    }),
                )
            })
            .collect(),
        Some("result") => vec![sse(
            "result",
            json!({
                "text": v.get("result"),
                "is_error": v.get("is_error"),
                "cost_usd": v.get("total_cost_usd"),
                "duration_ms": v.get("duration_ms"),
                "num_turns": v.get("num_turns"),
                "session_id": v.get("session_id"),
            }),
        )],
        _ => vec![],
    }
}

fn content_blocks(v: &Value) -> Vec<Value> {
    v.pointer("/message/content")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// tool_result `content` may be a string or an array of `{type:text,text}` blocks.
fn stringify(c: Option<&Value>) -> String {
    match c {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

fn truncate(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((i, _)) => format!("{}… ({} chars total)", &s[..i], s.chars().count()),
        None => s.to_string(),
    }
}

/// Build an SSE message carrying a JSON payload with a `kind` discriminator.
fn sse(kind: &str, mut data: Value) -> Event {
    if let Value::Object(map) = &mut data {
        map.insert("kind".into(), json!(kind));
    }
    Event::default().data(data.to_string())
}
