// Compiles proto/agent.proto into Rust types + the gRPC client/server stubs.
// Requires `protoc` on PATH at build time (e.g. `brew install protobuf`, or build
// inside the fork's `devenv shell`, which provides it).
fn main() -> Result<(), Box<dyn std::error::Error>> {
    tonic_build::compile_protos("proto/agent.proto")?;
    Ok(())
}
