//! Example client that smoke-tests the agent gRPC backend: spawn a run, send a
//! message, stream events, and stream a chat completion. Run with
//! `cargo run --bin client` (after starting `cargo run --bin server`).

use std::io::Write;

use warp_agent_grpc::pb::{
    agent_service_client::AgentServiceClient, AgentMode, ChatRequest, SendMessageRequest,
    SpawnAgentRequest, StreamEventsRequest,
};

/// Attaches a demo Bearer token to a request so the server's auth interceptor is
/// satisfied (a real client would use a token from your auth flow).
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
    let mut client = AgentServiceClient::connect(addr).await?;

    // 1) Spawn a run.
    let spawn = client
        .spawn_agent(with_auth(tonic::Request::new(SpawnAgentRequest {
            prompt: "Summarize the repo".into(),
            mode: AgentMode::Normal as i32,
            title: "demo".into(),
            conversation_id: String::new(),
            parent_run_id: String::new(),
        })))
        .await?
        .into_inner();
    println!(
        "spawn_agent  -> task={} run={}",
        spawn.task_id, spawn.run_id
    );

    // 2) Send a message to the run.
    let send = client
        .send_message(with_auth(tonic::Request::new(SendMessageRequest {
            to: vec![spawn.run_id.clone()],
            subject: "hi".into(),
            body: "hello agent".into(),
            sender_run_id: "client".into(),
        })))
        .await?
        .into_inner();
    println!("send_message -> ids={:?}", send.message_ids);

    // 3) Stream run events until the stream closes.
    let mut events = client
        .stream_events(with_auth(tonic::Request::new(StreamEventsRequest {
            run_ids: vec![spawn.run_id.clone()],
            since_sequence: 0,
        })))
        .await?
        .into_inner();
    while let Some(event) = events.message().await? {
        println!("event #{:<2} -> {}", event.sequence, event.event_type);
    }

    // 4) Stream a chat completion.
    print!("chat         -> ");
    std::io::stdout().flush().ok();
    let mut chat = client
        .chat(with_auth(tonic::Request::new(ChatRequest {
            run_id: spawn.run_id,
            prompt: "Hello".into(),
            model: "example".into(),
        })))
        .await?
        .into_inner();
    while let Some(chunk) = chat.message().await? {
        if chunk.done {
            break;
        }
        print!("{}", chunk.delta);
        std::io::stdout().flush().ok();
    }
    println!();

    Ok(())
}
