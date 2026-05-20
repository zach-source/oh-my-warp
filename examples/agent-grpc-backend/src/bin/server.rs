//! Example gRPC **harness host**: runs a configured coding-harness CLI (pi-mono,
//! Claude Code, …) as a subprocess and exposes it over gRPC, so a remote agent
//! can be driven from Warp via the `AIClient`-decorator bridge.
//!
//! - `SpawnAgent{harness, prompt}` → launch the harness in a fresh workspace dir
//! - `StreamEvents`               → stream the harness's stdout/stderr + lifecycle
//! - `SendMessage{to=[run_id], body}` → write a line to the harness's stdin
//!
//! Harnesses are defined in `harnesses.toml` (see that file). A built-in `demo`
//! harness is used if no config is found, so this runs without pi-mono/Claude
//! installed. Run with `cargo run --bin server`.

use std::collections::HashMap;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::{broadcast, mpsc, Mutex as AsyncMutex};
use tokio_stream::{wrappers::ReceiverStream, Stream};
use tonic::{transport::Server, Request, Response, Status};

use warp_agent_grpc::pb::{
    agent_service_server::{AgentService, AgentServiceServer},
    AgentMessage, AgentRunEvent, ChatChunk, ChatRequest, ListMessagesRequest, ListMessagesResponse,
    ReadMessageRequest, ReadMessageResponse, ReportEventRequest, ReportEventResponse,
    SendMessageRequest, SendMessageResponse, SpawnAgentRequest, SpawnAgentResponse,
    StreamEventsRequest,
};

type EventStreamBox = Pin<Box<dyn Stream<Item = Result<AgentRunEvent, Status>> + Send>>;
type ChatStreamBox = Pin<Box<dyn Stream<Item = Result<ChatChunk, Status>> + Send>>;

// ── Harness config (harnesses.toml) ──────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
struct HarnessSpec {
    /// Program to exec, e.g. "pi-mono" or "claude".
    command: String,
    /// Args; the literal `{prompt}` is replaced with the run's prompt.
    #[serde(default)]
    args: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
struct HarnessConfig {
    #[serde(default)]
    harness: HashMap<String, HarnessSpec>,
}

fn load_harnesses() -> HashMap<String, HarnessSpec> {
    let path = std::env::var("HARNESSES_CONFIG").unwrap_or_else(|_| "harnesses.toml".to_string());
    match std::fs::read_to_string(&path) {
        Ok(s) => match toml::from_str::<HarnessConfig>(&s) {
            Ok(c) if !c.harness.is_empty() => {
                tracing::info!(path, harnesses = ?c.harness.keys().collect::<Vec<_>>(), "loaded harnesses");
                return c.harness;
            }
            Ok(_) => tracing::warn!("{path} has no [harness.*] entries; using built-in 'demo'"),
            Err(e) => tracing::error!("failed to parse {path}: {e}; using built-in 'demo'"),
        },
        Err(_) => tracing::warn!("no {path}; using built-in 'demo' harness only"),
    }
    let mut m = HashMap::new();
    m.insert(
        "demo".to_string(),
        HarnessSpec {
            command: "bash".to_string(),
            args: vec![
                "-c".to_string(),
                "echo 'demo harness started'; echo \"prompt: {prompt}\"; \
                 for i in 1 2 3; do echo \"step $i\"; sleep 0.3; done; echo done"
                    .to_string(),
            ],
        },
    );
    m
}

// ── Run state ────────────────────────────────────────────────────────────────

struct Run {
    run_id: String,
    seq: AtomicI64,
    tx: broadcast::Sender<AgentRunEvent>,
    history: Mutex<Vec<AgentRunEvent>>,
    stdin: AsyncMutex<Option<ChildStdin>>,
}

impl Run {
    fn push(&self, event_type: &str, text: String) {
        let sequence = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let event = AgentRunEvent {
            run_id: self.run_id.clone(),
            event_type: event_type.to_string(),
            ref_id: String::new(),
            execution_id: String::new(),
            occurred_at: String::new(),
            sequence,
            text,
        };
        self.history.lock().unwrap().push(event.clone());
        let _ = self.tx.send(event); // ok if there are no subscribers yet
    }
}

#[derive(Default)]
struct AppState {
    harnesses: HashMap<String, HarnessSpec>,
    runs: Mutex<HashMap<String, Arc<Run>>>,
}

struct HarnessHost {
    state: Arc<AppState>,
}

#[tonic::async_trait]
impl AgentService for HarnessHost {
    async fn spawn_agent(
        &self,
        request: Request<SpawnAgentRequest>,
    ) -> Result<Response<SpawnAgentResponse>, Status> {
        let req = request.into_inner();
        let harness_name = if req.harness.is_empty() {
            "demo".to_string()
        } else {
            req.harness.clone()
        };
        let spec = self
            .state
            .harnesses
            .get(&harness_name)
            .ok_or_else(|| Status::not_found(format!("unknown harness '{harness_name}'")))?
            .clone();

        let run_id = format!("run_{}", short_id());
        tracing::info!(run_id, harness = %harness_name, prompt = %req.prompt, "spawn_agent");

        // Fresh per-run workspace (a real host would clone the target repo here).
        let workspace = std::env::temp_dir().join(format!("harness-{run_id}"));
        std::fs::create_dir_all(&workspace)
            .map_err(|e| Status::internal(format!("workspace: {e}")))?;

        let args: Vec<String> = spec
            .args
            .iter()
            .map(|a| a.replace("{prompt}", &req.prompt))
            .collect();

        let mut child = Command::new(&spec.command)
            .args(&args)
            .current_dir(&workspace)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                Status::internal(format!(
                    "failed to start harness '{harness_name}' (command '{}'): {e}",
                    spec.command
                ))
            })?;

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let stdin = child.stdin.take();

        let (tx, _rx) = broadcast::channel(1024);
        let run = Arc::new(Run {
            run_id: run_id.clone(),
            seq: AtomicI64::new(0),
            tx,
            history: Mutex::new(Vec::new()),
            stdin: AsyncMutex::new(stdin),
        });
        run.push(
            "started",
            format!("harness={harness_name} command={}", spec.command),
        );
        self.state
            .runs
            .lock()
            .unwrap()
            .insert(run_id.clone(), run.clone());

        if let Some(stdout) = stdout {
            let run = run.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    run.push("output", line);
                }
            });
        }
        if let Some(stderr) = stderr {
            let run = run.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    run.push("stderr", line);
                }
            });
        }
        {
            let run = run.clone();
            tokio::spawn(async move {
                let status = child.wait().await;
                *run.stdin.lock().await = None;
                let text = match status {
                    Ok(s) => format!("harness exited: {s}"),
                    Err(e) => format!("wait error: {e}"),
                };
                run.push("completed", text);
            });
        }

        Ok(Response::new(SpawnAgentResponse {
            task_id: format!("task_{}", short_id()),
            run_id,
            at_capacity: false,
        }))
    }

    type StreamEventsStream = EventStreamBox;
    async fn stream_events(
        &self,
        request: Request<StreamEventsRequest>,
    ) -> Result<Response<Self::StreamEventsStream>, Status> {
        let req = request.into_inner();
        let run_id = req
            .run_ids
            .first()
            .cloned()
            .ok_or_else(|| Status::invalid_argument("run_ids must contain a run id"))?;
        let run = self
            .state
            .runs
            .lock()
            .unwrap()
            .get(&run_id)
            .cloned()
            .ok_or_else(|| Status::not_found(format!("unknown run '{run_id}'")))?;

        let since = req.since_sequence;
        let mut rx = run.tx.subscribe(); // subscribe before snapshotting history
        let history = run.history.lock().unwrap().clone();
        let (out_tx, out_rx) = mpsc::channel::<Result<AgentRunEvent, Status>>(256);

        tokio::spawn(async move {
            let mut last = since;
            // Replay anything that happened before the subscription.
            for event in history {
                if event.sequence > since {
                    last = last.max(event.sequence);
                    let done = event.event_type == "completed";
                    if out_tx.send(Ok(event)).await.is_err() {
                        return;
                    }
                    if done {
                        return;
                    }
                }
            }
            // Then live events (dedup against replayed ones by sequence).
            loop {
                match rx.recv().await {
                    Ok(event) if event.sequence > last => {
                        last = event.sequence;
                        let done = event.event_type == "completed";
                        if out_tx.send(Ok(event)).await.is_err() {
                            return;
                        }
                        if done {
                            return;
                        }
                    }
                    Ok(_) => {}
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
        });

        Ok(Response::new(Box::pin(ReceiverStream::new(out_rx))))
    }

    async fn send_message(
        &self,
        request: Request<SendMessageRequest>,
    ) -> Result<Response<SendMessageResponse>, Status> {
        let req = request.into_inner();
        let run_id = req
            .to
            .first()
            .cloned()
            .ok_or_else(|| Status::invalid_argument("'to' must contain the target run id"))?;
        let run = self
            .state
            .runs
            .lock()
            .unwrap()
            .get(&run_id)
            .cloned()
            .ok_or_else(|| Status::not_found(format!("unknown run '{run_id}'")))?;

        let mut guard = run.stdin.lock().await;
        match guard.as_mut() {
            Some(stdin) => {
                stdin
                    .write_all(format!("{}\n", req.body).as_bytes())
                    .await
                    .map_err(|e| Status::internal(format!("stdin write: {e}")))?;
                stdin.flush().await.ok();
            }
            None => {
                return Err(Status::failed_precondition(
                    "run stdin is closed (harness exited)",
                ))
            }
        }
        Ok(Response::new(SendMessageResponse {
            message_ids: vec![format!("msg_{}", short_id())],
        }))
    }

    async fn read_message(
        &self,
        request: Request<ReadMessageRequest>,
    ) -> Result<Response<ReadMessageResponse>, Status> {
        Ok(Response::new(ReadMessageResponse {
            message: Some(AgentMessage {
                message_id: request.into_inner().message_id,
                ..Default::default()
            }),
        }))
    }

    async fn list_messages(
        &self,
        _request: Request<ListMessagesRequest>,
    ) -> Result<Response<ListMessagesResponse>, Status> {
        Ok(Response::new(ListMessagesResponse { messages: vec![] }))
    }

    async fn report_event(
        &self,
        _request: Request<ReportEventRequest>,
    ) -> Result<Response<ReportEventResponse>, Status> {
        Ok(Response::new(ReportEventResponse { sequence: 0 }))
    }

    type ChatStream = ChatStreamBox;
    async fn chat(
        &self,
        request: Request<ChatRequest>,
    ) -> Result<Response<Self::ChatStream>, Status> {
        // Placeholder model turn (a real host would call an LLM here).
        let reply = format!(
            "You said: {}. (example completion)",
            request.into_inner().prompt
        );
        let (tx, rx) = mpsc::channel(16);
        tokio::spawn(async move {
            for token in reply.split_inclusive(' ') {
                if tx
                    .send(Ok(ChatChunk {
                        delta: token.to_string(),
                        done: false,
                    }))
                    .await
                    .is_err()
                {
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(60)).await;
            }
            let _ = tx
                .send(Ok(ChatChunk {
                    delta: String::new(),
                    done: true,
                }))
                .await;
        });
        Ok(Response::new(Box::pin(ReceiverStream::new(rx))))
    }
}

/// Demo middleware: a gRPC interceptor that checks/logs the `authorization`
/// metadata. With `REQUIRE_AUTH=1` it rejects requests lacking a Bearer token.
fn auth_interceptor(req: Request<()>) -> Result<Request<()>, Status> {
    let has_bearer = req
        .metadata()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("Bearer "));
    if has_bearer {
        Ok(req)
    } else if std::env::var("REQUIRE_AUTH").is_ok() {
        Err(Status::unauthenticated(
            "missing 'authorization: Bearer <token>' metadata",
        ))
    } else {
        tracing::warn!("request without Bearer token (set REQUIRE_AUTH=1 to enforce)");
        Ok(req)
    }
}

fn short_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    format!("{nanos:08x}")
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let state = Arc::new(AppState {
        harnesses: load_harnesses(),
        runs: Mutex::new(HashMap::new()),
    });
    let addr = std::env::var("ADDR")
        .unwrap_or_else(|_| "127.0.0.1:50061".into())
        .parse()?;
    tracing::info!(%addr, "harness host listening");

    Server::builder()
        .add_service(AgentServiceServer::with_interceptor(
            HarnessHost { state },
            auth_interceptor,
        ))
        .serve(addr)
        .await?;
    Ok(())
}
