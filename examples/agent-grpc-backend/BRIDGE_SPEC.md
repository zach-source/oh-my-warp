# Bridge spec: Warp `AIClient` → gRPC harness host

How to route Warp's agent operations to the [gRPC harness host](README.md) so a
custom harness (e.g. pi-mono) running on your cloud is driven from Warp. Companion
to [`../../BACKEND_INTERFACE.md`](../../BACKEND_INTERFACE.md). Signatures below are
from `app/src/server/server_api/ai.rs` and `app/src/server/server_api.rs`.

---

## 1. The seam — and one important gap

Warp's agent control-plane is the **`AIClient` trait** (`ai.rs:874`, `#[async_trait]`,
41 methods). It's handed out by **one** function:

```rust
// app/src/server/server_api.rs:1526
pub fn get_ai_client(&self) -> Arc<dyn AIClient> {
    self.server_api.clone()
}
```

So a **decorator** that wraps `Arc<dyn AIClient>` and overrides the agent ops,
injected here, redirects the control plane in-process — without your host having
to reimplement Warp's REST/GraphQL/auth.

⚠️ **The decorator alone is not a complete bridge.** It redirects the trait's
request/response ops, but the live **event stream** is off-trait, and the events it
carries are only *notifications* whose content is fetched by yet more calls. §5
explains **why** in full and **how to close the gap** — read it before implementing.

Two mechanisms exist; this spec uses **(A)** + a targeted bit of **(B)**:
- **(A) `AIClient` decorator** — in-process, redirects the 9 control ops to gRPC. Light.
- **(B) backend selector** (`agent_backends.toml`, already built) — overrides `server_root_url`/`ws_url` so *all* HTTP/SSE/GraphQL hit your host. Heavy (host must implement the whole [backend interface](../../BACKEND_INTERFACE.md)), but it's how you redirect the SSE stream.

---

## 2. Methods: override vs forward

**Override (9)** — route to the gRPC host:

| `AIClient` method | gRPC RPC |
|---|---|
| `spawn_agent(SpawnAgentRequest) -> SpawnAgentResponse` | `SpawnAgent` |
| `create_agent_task(prompt, env_uid, parent_run_id, config) -> AmbientAgentTaskId` | `SpawnAgent` (or a Create RPC) |
| `update_agent_task(task_id, state, session_id, conv_id, status) -> ()` | (host task state) |
| `send_agent_message(SendAgentMessageRequest) -> SendAgentMessageResponse` | `SendMessage` |
| `read_agent_message(message_id) -> ReadAgentMessageResponse` | `ReadMessage` |
| `list_agent_messages(run_id, ListAgentMessagesRequest) -> Vec<AgentMessageHeader>` | `ListMessages` |
| `report_agent_event(run_id, ReportAgentEventRequest) -> ReportAgentEventResponse` | `ReportEvent` |
| `update_event_sequence_on_server(run_id, seq) -> ()` | (host bookkeeping) |
| `mark_message_delivered(message_id) -> ()` | (host bookkeeping) |

**Forward (32)** — delegate verbatim to the inner client (these stay on Warp):
`generate_commands_from_natural_language`, `generate_dialogue_answer`,
`generate_metadata_for_command`, `get_request_limit_info`, `get_feature_model_choices`,
`get_available_harnesses`, `list_connected_self_hosted_workers`, `get_free_available_models`,
`update_merkle_tree`, `generate_code_embeddings`,
`provide_negative_feedback_response_for_ai_conversation`, `upload_local_handoff_snapshot`,
`fork_conversation`, `list_ambient_agent_tasks`, `list_agent_runs_raw`, `get_ambient_agent_task`,
`get_agent_run_raw`, `submit_run_followup`, `get_scheduled_agent_history`, `get_ai_conversation`,
`list_ai_conversation_metadata`, `get_ai_conversation_format`, `get_block_snapshot`,
`delete_ai_conversation`, `list_agents`, `cancel_ambient_agent_task`, `get_task_git_credentials`,
`get_task_attachments`, `create_file_artifact_upload_target`, `confirm_file_artifact_upload`,
`get_artifact_download`, `prepare_attachments_for_upload`, `download_task_attachments`,
`get_handoff_snapshot_attachments`, `get_public_conversation`, `get_run_conversation`,
`generate_code_review_content`.

> Tip: a decorator must implement *every* method (no defaults). Forwarders are
> mechanical one-liners (`self.inner.<m>(args).await`); generate them once.

> ⚠️ **Not all "forwards" are safe to forward.** Several are **run/task-scoped**
> reads — `get_run_conversation`, `get_agent_run_raw`, `get_ambient_agent_task`,
> `cancel_ambient_agent_task`, `submit_run_followup`, `get_run_conversation`,
> `get_task_attachments`, `get_handoff_snapshot_attachments`. For a run that lives
> on **your host**, these must route to the host, not Warp (which has no such run).
> The override/forward split is really "**by run ownership**," not by method name — see §5.

---

## 3. Field mapping (key ops)

`SpawnAgentRequest` (`ai.rs:205`) → `pb::SpawnAgentRequest`:
`prompt→prompt`, `mode (UserQueryMode)→mode`, `title→title`, `conversation_id→conversation_id`,
`parent_run_id→parent_run_id`, **+ `harness`** = your configured harness name (the bridge
sets this, e.g. `"pi-mono"`, from config). Response `task_id`/`run_id`/`at_capacity` map back
1:1 (note Warp's `task_id` is `AmbientAgentTaskId` — wrap the host's string id).

`SendAgentMessageRequest{to, subject, body, sender_run_id}` (`ai.rs:315`) →
`pb::SendMessageRequest` (drives the harness's stdin). `read_agent_message(message_id)` →
`pb::ReadMessageRequest`; map `pb` reply → `ReadAgentMessageResponse`. `report_agent_event` →
`pb::ReportEventRequest`/`Response{sequence}`.

---

## 4. Decorator (code)

Deps (workspace has prost 0.14, **no tonic**): add `tonic = "0.14"` (prost-0.14 compatible)
to the workspace + `app/Cargo.toml`, vendor `proto/agent.proto`, and codegen with
`tonic-build` (or commit the generated module). See §6.

```rust
// app/src/server/agent_bridge.rs  (new module; behind a config gate)
use std::sync::Arc;
use async_trait::async_trait;
use crate::server::server_api::ai::{AIClient, SpawnAgentRequest, SpawnAgentResponse, /* … */};

pub mod pb { tonic::include_proto!("agent.v1"); }
use pb::agent_service_client::AgentServiceClient;

pub struct GrpcBridgeAIClient {
    inner: Arc<dyn AIClient>,         // the real Warp client (forward target)
    endpoint: String,                 // your host, e.g. "http://harness-host:50061"
    token: String,                    // bearer for the host's auth interceptor
    harness: String,                  // which harness to spawn, e.g. "pi-mono"
}

impl GrpcBridgeAIClient {
    async fn grpc(&self) -> anyhow::Result<AgentServiceClient<tonic::transport::Channel>> {
        let ch = tonic::transport::Channel::from_shared(self.endpoint.clone())?.connect().await?;
        Ok(AgentServiceClient::new(ch))
    }
    fn auth<T>(&self, mut r: tonic::Request<T>) -> tonic::Request<T> {
        r.metadata_mut().insert("authorization",
            format!("Bearer {}", self.token).parse().unwrap());
        r
    }
}

#[cfg_attr(not(target_family = "wasm"), async_trait)]
#[cfg_attr(target_family = "wasm", async_trait(?Send))]
impl AIClient for GrpcBridgeAIClient {
    // ── OVERRIDE: route to the gRPC host ──
    async fn spawn_agent(&self, req: SpawnAgentRequest) -> anyhow::Result<SpawnAgentResponse> {
        let mut c = self.grpc().await?;
        let resp = c.spawn_agent(self.auth(tonic::Request::new(pb::SpawnAgentRequest {
            prompt: req.prompt,
            harness: self.harness.clone(),
            title: req.title.unwrap_or_default(),
            conversation_id: req.conversation_id.unwrap_or_default(),
            parent_run_id: req.parent_run_id.unwrap_or_default(),
            ..Default::default()
        }))).await?.into_inner();
        Ok(SpawnAgentResponse {
            task_id: resp.task_id.into(),   // wrap into AmbientAgentTaskId
            run_id: resp.run_id,
            at_capacity: resp.at_capacity,
        })
    }
    async fn send_agent_message(&self, req: SendAgentMessageRequest)
        -> anyhow::Result<SendAgentMessageResponse> {
        let mut c = self.grpc().await?;
        let resp = c.send_message(self.auth(tonic::Request::new(pb::SendMessageRequest {
            to: req.to, subject: req.subject, body: req.body, sender_run_id: req.sender_run_id,
        }))).await?.into_inner();
        Ok(SendAgentMessageResponse { message_ids: resp.message_ids })
    }
    // … the other 7 overrides follow the same shape …

    // ── FORWARD: delegate to Warp (32 methods, mechanical) ──
    async fn get_feature_model_choices(&self) -> anyhow::Result<ModelsByFeature> {
        self.inner.get_feature_model_choices().await
    }
    // … repeat for the remaining 31 forward methods …
}
```

Injection (gate it so default behavior is unchanged):

```rust
// app/src/server/server_api.rs — get_ai_client()
pub fn get_ai_client(&self) -> Arc<dyn AIClient> {
    let inner: Arc<dyn AIClient> = self.server_api.clone();
    match crate::server::agent_bridge::config() {        // reads agent_backends.toml / env
        Some(cfg) => Arc::new(crate::server::agent_bridge::GrpcBridgeAIClient::new(inner, cfg)),
        None => inner,
    }
}
```

---

## 5. Why the decorator isn't enough — and how to fill the gap

Spawning a run through the decorator sends `spawn_agent` to your host, but the agent's
output never reaches the UI. **Two independent reasons**, then the fix.

### 5a. Why — reason 1: the event stream is off-trait
The agent UI doesn't poll for output; it opens a long-lived **SSE subscription** keyed by
`run_id`. That subscription is created by **`ServerApi::stream_agent_events`** (`server_api.rs:771`),
a method on the **concrete `ServerApi`** — it dials `rtc_http_url()` directly and is **not part of
the `AIClient` trait**. A decorator only implements trait methods, so this call goes straight
through it, untouched. Net effect of the decorator alone: `spawn_agent` lands on your host, but
the UI subscribes to **Warp's** SSE for that `run_id` — where the run doesn't exist — so **no
events ever render** (or the subscription errors). The control plane and the event plane have
been split across two backends.

### 5b. Why — reason 2: events are notifications, not content
Even with the stream redirected, you're not done. Warp's `AgentRunEvent` (`ai.rs:345`) is a thin
**envelope** — `event_type`, `run_id`, `ref_id`, `execution_id`, `occurred_at`, `sequence`. There is
**no message/output text in it.** It says *"something of type X happened at sequence N, see ref R."*
The client reacts by **fetching the content** with separate, **run-scoped** calls
(`get_run_conversation`, `read_agent_message`, `list_agent_messages`, `get_agent_run_raw`, …).
Some of those are in the decorator's override set (good), but others are in the *forward* set
(§2 callout) — so for a host-owned run they'd be fetched from Warp, which has nothing. **The
content reads must follow the run to its backend, or the UI shows empty events.**

The real rule: **every operation scoped to a `run_id`/`task_id` must target the backend that
owns that run** — spawn, the SSE subscription, *and* every subsequent read.

### 5c. How to fill the gap
Three pieces; do all three:

1. **Redirect the SSE subscription to your host.** Use the backend selector's WS/RTC override
   (`override_ws_server_url(...)`) so `rtc_http_url()` resolves to your host. Have the host serve
   `GET /api/v1/agent/events/stream?run_ids[]=…&since=…` as SSE, **translating gRPC `StreamEvents`
   → Warp `AgentRunEvent` JSON frames** (same envelope fields; honor `since`/`sequence` for replay
   and dedup — your host already tracks per-run sequence). This is the smallest seam that closes 5a;
   you don't have to patch the concrete `stream_agent_events`.
   *(Alternative if you'd rather not run an HTTP endpoint: patch `ServerApi::stream_agent_events`
   to adapt the gRPC `StreamEvents` into the `EventSourceStream` it returns — more invasive, touches
   upstream code, but keeps everything in-process.)*
2. **Serve the run-scoped content reads from your host.** Either route them through the decorator
   (move the run-scoped "forward" methods from §2 into host-routed overrides) **or** serve their
   REST equivalents on the host behind the same URL override. This closes 5b.
3. **Decide ownership routing** — see the two modes below; this determines *which* runs steps 1–2
   apply to.

### 5d. Two deployment modes (pick one)
- **Host-owns-all-runs (recommended, simplest).** All agent runs live on your host. Route **every
  run/task-scoped op + the SSE** to the host; keep only the **non-run AI features** on Warp
  (command generation, dialogue, embeddings, model lists, request limits). No per-call decision
  logic — the split is static, so the decorator stays simple and you can't get a half-Warp/half-host
  run. Best fit for "I want my harness to be the agent backend."
- **Hybrid (runs on both backends).** Some runs on Warp, some on your host. The decorator must keep
  a **`run_id → backend` registry** (populated at `spawn_agent`) and dispatch each run-scoped call by
  it, and the SSE layer must **multiplex** both backends' streams. More moving parts; only worth it
  if you genuinely need both live at once.

**Bottom line:** decorator (control ops) **+** host-served SSE (5c.1) **+** host-served run-scoped
reads (5c.2), under **host-owns-all-runs** routing (5d), is the complete, lowest-friction bridge.
The decorator is necessary but ~⅓ of the work; the event/content plane is the rest.

---

## 6. Deps, proto, config, auth

- **Cargo**: add `tonic = "0.14"` (matches workspace prost 0.14) to the workspace + `app`; add
  `tonic-build` as a build-dep; vendor `agent.proto`; `tonic_build::compile_protos` in `app/build.rs`
  (or commit generated code to avoid a protoc build dependency in the app crate).
- **Config**: reuse `agent_backends.toml` — add the gRPC endpoint + token + harness to the selected
  backend entry (e.g. `grpc_endpoint`, `grpc_token`, `harness`), and have `agent_bridge::config()`
  read them. The decorator activates only when a gRPC backend is selected.
- **Auth**: send `authorization: Bearer <token>` (the host's interceptor checks it). Map the host's
  run ids ↔ Warp's `AmbientAgentTaskId`/`run_id` (the bridge owns this mapping).

---

## 7. Phasing & testing
1. Land a **passthrough decorator** (all 41 methods forward to inner; injected behind the gate, off by default) → proves the seam, zero behavior change. (`cargo check -p warp --lib`.)
2. Wire the **gRPC client + the 9 overrides** → control ops hit the host. Test against
   `examples/agent-grpc-backend` (server) with the `demo` harness. (Control plane only — the UI
   still won't render output until step 3; verify with logs/gRPC, not the agent panel.)
3. Close the **event/content gap (§5c)**: host-served SSE + run-scoped reads, under host-owns-all-runs
   routing → live events actually render. **This is what makes the bridge usable, not step 2.**
4. Configure **pi-mono** in `harnesses.toml`, point the backend at your cloud host, deploy.

## 8. Honest caveats
- 41-method forwarding is bulky (mechanical, but real).
- **The decorator is ~⅓ of the bridge** (§5): the off-trait SSE stream (5a) and the
  notification-vs-content split (5b) mean live output needs host-served SSE + run-scoped reads (5c).
- Routing is **by run ownership, not method name** — run/task-scoped reads must follow the run to its
  backend; "host-owns-all-runs" (5d) avoids per-call routing logic.
- `task_id`/`run_id` semantics differ between Warp and a custom host — the bridge must own the id mapping and lifecycle.
- Hard to fully runtime-verify without a full build + a running host + driving the agent UI.
