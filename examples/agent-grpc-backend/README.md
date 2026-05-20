# Example: gRPC agent backend

A small, runnable **gRPC** (tonic) service that re-expresses Warp's agent operations as a clean RPC API. It's a **reference/foundation** for building a custom agent backend or middleware for this fork — *not* a drop-in Warp server (Warp speaks GraphQL + REST + SSE; see [`../../BACKEND_INTERFACE.md`](../../BACKEND_INTERFACE.md)). To put a gRPC backend behind Warp you bridge the two — see [Bridging into Warp](#bridging-into-warp).

This crate is **independent of the `warp` Cargo workspace** (its `Cargo.toml` has an empty `[workspace]` table), so it never affects the main build.

## Layout
- `proto/agent.proto` — the `AgentService` definition.
- `src/bin/server.rs` — server with in-memory mock logic + a demo **auth interceptor (middleware)**.
- `src/bin/client.rs` — smoke-test client (spawn → send → stream events → chat).
- `build.rs` — compiles the proto via `tonic-build` (needs `protoc`).

## Run
```sh
# protoc is required to build (brew install protobuf, or run inside the fork's `devenv shell`).
cd examples/agent-grpc-backend

cargo run --bin server          # listens on 127.0.0.1:50061 (override with ADDR=)
cargo run --bin client          # in another shell: drives the RPCs

REQUIRE_AUTH=1 cargo run --bin server   # enforce the Bearer-token interceptor
```

## RPC ↔ Warp mapping
Each RPC mirrors an operation from `BACKEND_INTERFACE.md` §4:

| gRPC RPC | Warp equivalent |
|---|---|
| `SpawnAgent` | `POST /api/v1/agent/run` |
| `SendMessage` | `POST /api/v1/agent/messages` |
| `ReadMessage` | `POST /api/v1/agent/messages/{id}/read` |
| `ListMessages` | `GET /api/v1/agent/messages/{run_id}` |
| `ReportEvent` | `POST /api/v1/agent/events/{run_id}` |
| `StreamEvents` (server-streaming) | SSE `GET /api/v1/agent/events/stream` |
| `Chat` (server-streaming) | *(model turn — no single REST equivalent)* |

## Middleware
`auth_interceptor` in `server.rs` is a tonic interceptor that runs on every request — the natural place for **auth, routing, rate-limiting, tenant resolution, or logging**. It checks `authorization: Bearer …` metadata and (with `REQUIRE_AUTH=1`) rejects requests without it. The client attaches a demo token via `with_auth(...)`.

## Bridging into Warp
The Warp client doesn't speak gRPC, so connect this backend one of two ways (both noted in `BACKEND_INTERFACE.md`):

1. **In-process decorator (recommended).** Implement the `AIClient` trait (`app/src/server/server_api/ai.rs`) with a wrapper that holds an `AgentServiceClient` (this crate's generated client) and translates Warp agent calls → these RPCs. Inject it at `ServerApi::get_ai_client()`. Lets agent traffic use this backend while the rest of Warp stays on Warp's server.
2. **Translation proxy.** Run a process that speaks Warp's REST/GraphQL/SSE on the front and these gRPC calls on the back, then point the fork's [backend selector](../../OMW.md) (`agent_backends.toml` / Settings → Features → "Default backend") at it.

Generated Rust stubs (`AgentServiceClient`, message types) live under `warp_agent_grpc::pb` once built.
