//! SCAFFOLD / TEMPLATE — not compiled by this example crate (it lives outside
//! `src/` because it references Warp's own types). Drop it into the fork as
//! `app/src/server/agent_bridge.rs`, add the deps/proto from BRIDGE_SPEC.md §6,
//! resolve imports, and wire it at `ServerApi::get_ai_client()`.
//!
//! `GrpcBridgeAIClient` decorates `Arc<dyn AIClient>`: it FORWARDS the 32
//! non-agent methods to the real Warp client, and OVERRIDES the 9 agent
//! control/messaging ops to call the gRPC harness host. See BRIDGE_SPEC.md for
//! the design, the field mappings, and the SSE-stream gap (handled separately).

use async_trait::async_trait;
use std::sync::Arc;

// Bring the trait + every request/response type into scope. When you drop this
// into the fork, prefer explicit imports; the glob keeps the template short.
use crate::server::server_api::ai::*;

// Generated from proto/agent.proto (vendor it into the fork; see §6).
pub mod pb {
    tonic::include_proto!("agent.v1");
}
use pb::agent_service_client::AgentServiceClient;

/// Config for the bridge — populate from the selected `agent_backends.toml` entry.
#[derive(Clone, Debug)]
pub struct BridgeConfig {
    pub endpoint: String, // e.g. "http://harness-host:50061"
    pub token: String,    // bearer for the host's auth interceptor
    pub harness: String,  // which harness to spawn, e.g. "pi-mono"
}

/// Returns `Some(cfg)` when a gRPC backend is selected, else `None` (→ no bridge).
/// TODO: read this from the backend selector (`util::agent_backends`) / env.
pub fn config() -> Option<BridgeConfig> {
    None
}

pub struct GrpcBridgeAIClient {
    inner: Arc<dyn AIClient>,
    cfg: BridgeConfig,
}

impl GrpcBridgeAIClient {
    pub fn new(inner: Arc<dyn AIClient>, cfg: BridgeConfig) -> Self {
        Self { inner, cfg }
    }

    async fn grpc(&self) -> anyhow::Result<AgentServiceClient<tonic::transport::Channel>> {
        let ch = tonic::transport::Channel::from_shared(self.cfg.endpoint.clone())?
            .connect()
            .await?;
        Ok(AgentServiceClient::new(ch))
    }

    fn auth<T>(&self, mut req: tonic::Request<T>) -> tonic::Request<T> {
        req.metadata_mut().insert(
            "authorization",
            format!("Bearer {}", self.cfg.token)
                .parse()
                .expect("valid token"),
        );
        req
    }
}

#[cfg_attr(not(target_family = "wasm"), async_trait)]
#[cfg_attr(target_family = "wasm", async_trait(?Send))]
impl AIClient for GrpcBridgeAIClient {
    // ───────────────────────── OVERRIDE (9): route to the gRPC host ───────────

    async fn spawn_agent(&self, req: SpawnAgentRequest) -> anyhow::Result<SpawnAgentResponse> {
        let mut c = self.grpc().await?;
        let resp = c
            .spawn_agent(self.auth(tonic::Request::new(pb::SpawnAgentRequest {
                prompt: req.prompt,
                harness: self.cfg.harness.clone(),
                title: req.title.unwrap_or_default(),
                conversation_id: req.conversation_id.unwrap_or_default(),
                parent_run_id: req.parent_run_id.unwrap_or_default(),
                ..Default::default()
            })))
            .await?
            .into_inner();
        Ok(SpawnAgentResponse {
            task_id: resp.task_id.into(), // wrap into AmbientAgentTaskId
            run_id: resp.run_id,
            at_capacity: resp.at_capacity,
        })
    }

    async fn send_agent_message(
        &self,
        req: SendAgentMessageRequest,
    ) -> anyhow::Result<SendAgentMessageResponse> {
        let mut c = self.grpc().await?;
        let resp = c
            .send_message(self.auth(tonic::Request::new(pb::SendMessageRequest {
                to: req.to,
                subject: req.subject,
                body: req.body,
                sender_run_id: req.sender_run_id,
            })))
            .await?
            .into_inner();
        Ok(SendAgentMessageResponse {
            message_ids: resp.message_ids,
        })
    }

    async fn read_agent_message(
        &self,
        message_id: &str,
    ) -> anyhow::Result<ReadAgentMessageResponse> {
        let mut c = self.grpc().await?;
        let m = c
            .read_message(self.auth(tonic::Request::new(pb::ReadMessageRequest {
                message_id: message_id.to_string(),
            })))
            .await?
            .into_inner();
        Ok(ReadAgentMessageResponse {
            message_id: m.message_id,
            sender_run_id: m.sender_run_id,
            subject: m.subject,
            body: m.body,
            sent_at: m.sent_at,
            delivered_at: (!m.delivered_at.is_empty()).then_some(m.delivered_at),
            read_at: (!m.read_at.is_empty()).then_some(m.read_at),
        })
    }

    async fn list_agent_messages(
        &self,
        run_id: &str,
        _request: ListAgentMessagesRequest,
    ) -> anyhow::Result<Vec<AgentMessageHeader>> {
        let mut c = self.grpc().await?;
        let resp = c
            .list_messages(self.auth(tonic::Request::new(pb::ListMessagesRequest {
                run_id: run_id.to_string(),
            })))
            .await?
            .into_inner();
        Ok(resp
            .messages
            .into_iter()
            .map(|h| AgentMessageHeader {
                message_id: h.message_id,
                sender_run_id: h.sender_run_id,
                subject: h.subject,
                sent_at: h.sent_at,
                delivered_at: (!h.delivered_at.is_empty()).then_some(h.delivered_at),
                read_at: (!h.read_at.is_empty()).then_some(h.read_at),
            })
            .collect())
    }

    async fn report_agent_event(
        &self,
        run_id: &str,
        request: ReportAgentEventRequest,
    ) -> anyhow::Result<ReportAgentEventResponse> {
        let mut c = self.grpc().await?;
        let resp = c
            .report_event(self.auth(tonic::Request::new(pb::ReportEventRequest {
                run_id: run_id.to_string(),
                event_type: request.event_type,
                execution_id: request.execution_id.unwrap_or_default(),
                ref_id: request.ref_id.unwrap_or_default(),
            })))
            .await?
            .into_inner();
        Ok(ReportAgentEventResponse {
            sequence: resp.sequence,
        })
    }

    // The remaining 4 agent ops are bookkeeping/task-state. Map them to host RPCs
    // when your host models them; until then forwarding to Warp is a safe default.
    // TODO: route to the host once SpawnAgent/task-state RPCs exist for these.
    async fn create_agent_task(
        &self,
        prompt: String,
        environment_uid: Option<String>,
        parent_run_id: Option<String>,
        config: Option<AgentConfigSnapshot>,
    ) -> anyhow::Result<AmbientAgentTaskId> {
        self.inner
            .create_agent_task(prompt, environment_uid, parent_run_id, config)
            .await
    }
    async fn update_agent_task(
        &self,
        task_id: AmbientAgentTaskId,
        task_state: Option<AgentTaskState>,
        session_id: Option<session_sharing_protocol::common::SessionId>,
        conversation_id: Option<String>,
        status_message: Option<TaskStatusUpdate>,
    ) -> anyhow::Result<()> {
        self.inner
            .update_agent_task(
                task_id,
                task_state,
                session_id,
                conversation_id,
                status_message,
            )
            .await
    }
    async fn update_event_sequence_on_server(
        &self,
        run_id: &str,
        sequence: i64,
    ) -> anyhow::Result<()> {
        self.inner
            .update_event_sequence_on_server(run_id, sequence)
            .await
    }
    async fn mark_message_delivered(&self, message_id: &str) -> anyhow::Result<()> {
        self.inner.mark_message_delivered(message_id).await
    }

    // ───────────────────────── FORWARD (32): delegate to Warp ─────────────────
    // Mechanical one-liners. Verify signatures against the trait when you drop in.
    //
    // ⚠️ NOT all of these are safe to forward (see BRIDGE_SPEC.md §5b). These are
    // RUN/TASK-SCOPED reads — for a run that lives on your host, Warp has no such
    // run, so forwarding returns nothing and the UI shows empty events. Route them
    // to the host (or its REST equivalents) under "host-owns-all-runs":
    //   get_run_conversation, get_agent_run_raw, get_ambient_agent_task,
    //   cancel_ambient_agent_task, submit_run_followup,
    //   get_task_attachments, get_handoff_snapshot_attachments,
    //   prepare_attachments_for_upload, download_task_attachments.
    // They forward here only as a starting point; flip them as you build the host.

    async fn generate_commands_from_natural_language(
        &self,
        prompt: String,
        ai_execution_context: Option<WarpAiExecutionContext>,
    ) -> Result<Vec<AIGeneratedCommand>, GenerateCommandsFromNaturalLanguageError> {
        self.inner
            .generate_commands_from_natural_language(prompt, ai_execution_context)
            .await
    }
    async fn generate_dialogue_answer(
        &self,
        transcript: Vec<TranscriptPart>,
        prompt: String,
        ai_execution_context: Option<WarpAiExecutionContext>,
    ) -> anyhow::Result<GenerateDialogueResult> {
        self.inner
            .generate_dialogue_answer(transcript, prompt, ai_execution_context)
            .await
    }
    async fn generate_metadata_for_command(
        &self,
        command: String,
    ) -> Result<GeneratedCommandMetadata, GeneratedCommandMetadataError> {
        self.inner.generate_metadata_for_command(command).await
    }
    async fn get_request_limit_info(&self) -> anyhow::Result<RequestUsageInfo> {
        self.inner.get_request_limit_info().await
    }
    async fn get_feature_model_choices(&self) -> anyhow::Result<ModelsByFeature> {
        self.inner.get_feature_model_choices().await
    }
    async fn get_available_harnesses(&self) -> anyhow::Result<Vec<HarnessAvailability>> {
        self.inner.get_available_harnesses().await
    }
    async fn list_connected_self_hosted_workers(
        &self,
    ) -> anyhow::Result<ListConnectedSelfHostedWorkersResponse> {
        self.inner.list_connected_self_hosted_workers().await
    }
    async fn get_free_available_models(
        &self,
        referrer: Option<String>,
    ) -> anyhow::Result<ModelsByFeature> {
        self.inner.get_free_available_models(referrer).await
    }
    async fn update_merkle_tree(
        &self,
        embedding_config: EmbeddingConfig,
        nodes: Vec<IntermediateNode>,
    ) -> anyhow::Result<std::collections::HashMap<NodeHash, bool>> {
        self.inner.update_merkle_tree(embedding_config, nodes).await
    }
    async fn generate_code_embeddings(
        &self,
        embedding_config: EmbeddingConfig,
        fragments: Vec<full_source_code_embedding::Fragment>,
        root_hash: NodeHash,
        repo_metadata: RepoMetadata,
    ) -> anyhow::Result<std::collections::HashMap<ContentHash, bool>> {
        self.inner
            .generate_code_embeddings(embedding_config, fragments, root_hash, repo_metadata)
            .await
    }
    async fn provide_negative_feedback_response_for_ai_conversation(
        &self,
        conversation_id: String,
        request_ids: Vec<String>,
    ) -> anyhow::Result<i32> {
        self.inner
            .provide_negative_feedback_response_for_ai_conversation(conversation_id, request_ids)
            .await
    }
    async fn upload_local_handoff_snapshot(
        &self,
        request: UploadLocalHandoffSnapshotRequest,
    ) -> anyhow::Result<UploadLocalHandoffSnapshotResponse> {
        self.inner.upload_local_handoff_snapshot(request).await
    }
    async fn fork_conversation(
        &self,
        conversation_id: String,
        title: Option<String>,
    ) -> anyhow::Result<ForkConversationResponse> {
        self.inner.fork_conversation(conversation_id, title).await
    }
    async fn list_ambient_agent_tasks(
        &self,
        limit: i32,
        filter: TaskListFilter,
    ) -> anyhow::Result<Vec<AmbientAgentTask>> {
        self.inner.list_ambient_agent_tasks(limit, filter).await
    }
    async fn list_agent_runs_raw(
        &self,
        limit: i32,
        filter: TaskListFilter,
    ) -> anyhow::Result<serde_json::Value> {
        self.inner.list_agent_runs_raw(limit, filter).await
    }
    async fn get_ambient_agent_task(
        &self,
        task_id: &AmbientAgentTaskId,
    ) -> anyhow::Result<AmbientAgentTask> {
        self.inner.get_ambient_agent_task(task_id).await
    }
    async fn get_agent_run_raw(
        &self,
        task_id: &AmbientAgentTaskId,
    ) -> anyhow::Result<serde_json::Value> {
        self.inner.get_agent_run_raw(task_id).await
    }
    async fn submit_run_followup(
        &self,
        run_id: &AmbientAgentTaskId,
        request: RunFollowupRequest,
    ) -> anyhow::Result<()> {
        self.inner.submit_run_followup(run_id, request).await
    }
    async fn get_scheduled_agent_history(
        &self,
        schedule_id: &str,
    ) -> anyhow::Result<ScheduledAgentHistory> {
        self.inner.get_scheduled_agent_history(schedule_id).await
    }
    async fn get_ai_conversation(
        &self,
        server_conversation_token: ServerConversationToken,
    ) -> anyhow::Result<(ConversationData, ServerAIConversationMetadata)> {
        self.inner
            .get_ai_conversation(server_conversation_token)
            .await
    }
    async fn list_ai_conversation_metadata(
        &self,
        conversation_ids: Option<Vec<String>>,
    ) -> anyhow::Result<Vec<ServerAIConversationMetadata>> {
        self.inner
            .list_ai_conversation_metadata(conversation_ids)
            .await
    }
    async fn get_ai_conversation_format(
        &self,
        server_conversation_token: ServerConversationToken,
    ) -> anyhow::Result<AIAgentConversationFormat> {
        self.inner
            .get_ai_conversation_format(server_conversation_token)
            .await
    }
    async fn get_block_snapshot(
        &self,
        server_conversation_token: ServerConversationToken,
    ) -> anyhow::Result<SerializedBlock> {
        self.inner
            .get_block_snapshot(server_conversation_token)
            .await
    }
    async fn delete_ai_conversation(
        &self,
        server_conversation_token: String,
    ) -> anyhow::Result<()> {
        self.inner
            .delete_ai_conversation(server_conversation_token)
            .await
    }
    async fn list_agents(&self, repo: Option<String>) -> anyhow::Result<Vec<AgentListItem>> {
        self.inner.list_agents(repo).await
    }
    async fn cancel_ambient_agent_task(&self, task_id: &AmbientAgentTaskId) -> anyhow::Result<()> {
        self.inner.cancel_ambient_agent_task(task_id).await
    }
    async fn get_task_git_credentials(
        &self,
        task_id: String,
        workload_token: String,
    ) -> anyhow::Result<Vec<GitCredential>> {
        self.inner
            .get_task_git_credentials(task_id, workload_token)
            .await
    }
    async fn get_task_attachments(&self, task_id: String) -> anyhow::Result<Vec<TaskAttachment>> {
        self.inner.get_task_attachments(task_id).await
    }
    async fn create_file_artifact_upload_target(
        &self,
        request: CreateFileArtifactUploadRequest,
    ) -> anyhow::Result<CreateFileArtifactUploadResponse> {
        self.inner.create_file_artifact_upload_target(request).await
    }
    async fn confirm_file_artifact_upload(
        &self,
        artifact_uid: String,
        checksum: String,
    ) -> anyhow::Result<FileArtifactRecord> {
        self.inner
            .confirm_file_artifact_upload(artifact_uid, checksum)
            .await
    }
    async fn get_artifact_download(
        &self,
        artifact_uid: &str,
    ) -> anyhow::Result<ArtifactDownloadResponse> {
        self.inner.get_artifact_download(artifact_uid).await
    }
    async fn prepare_attachments_for_upload(
        &self,
        task_id: &AmbientAgentTaskId,
        files: &[AttachmentFileInfo],
    ) -> anyhow::Result<PrepareAttachmentUploadsResponse> {
        self.inner
            .prepare_attachments_for_upload(task_id, files)
            .await
    }
    async fn download_task_attachments(
        &self,
        task_id: &AmbientAgentTaskId,
        attachment_ids: &[String],
    ) -> anyhow::Result<DownloadAttachmentsResponse> {
        self.inner
            .download_task_attachments(task_id, attachment_ids)
            .await
    }
    async fn get_handoff_snapshot_attachments(
        &self,
        task_id: &AmbientAgentTaskId,
    ) -> anyhow::Result<Vec<TaskAttachment>> {
        self.inner.get_handoff_snapshot_attachments(task_id).await
    }
    async fn get_public_conversation(
        &self,
        conversation_id: &str,
    ) -> anyhow::Result<serde_json::Value> {
        self.inner.get_public_conversation(conversation_id).await
    }
    async fn get_run_conversation(&self, run_id: &str) -> anyhow::Result<serde_json::Value> {
        self.inner.get_run_conversation(run_id).await
    }
    async fn generate_code_review_content(
        &self,
        request: GenerateCodeReviewContentRequest,
    ) -> Result<GenerateCodeReviewContentResponse, anyhow::Error> {
        self.inner.generate_code_review_content(request).await
    }
}
