//! Example client: spawn a harness run and stream its output until it exits.
//!
//! `cargo run --bin client -- "your prompt"`  (HARNESS=demo by default; set
//! HARNESS=pi-mono / claude once configured in harnesses.toml). Run the server
//! first: `cargo run --bin server`.

use warp_agent_grpc::pb::{
    agent_service_client::AgentServiceClient, SpawnAgentRequest, StreamEventsRequest,
};

/// Attaches a demo Bearer token so the server's auth interceptor is satisfied.
fn with_auth<T>(mut req: tonic::Request<T>) -> tonic::Request<T> {
    req.metadata_mut().insert(
        "authorization",
        "Bearer example-token".parse().expect("valid metadata"),
    );
    req
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let addr = std::env::var("ADDR").unwrap_or_else(|_| "http://127.0.0.1:50061".into());
    let harness = std::env::var("HARNESS").unwrap_or_else(|_| "demo".into());
    let prompt = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "hello from the client".into());

    let mut client = AgentServiceClient::connect(addr).await?;

    let spawn = client
        .spawn_agent(with_auth(tonic::Request::new(SpawnAgentRequest {
            harness: harness.clone(),
            prompt,
            ..Default::default()
        })))
        .await?
        .into_inner();
    println!(
        "spawned {} run={} (harness={harness})",
        spawn.task_id, spawn.run_id
    );

    let mut events = client
        .stream_events(with_auth(tonic::Request::new(StreamEventsRequest {
            run_ids: vec![spawn.run_id],
            since_sequence: 0,
        })))
        .await?
        .into_inner();
    while let Some(event) = events.message().await? {
        println!("[{}] {}", event.event_type, event.text);
        if event.event_type == "completed" {
            break;
        }
    }
    Ok(())
}
