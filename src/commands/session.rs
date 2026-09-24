//! Commands for the coding session itself.
//!
//! Every one of these is a thin projection of a daemon RPC. The daemon owns
//! agent execution, tool approval, and the authoritative transcript; this app
//! only asks and renders.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::State;

use crate::rpc::wire::{
    ApprovalDecision, MessageEntry, SessionEntry, SessionGitBranchResult, SessionListResult,
    SessionMessagesResult, SessionNewParams, SessionNewResult, SessionStateResult, method,
};
use crate::state::AppState;

/// A persisted code session as the rail shows it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub session_id: String,
    pub agent_alias: Option<String>,
    pub workspace_dir: Option<String>,
    pub last_activity: String,
    pub message_count: usize,
    pub name: Option<String>,
}

impl From<SessionEntry> for SessionSummary {
    fn from(entry: SessionEntry) -> Self {
        Self {
            session_id: entry.session_id,
            agent_alias: entry.agent_alias,
            workspace_dir: entry.workspace_dir,
            last_activity: entry.last_activity,
            message_count: entry.message_count,
            name: entry.name,
        }
    }
}

/// Persisted ACP (code) sessions, newest first.
#[tauri::command]
pub async fn session_list(state: State<'_, AppState>) -> Result<Vec<SessionSummary>, String> {
    let client = state.client().await.map_err(|e| e.user_message())?;
    if !client.supports(method::SESSION_LIST_ACP) {
        return Ok(Vec::new());
    }
    let value = client
        .request(method::SESSION_LIST_ACP, json!({}))
        .await
        .map_err(|e| e.user_message())?;
    let parsed: SessionListResult = serde_json::from_value(value).map_err(|e| e.to_string())?;
    let mut sessions: Vec<SessionSummary> = parsed
        .sessions
        .into_iter()
        .map(SessionSummary::from)
        .collect();
    sessions.sort_by(|a, b| b.last_activity.cmp(&a.last_activity));
    Ok(sessions)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    pub agent_alias: String,
    /// Absolute workspace path. Sent only for a fresh session; on a resume it
    /// is omitted so the daemon keeps the session's persisted workspace.
    pub cwd: Option<String>,
    /// Present to resume an existing session.
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedSession {
    pub session_id: String,
    pub agent_alias: String,
    pub workspace_dir: String,
    pub message_count: usize,
    pub messages: Vec<MessageEntry>,
    pub branch: Option<String>,
    pub hash: Option<String>,
    /// `running` when a turn is in flight, otherwise `idle`.
    pub state: String,
    /// The live TodoWrite plan, replayed by the daemon on resume.
    pub plan: Option<Vec<Value>>,
}

/// Create or resume a code session and hand back everything the window needs
/// to render it.
#[tauri::command]
pub async fn session_open(
    state: State<'_, AppState>,
    request: OpenRequest,
) -> Result<OpenedSession, String> {
    let client = state.client().await.map_err(|e| e.user_message())?;
    let resuming = request.session_id.is_some();

    let params = SessionNewParams {
        agent_alias: request.agent_alias.clone(),
        // A resume must not carry a cwd: the daemon resolves the persisted
        // workspace, then the agent's configured workspace, in that order.
        cwd: if resuming { None } else { request.cwd.clone() },
        session_id: request.session_id.clone(),
        tui_id: client.tui_id(),
        exclude_memory: true,
        chat_mode: "acp",
        keep_siblings: true,
    };
    let value = serde_json::to_value(params).map_err(|e| e.to_string())?;
    let created: SessionNewResult = serde_json::from_value(
        client
            .request(method::SESSION_NEW, value)
            .await
            .map_err(|e| e.user_message())?,
    )
    .map_err(|e| e.to_string())?;

    let session_id = created.session_id.clone();

    // Replay the transcript. A resume that cannot load its history is an
    // error, not an empty transcript: showing nothing would look like data
    // loss to the user.
    let mut messages = Vec::new();
    if client.supports(method::SESSION_MESSAGES) && created.message_count > 0 {
        let loaded = client
            .request(
                method::SESSION_MESSAGES,
                json!({ "session_id": session_id }),
            )
            .await
            .map_err(|e| e.user_message())?;
        let parsed: SessionMessagesResult =
            serde_json::from_value(loaded).map_err(|e| e.to_string())?;
        messages = parsed.messages;
    }

    let (branch, hash) = git_branch_inner(&client, &session_id).await;
    let (live_state, plan) = session_state_inner(&client, &session_id).await;

    Ok(OpenedSession {
        session_id,
        agent_alias: created.agent_alias,
        workspace_dir: created.workspace_dir,
        message_count: created.message_count,
        messages,
        branch,
        hash,
        state: live_state,
        plan,
    })
}

/// Send a prompt. This is a notification, not a request: the daemon always
/// spawns the turn and `turn_complete` is the only authority on how it ended.
#[tauri::command]
pub async fn session_prompt(
    state: State<'_, AppState>,
    session_id: String,
    prompt: String,
    generation: u64,
) -> Result<(), String> {
    let client = state.client().await.map_err(|e| e.user_message())?;
    client
        .notify(
            method::SESSION_PROMPT,
            json!({
                "session_id": session_id,
                "prompt": prompt,
                "client_turn_generation": generation,
            }),
        )
        .map_err(|e| e.user_message())
}

/// Cancel the in-flight turn. The UI stays in a cancelling state until
/// `turn_complete` arrives; the daemon allows the turn a short grace period
/// to commit partial work before aborting it.
#[tauri::command]
pub async fn session_cancel(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let client = state.client().await.map_err(|e| e.user_message())?;
    client
        .request(method::SESSION_CANCEL, json!({ "session_id": session_id }))
        .await
        .map(|_| ())
        .map_err(|e| e.user_message())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApproveRequest {
    pub session_id: String,
    pub request_id: String,
    pub decision: ApprovalDecision,
    pub replacement: Option<String>,
}

/// Answer a tool-approval request. The daemon denies by policy when no answer
/// arrives before its timeout, so a late click is harmless but ineffective.
#[tauri::command]
pub async fn session_approve(
    state: State<'_, AppState>,
    request: ApproveRequest,
) -> Result<bool, String> {
    let client = state.client().await.map_err(|e| e.user_message())?;
    let mut params = json!({
        "session_id": request.session_id,
        "request_id": request.request_id,
        "decision": request.decision.wire(),
    });
    if let Some(replacement) = request.replacement {
        params["replacement"] = Value::String(replacement);
    }
    let value = client
        .request(method::SESSION_APPROVE, params)
        .await
        .map_err(|e| e.user_message())?;
    Ok(value
        .get("acknowledged")
        .and_then(Value::as_bool)
        .unwrap_or(false))
}

/// Close the live session. The transcript stays on the daemon and the session
/// can be resumed later.
#[tauri::command]
pub async fn session_close(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let client = state.client().await.map_err(|e| e.user_message())?;
    client
        .request(method::SESSION_CLOSE, json!({ "session_id": session_id }))
        .await
        .map(|_| ())
        .map_err(|e| e.user_message())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveState {
    pub state: String,
    pub plan: Option<Vec<Value>>,
}

/// Read live session state. Used to decide whether a session is already busy
/// with another client, and to recover after a reconnect.
#[tauri::command]
pub async fn session_state(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<LiveState, String> {
    let client = state.client().await.map_err(|e| e.user_message())?;
    let (live_state, plan) = session_state_inner(&client, &session_id).await;
    Ok(LiveState {
        state: live_state,
        plan,
    })
}

/// Replay a session's transcript, for reconnect recovery.
#[tauri::command]
pub async fn session_messages(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<MessageEntry>, String> {
    let client = state.client().await.map_err(|e| e.user_message())?;
    let value = client
        .request(
            method::SESSION_MESSAGES,
            json!({ "session_id": session_id }),
        )
        .await
        .map_err(|e| e.user_message())?;
    let parsed: SessionMessagesResult = serde_json::from_value(value).map_err(|e| e.to_string())?;
    Ok(parsed.messages)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    pub branch: Option<String>,
    pub hash: Option<String>,
}

/// Branch and short hash for the session's workspace, read by the daemon.
#[tauri::command]
pub async fn git_branch(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<GitBranch, String> {
    let client = state.client().await.map_err(|e| e.user_message())?;
    let (branch, hash) = git_branch_inner(&client, &session_id).await;
    Ok(GitBranch { branch, hash })
}

/// Branch lookup never fails the caller: a workspace outside a repository is
/// an ordinary state, not an error.
async fn git_branch_inner(
    client: &crate::rpc::client::DaemonClient,
    session_id: &str,
) -> (Option<String>, Option<String>) {
    if !client.supports(method::SESSION_GIT_BRANCH) {
        return (None, None);
    }
    match client
        .request(
            method::SESSION_GIT_BRANCH,
            json!({ "session_id": session_id }),
        )
        .await
    {
        Ok(value) => match serde_json::from_value::<SessionGitBranchResult>(value) {
            Ok(parsed) => (parsed.branch, parsed.hash),
            Err(_) => (None, None),
        },
        Err(_) => (None, None),
    }
}

/// Live state lookup degrades to `idle` rather than failing the open.
async fn session_state_inner(
    client: &crate::rpc::client::DaemonClient,
    session_id: &str,
) -> (String, Option<Vec<Value>>) {
    if !client.supports(method::SESSION_STATE) {
        return ("idle".into(), None);
    }
    match client
        .request(method::SESSION_STATE, json!({ "session_id": session_id }))
        .await
    {
        Ok(value) => match serde_json::from_value::<SessionStateResult>(value) {
            Ok(parsed) => (parsed.state, parsed.plan),
            Err(_) => ("idle".into(), None),
        },
        Err(_) => ("idle".into(), None),
    }
}
