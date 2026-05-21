# Bridge scaffold (drop-in for the fork)

`aiclient_bridge.rs` is a **template**, not part of this example crate's build — it
references Warp's own types, so it's kept outside `src/` (cargo won't compile it
here). It's the in-process **`AIClient` decorator** that routes Warp's agent ops to
the [gRPC harness host](../README.md).

See **[`../BRIDGE_SPEC.md`](../BRIDGE_SPEC.md)** for the full design (method
inventory, field mappings, the SSE event-stream gap, deps, config, auth, phasing).

## To use it in the fork
1. Add deps + vendor the proto (BRIDGE_SPEC.md §6): `tonic = "0.14"` (matches the
   workspace's prost 0.14) in the workspace + `app/Cargo.toml`; `tonic-build` build-dep;
   copy `../proto/agent.proto`; `tonic_build::compile_protos(...)` in `app/build.rs`.
2. Copy `aiclient_bridge.rs` → `app/src/server/agent_bridge.rs`; declare `mod agent_bridge;`.
3. Resolve imports (swap the `ai::*` glob for explicit `use`s) and verify the forward
   signatures against the trait — `cargo check -p warp --lib`.
4. Wire it at `ServerApi::get_ai_client()` (BRIDGE_SPEC.md §4) and implement
   `agent_bridge::config()` to read the selected backend from `agent_backends.toml`.
5. Close the event-stream gap (BRIDGE_SPEC.md §5) for live agent output.

Because it modifies upstream files, land it as an `omw` patch (`./omw apply` first),
not on pristine `master`.
