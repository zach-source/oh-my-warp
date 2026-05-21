# Example: gRPC harness host

A small, runnable **gRPC** (tonic) service that runs a **coding-harness CLI**
(pi-mono, Claude Code, …) as a sandboxed subprocess and exposes it over gRPC — so
a harness can run on **your cloud** and be driven from Warp via an
`AIClient`-decorator bridge. It's the **custom-backend** route from
[`../../BACKEND_INTERFACE.md`](../../BACKEND_INTERFACE.md) (the alternative to
running Warp's own cloud agents via `oz-agent-worker`).

Independent of the `warp` Cargo workspace (its `Cargo.toml` has an empty
`[workspace]` table), so it never affects the main build.

## Why this exists
A custom harness like **pi-mono** can't be a *native* Warp cloud agent
(`oz-agent-worker` only runs harnesses that Warp's `oz`/`warp-agent` knows). This
host lets you run any harness CLI yourself and bridge it into Warp.

## How it maps to Warp's agent ops
| RPC | Behaviour | Warp op (for the bridge) |
|---|---|---|
| `SpawnAgent{harness, prompt}` | launch the configured harness in a fresh workspace dir | `POST /api/v1/agent/run` |
| `StreamEvents{run_ids}` | stream the harness's stdout/stderr + `started`/`completed` | SSE `…/agent/events/stream` |
| `SendMessage{to=[run_id], body}` | write a line to the harness's stdin (follow-up input) | `POST /api/v1/agent/messages` |
| `Chat` | placeholder model turn (a real host calls an LLM) | — |

## Harnesses (`harnesses.toml`)
Each `[harness.<name>]` = a `command` + `args` (the literal `{prompt}` is
substituted). A built-in **`demo`** harness is used if no config is found, so it
runs without pi-mono/Claude installed. `pi-mono` and `claude` entries are stubs to
fill in. Model/API keys go in the process environment (e.g. a k8s Secret).

## Run
```sh
# protoc required to build (brew install protobuf, or use the fork's `devenv shell`).
cd examples/agent-grpc-backend

cargo run --bin server                 # listens on 127.0.0.1:50061 (ADDR= to override)
cargo run --bin client -- "do a task"  # in another shell; HARNESS=demo by default
HARNESS=pi-mono cargo run --bin client -- "fix the bug"   # once pi-mono is configured

REQUIRE_AUTH=1 cargo run --bin server  # enforce the Bearer-token interceptor (middleware)
```

## Deploying on your cloud
Build a container with the harness CLI(s) + this server, mount/POPULATE
`harnesses.toml`, supply model API keys via env/secrets, and run it on your
Docker/k8s host. The middleware interceptor is where you add real auth, tenant
routing, rate-limiting, and audit logging.

## Bridging into Warp
> **Detailed design + drop-in scaffold:** [`BRIDGE_SPEC.md`](BRIDGE_SPEC.md) and
> [`bridge/`](bridge/) — the `AIClient` decorator (all 41 trait methods), the
> op→RPC field mappings, the SSE event-stream gap, deps/config/auth, and phasing.

The Warp client speaks GraphQL/REST/SSE, not gRPC, so connect this one of two ways
(see `BACKEND_INTERFACE.md`):
1. **In-process `AIClient` decorator (recommended)** — implement `AIClient`
   (`app/src/server/server_api/ai.rs`) holding this crate's `AgentServiceClient`,
   translating Warp's agent ops → these RPCs; inject at `ServerApi::get_ai_client()`.
2. **Translation proxy** — speak Warp's REST/GraphQL/SSE on the front, these gRPC
   calls on the back, and point the fork's [backend selector](../../OMW.md) at it.

> Hardening notes for a real host: pass the prompt via env/stdin rather than arg
> substitution (avoid shell injection), sandbox each run (container/cgroups), cap
> concurrency, and clean up per-run workspaces.

Generated stubs live under `warp_agent_grpc::pb` once built.
