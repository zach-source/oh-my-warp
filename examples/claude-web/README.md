# Example: local web app wrapping Claude Code

A tiny **runnable** web app that wraps the **Claude Code** CLI: type a prompt in the
browser and watch the agent's text and tool calls stream in **live**. It's the
smallest end-to-end example of *wrapping a coding-harness CLI as a service* — the
same idea as [`../agent-grpc-backend`](../agent-grpc-backend), but local, visual, and
over plain HTTP/SSE instead of gRPC.

Independent of the `warp` Cargo workspace (empty `[workspace]` table), so it never
affects the main build.

## How it works
```
browser ──GET /run?prompt=…──▶ axum server ──spawn──▶ claude -p … --output-format stream-json
   ▲                                  │
   └──────── SSE events ──────────────┘   (parses Claude's JSON stream → typed page events)
```
The server runs `claude --print <prompt> --output-format stream-json --verbose`, parses
Claude Code's newline-delimited JSON (system/assistant/user/result), and re-emits it to
the page as **Server-Sent Events** — the *same SSE transport* Warp's own agent UI consumes
(see [`../../BACKEND_INTERFACE.md`](../../BACKEND_INTERFACE.md)). Page events: `session`,
`text`, `tool_use`, `tool_result`, `result`, `stderr`, `error`, `done`.

Follow-ups reuse the conversation: the page keeps the `session_id` from the first event and
sends it back, so the server adds `--resume <id>` for multi-turn.

## Run
```sh
# Needs Claude Code installed and on PATH (`claude --version`).
# On macOS, build inside the fork's devenv so the nix linker resolves (libiconv):
cd /path/to/warp
devenv shell -- bash -lc 'cd examples/claude-web && cargo run'
# …or just `cargo run` from this dir if your toolchain links cleanly.

# then open the printed URL:
open http://127.0.0.1:8787
```

## Env knobs
| Var | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | listen port |
| `CLAUDE_MAX_BUDGET_USD` | `1.00` | per-run spend cap (`off`/`0` disables) — see note |
| `CLAUDE_PERMISSION_MODE` | *(config)* | `plan` \| `acceptEdits` \| `bypassPermissions` \| `default` \| `dontAsk` \| `auto` |
| `CLAUDE_SKIP_PERMISSIONS` | — | `1` adds `--dangerously-skip-permissions` (**sandboxes only**) |
| `CLAUDE_WORKDIR` | server cwd | directory Claude runs in |

> **Budget note:** the cap maps to `claude --max-budget-usd`. If a run exceeds it, the
> final `result` event has `is_error: true` and the process exits non-zero — Claude still
> streams whatever it produced first. Opus runs carry per-call overhead (system prompt +
> tool definitions), so a trivial reply can cost ~$0.20; raise the cap for real tasks.

## Permissions / safety
By default Claude uses your configured permissions; tool calls that aren't pre-approved are
denied (not hung) in `--print` mode. To let it actually edit/run things, set a
`CLAUDE_PERMISSION_MODE` or `CLAUDE_SKIP_PERMISSIONS=1` — **only in a directory/sandbox you
trust**, since it then acts on `CLAUDE_WORKDIR`. The prompt is passed as a direct `execve`
argument (no shell), so there's no shell-injection surface.

## How this maps back to Warp
This is the "wrap a harness CLI" half of the agent-backend work, made tangible:
- **The CLI wrap** (spawn `claude`, parse `stream-json`) is exactly what the gRPC harness
  host's `claude` entry does in [`../agent-grpc-backend/harnesses.toml`](../agent-grpc-backend/harnesses.toml).
- **The SSE event shape** is what Warp's agent UI subscribes to — see the event-stream
  discussion in [`../agent-grpc-backend/BRIDGE_SPEC.md`](../agent-grpc-backend/BRIDGE_SPEC.md) §5
  (the host-served SSE that closes the bridge's event gap looks just like this `/run` endpoint).

So: run this to *see* a wrapped Claude Code locally; use the gRPC host + bridge spec to put
the same pattern behind Warp's native agent panel.
