//! Example gRPC agent-backend server: in-memory mock logic plus a demo auth
//! interceptor (middleware). Run with `cargo run --bin server`.

use std::pin::Pin;
use std::time::Duration;

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

#[derive(Default)]
struct ExampleAgentBackend;

#[tonic::async_trait]
impl AgentService for ExampleAgentBackend {
    async fn spawn_agent(
        &self,
        request: Request<SpawnAgentRequest>,
    ) -> Result<Response<SpawnAgentResponse>, Status> {
        let req = request.into_inner();
        tracing::info!(prompt = %req.prompt, mode = req.mode, "spawn_agent");
        Ok(Response::new(SpawnAgentResponse {
            task_id: format!("task_{}", short_id()),
            run_id: format!("run_{}", short_id()),
            at_capacity: false,
        }))
    }

    async fn send_message(
        &self,
        request: Request<SendMessageRequest>,
    ) -> Result<Response<SendMessageResponse>, Status> {
        let req = request.into_inner();
        tracing::info!(subject = %req.subject, recipients = req.to.len(), "send_message");
        let message_ids = req
            .to
            .iter()
            .map(|_| format!("msg_{}", short_id()))
            .collect();
        Ok(Response::new(SendMessageResponse { message_ids }))
    }

    async fn read_message(
        &self,
        request: Request<ReadMessageRequest>,
    ) -> Result<Response<ReadMessageResponse>, Status> {
        let message_id = request.into_inner().message_id;
        Ok(Response::new(ReadMessageResponse {
            message: Some(AgentMessage {
                message_id,
                sender_run_id: "run_example".into(),
                subject: "Re: hello".into(),
                body: "This is an example message body.".into(),
                sent_at: placeholder_timestamp(),
                read_at: placeholder_timestamp(),
            }),
        }))
    }

    async fn list_messages(
        &self,
        request: Request<ListMessagesRequest>,
    ) -> Result<Response<ListMessagesResponse>, Status> {
        let req = request.into_inner();
        let messages = vec![AgentMessage {
            message_id: format!("msg_{}", short_id()),
            sender_run_id: req.run_id,
            subject: "example".into(),
            body: "example message".into(),
            sent_at: placeholder_timestamp(),
            read_at: String::new(),
        }];
        Ok(Response::new(ListMessagesResponse { messages }))
    }

    async fn report_event(
        &self,
        request: Request<ReportEventRequest>,
    ) -> Result<Response<ReportEventResponse>, Status> {
        let req = request.into_inner();
        tracing::info!(event_type = %req.event_type, "report_event");
        Ok(Response::new(ReportEventResponse { sequence: 1 }))
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
            .unwrap_or_else(|| "run_example".into());
        let (tx, rx) = tokio::sync::mpsc::channel(8);
        tokio::spawn(async move {
            for (i, kind) in ["started", "step", "step", "completed"].iter().enumerate() {
                let event = AgentRunEvent {
                    run_id: run_id.clone(),
                    event_type: (*kind).into(),
                    ref_id: String::new(),
                    execution_id: format!("exec_{}", short_id()),
                    occurred_at: placeholder_timestamp(),
                    sequence: req.since_sequence + i as i64 + 1,
                };
                if tx.send(Ok(event)).await.is_err() {
                    break; // client disconnected
                }
                tokio::time::sleep(Duration::from_millis(400)).await;
            }
        });
        Ok(Response::new(Box::pin(ReceiverStream::new(rx))))
    }

    type ChatStream = ChatStreamBox;
    async fn chat(
        &self,
        request: Request<ChatRequest>,
    ) -> Result<Response<Self::ChatStream>, Status> {
        let req = request.into_inner();
        tracing::info!(prompt = %req.prompt, model = %req.model, "chat");
        let reply = format!("You said: {}. (example completion)", req.prompt);
        let (tx, rx) = tokio::sync::mpsc::channel(16);
        tokio::spawn(async move {
            for token in reply.split_inclusive(' ') {
                let chunk = ChatChunk {
                    delta: token.to_string(),
                    done: false,
                };
                if tx.send(Ok(chunk)).await.is_err() {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(80)).await;
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
/// metadata. With `REQUIRE_AUTH=1` it rejects requests lacking a Bearer token —
/// this is where a real backend validates its tokens (see BACKEND_INTERFACE.md
/// §3 "Authentication"). Replace with routing, rate-limiting, tenant resolution,
/// etc. as needed.
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

/// Tiny non-crypto id from the current time — fine for a mock backend.
fn short_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    format!("{nanos:08x}")
}

/// Placeholder timestamp; a real backend emits the actual RFC3339 time (e.g. via
/// the `time` or `chrono` crate).
fn placeholder_timestamp() -> String {
    "2026-05-20T12:00:00Z".to_string()
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let addr = std::env::var("ADDR")
        .unwrap_or_else(|_| "127.0.0.1:50061".into())
        .parse()?;
    tracing::info!(%addr, "example agent gRPC backend listening");

    Server::builder()
        .add_service(AgentServiceServer::with_interceptor(
            ExampleAgentBackend,
            auth_interceptor,
        ))
        .serve(addr)
        .await?;
    Ok(())
}
