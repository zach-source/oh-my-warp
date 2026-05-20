# Warp Backend Interface

This documents the **wire contract a server must implement to act as a Warp backend** — i.e. what sits behind `ChannelState::server_root_url()` and the websocket URL. It's what the [oh-my-warp backend selector](OMW.md) points at: `agent_backends.toml` + the *Settings → Features → "Default backend"* dropdown just swap these URLs (`crate::util::agent_backends`), so a custom backend must speak this protocol.

> Reverse-engineered from the **client** code (the source of truth, cited inline). There is no published server spec in this repo; track the cited files when implementing.

---

## 1. Endpoints & configuration

A backend is defined by four values (`WarpServerConfig`, `crates/warp_core/src/channel/config.rs:30-52`), with production defaults:

| Config | Default | Purpose |
|---|---|---|
| `server_root_url` | `https://app.warp.dev` | REST (`/api/v1/…`) + GraphQL (`/graphql/v2`) |
| `rtc_server_url` | `wss://rtc.app.warp.dev/graphql/v2` | Real-time websocket (graphql-ws) + base for the SSE host |
| `session_sharing_server_url` | `wss://sessions.app.warp.dev` | Optional session-sharing websocket |
| `firebase_auth_api_key` | *(public Firebase key)* | Token refresh via Firebase Identity Toolkit |

Read at runtime via `ChannelState::server_root_url()` / `ws_server_url()` / `firebase_api_key()` and overridden by `override_server_root_url()` / `override_ws_server_url()` (`crates/warp_core/src/channel/state.rs:85-110, 210-271`). The SSE host is **derived** from the ws URL by `ChannelState::rtc_http_url()` (`state.rs:236-247`): `wss://…` → `https://…`, path stripped (falls back to `server_root_url`).

(Oz/ambient agents add `oz_root_url` + a workload-identity `workload_audience_url`, `config.rs:54-72`.)

---

## 2. Transports

| Transport | Where | Contract |
|---|---|---|
| **GraphQL** | `crates/graphql/src/client.rs:87-109` | `POST {server_root_url}/graphql/v2?op={OperationName}`, JSON body (`cynic` operation), `Authorization: Bearer …`, optional extra headers |
| **REST ("public API")** | `app/src/server/server_api.rs` (`{base}/api/v1/{path}` at `:724` GET, `:852` POST, `:954` PATCH) | JSON request/response; bearer + ambient headers attached |
| **SSE** | `app/src/server/server_api.rs:771-802` | `GET {rtc_http_url}/api/v1/agent/events/stream?run_ids[]=…&since={seq}` → `text/event-stream` |
| **Websocket / RTC** | `crates/websocket/` (`into_graphql_client_builder`, `lib.rs:131`) | `graphql-ws` subprotocol over `rtc_server_url` (GraphQL subscriptions for real-time updates) |

---

## 3. Authentication

All authenticated requests carry `Authorization: Bearer {access_token}` (`server_api.rs` `bearer_auth(token)`). The token is obtained/refreshed via (`app/src/server/server_api/auth.rs`):

- **Firebase Identity Toolkit** (primary): the client holds `{ id_token, refresh_token, expiration_time }` and refreshes ~5 min before expiry using `firebase_auth_api_key`. A backend may instead accept its own bearer tokens.
- **Token proxy / OAuth**: `POST {server_root_url}/api/v1/oauth/token` (form-encoded `grant_type=refresh_token&refresh_token=…`) is used as a refresh proxy (`server_api.rs:563-578`).
- **OAuth device flow** (headless CLI/SDK, client id `warp-cli`): `…/api/v1/oauth/device/auth` then `…/api/v1/oauth/token`.

A minimal custom backend can ignore Firebase and simply **validate `Authorization: Bearer <token>`** on every endpoint, issuing tokens however it likes (your `oauth/token` can mint them).

---

## 4. Agent API surface

Defined by the `AIClient` trait + its `ServerApi` impl (`app/src/server/server_api/ai.rs`) — the source of truth for exact request/response structs.

| Operation | Method · path | Request → Response (structs in `ai.rs`) |
|---|---|---|
| Spawn run | `POST /api/v1/agent/run` | `SpawnAgentRequest` → `SpawnAgentResponse { task_id, run_id, at_capacity }` |
| Create task | `POST /graphql/v2?op=CreateAgentTask` | `CreateAgentTaskInput` → `{ task_id }` |
| Update task | `POST /graphql/v2?op=UpdateAgentTask` | `UpdateAgentTaskInput { task_id, task_state, … }` → `{}` |
| Send message | `POST /api/v1/agent/messages` | `SendAgentMessageRequest { to, subject, body, sender_run_id }` → `{ message_ids }` |
| List messages | `GET /api/v1/agent/messages/{run_id}?limit=&unread=&since=` | → `Vec<AgentMessageHeader>` |
| Read message | `POST /api/v1/agent/messages/{message_id}/read` | `()` → `ReadAgentMessageResponse` (incl. body) |
| Report event | `POST /api/v1/agent/events/{run_id}` | `ReportAgentEventRequest` → `{ sequence }` |
| Stream events | `GET {rtc_http_url}/api/v1/agent/events/stream?run_ids[]=&since=` (SSE) | → stream of `AgentRunEvent` |

The "remote agent" flow: spawn/create → stream events (SSE) → on a `new_message` event, hydrate via *read message*. (Pipeline: `app/src/ai/agent_sdk/ambient.rs`, `app/src/ai/blocklist/action_model/execute/send_message.rs`.)

> Field-level shapes vary and evolve — read the structs in `ai.rs` rather than treating the JSON above as canonical.

---

## 5. Headers

| Header | When | Source |
|---|---|---|
| `Authorization: Bearer …` | all authenticated requests | `server_api.rs` `bearer_auth` |
| ambient workload token | running as a cloud agent | `ambient_agent_headers()`, `server_api.rs:531-561` |
| cloud agent id | when a task id is set | same |
| agent source (`CLI`, `GITHUB_ACTION`, …) | set at startup | same |

Header **name constants** live in `app/src/server/server_api*` — use those as the source of truth.

---

## 6. Minimal drop-in backend checklist

To serve as a Warp backend you (at minimum) implement, at your host:

1. **Auth** — accept `Authorization: Bearer <token>`; expose `POST /api/v1/oauth/token` to mint/refresh tokens.
2. **GraphQL** — `POST /graphql/v2?op=…` for the queries/mutations the client sends (incl. `CreateAgentTask`, `UpdateAgentTask`). The client uses a generated `cynic` schema; mismatches will fail deserialization.
3. **Agent REST** — the `/api/v1/agent/*` endpoints in §4.
4. **SSE** — `GET /api/v1/agent/events/stream` on the `rtc_http_url` host.
5. **Websocket** (optional, for live Drive/updates) — `graphql-ws` at `rtc_server_url`.

The two big efforts are matching the **GraphQL schema** (`crates/warp_graphql_schema/`) and the **auth** handshake; the agent REST surface is small and self-contained. The narrowest in-process alternative (skip reimplementing the server) is decorating the `AIClient` trait — see [OMW.md](OMW.md) / the agent-extension notes.

---

## 7. Where to verify / extend (source of truth)

- Config/URLs: `crates/warp_core/src/channel/{config,state}.rs`
- GraphQL transport: `crates/graphql/src/client.rs`; schema: `crates/warp_graphql_schema/`
- REST + SSE + auth + headers: `app/src/server/server_api.rs`, `app/src/server/server_api/{ai,auth}.rs`
- Websocket: `crates/websocket/`
- Backend selector (this fork): `app/src/util/agent_backends.rs`, `app/src/settings_view/features/agent_backend.rs`
