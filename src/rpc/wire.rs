//! Hand-maintained mirrors of the daemon JSON-RPC shapes this app uses.
//!
//! The app is an RPC-only surface: it links no `zeroclaw-*` crate, so every
//! shape it relies on is mirrored here and validated against the daemon at
//! runtime. Only the subset the coding workspace needs is mirrored; streamed
//! `session/update` payloads are forwarded to the UI as raw JSON so an unknown
//! event type from a newer daemon is ignored rather than fatal.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Wire protocol version this client speaks. The daemon rejects a mismatch
/// with `VERSION_MISMATCH (-32011)`; it never compares package versions.
pub const PROTOCOL_VERSION: u64 = 1;

/// Oldest daemon package version this app is willing to drive. Above the
/// floor the app feature-detects from `InitializeResult::capabilities`.
pub const MIN_SERVER_VERSION: &str = "0.8.0";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct InitializeParams {
    pub protocol_version: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tui_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tui_sig: Option<String>,
    #[serde(skip_serializing_if = "HashMap::is_empty")]
    pub env: HashMap<String, String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct CommandDescriptor {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub aliases: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct InitializeResult {
    #[serde(default)]
    pub protocol_version: u64,
    #[serde(default)]
    pub server_version: String,
    #[serde(default)]
    pub server_pid: u32,
    #[serde(default)]
    pub tui_id: Option<String>,
    #[serde(default)]
    pub tui_sig: Option<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub commands: Vec<CommandDescriptor>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SessionNewParams {
    pub agent_alias: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tui_id: Option<String>,
    pub exclude_memory: bool,
    /// Always `acp` for this app: code sessions live in the ACP store and
    /// exclude persistent memory.
    pub chat_mode: &'static str,
    /// Multi-session client: manage sibling lifecycle ourselves instead of
    /// letting `session/new` evict idle same-mode siblings.
    pub keep_siblings: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct SessionNewResult {
    pub session_id: String,
    #[serde(default)]
    pub agent_alias: String,
    #[serde(default)]
    pub message_count: usize,
    #[serde(default)]
    pub workspace_dir: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct SessionEntry {
    pub session_id: String,
    #[serde(default)]
    pub session_key: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub last_activity: String,
    #[serde(default)]
    pub message_count: usize,
    #[serde(default)]
    pub agent_alias: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    /// Present only on daemons carrying the D2 listing fields. Absent on
    /// older daemons, which is why it is optional rather than defaulted.
    #[serde(default)]
    pub workspace_dir: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct SessionListResult {
    #[serde(default)]
    pub sessions: Vec<SessionEntry>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageEntryKind {
    #[default]
    Message,
    ToolCall,
    ToolResult,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct MessageEntry {
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub kind: MessageEntryKind,
    #[serde(default)]
    pub tool_call_id: Option<String>,
    #[serde(default)]
    pub tool_name: Option<String>,
    #[serde(default)]
    pub tool_input: Option<Value>,
    #[serde(default)]
    pub tool_output: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct SessionMessagesResult {
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub messages: Vec<MessageEntry>,
    #[serde(default)]
    pub total: usize,
    #[serde(default)]
    pub start: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct SessionStateResult {
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub turn_id: Option<String>,
    #[serde(default)]
    pub plan: Option<Vec<Value>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct SessionGitBranchResult {
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub hash: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AgentEntry {
    pub alias: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub channels: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AgentsListResult {
    #[serde(default)]
    pub agents: Vec<AgentEntry>,
}

/// `session/approve` decisions the daemon accepts. `RejectWithEdit` carries a
/// `replacement` alongside it and is not wired into the first release.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalDecision {
    AllowOnce,
    AllowAlways,
    Reject,
    RejectWithEdit,
}

impl ApprovalDecision {
    pub fn wire(self) -> &'static str {
        match self {
            Self::AllowOnce => "allow_once",
            Self::AllowAlways => "allow_always",
            Self::Reject => "reject",
            Self::RejectWithEdit => "reject_with_edit",
        }
    }
}

/// Method names used by this app. Every one is checked against
/// `InitializeResult::capabilities` before the UI offers the feature.
pub mod method {
    pub const INITIALIZE: &str = "initialize";
    pub const AGENTS_LIST: &str = "agents/list";
    pub const SESSION_NEW: &str = "session/new";
    pub const SESSION_PROMPT: &str = "session/prompt";
    pub const SESSION_CANCEL: &str = "session/cancel";
    pub const SESSION_APPROVE: &str = "session/approve";
    pub const SESSION_CLOSE: &str = "session/close";
    pub const SESSION_LIST_ACP: &str = "session/list-acp";
    pub const SESSION_MESSAGES: &str = "session/messages";
    pub const SESSION_STATE: &str = "session/state";
    pub const SESSION_GIT_BRANCH: &str = "session/git_branch";
    pub const FS_LIST_DIR: &str = "fs/list_dir";
}

/// JSON-RPC error codes the daemon defines beyond the standard set.
pub mod error_code {
    pub const SESSION_NOT_FOUND: i64 = -32000;
    pub const SESSION_LIMIT_REACHED: i64 = -32001;
    pub const SESSION_BUSY: i64 = -32002;
    pub const SESSION_NOT_OWNED: i64 = -32003;
    pub const AUTH_REQUIRED: i64 = -32010;
    pub const VERSION_MISMATCH: i64 = -32011;
    pub const METHOD_NOT_FOUND: i64 = -32601;
}

/// Compare dotted numeric versions. Returns true when `have` is at least
/// `floor`. A version that does not parse is treated as acceptable so a
/// pre-release or git build is never locked out.
pub fn version_at_least(have: &str, floor: &str) -> bool {
    fn parts(v: &str) -> Option<(u64, u64, u64)> {
        let core = v.split(['-', '+']).next().unwrap_or(v);
        let mut it = core.split('.');
        let major = it.next()?.parse().ok()?;
        let minor = it.next().unwrap_or("0").parse().ok()?;
        let patch = it.next().unwrap_or("0").parse().ok()?;
        Some((major, minor, patch))
    }
    match (parts(have), parts(floor)) {
        (Some(h), Some(f)) => h >= f,
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_new_params_match_the_daemon_acp_contract() {
        let params = SessionNewParams {
            agent_alias: "coder".into(),
            cwd: Some("/repo".into()),
            session_id: None,
            tui_id: Some("tui_abc".into()),
            exclude_memory: true,
            chat_mode: "acp",
            keep_siblings: true,
        };
        let value = serde_json::to_value(params).expect("serialize");
        assert_eq!(value["agent_alias"], "coder");
        assert_eq!(value["cwd"], "/repo");
        assert_eq!(value["chat_mode"], "acp");
        assert_eq!(value["exclude_memory"], true);
        assert_eq!(value["keep_siblings"], true);
        assert_eq!(value["tui_id"], "tui_abc");
        // A fresh session must not claim an interaction surface: the enum is
        // closed daemon-side, so an unknown value would be rejected outright
        // and a claimed row could not be resumed from ZeroCode.
        assert!(value.get("interaction_surface").is_none());
        assert!(value.get("session_id").is_none());
    }

    #[test]
    fn resume_params_omit_cwd_so_the_daemon_keeps_the_persisted_workspace() {
        let params = SessionNewParams {
            agent_alias: "coder".into(),
            cwd: None,
            session_id: Some("abc-123".into()),
            tui_id: None,
            exclude_memory: true,
            chat_mode: "acp",
            keep_siblings: true,
        };
        let value = serde_json::to_value(params).expect("serialize");
        assert_eq!(value["session_id"], "abc-123");
        assert!(value.get("cwd").is_none());
    }

    #[test]
    fn initialize_result_tolerates_a_daemon_that_omits_optional_fields() {
        let parsed: InitializeResult = serde_json::from_value(serde_json::json!({
            "protocol_version": 1,
            "server_version": "0.8.5",
            "server_pid": 4242
        }))
        .expect("parse");
        assert_eq!(parsed.protocol_version, 1);
        assert_eq!(parsed.server_pid, 4242);
        assert!(parsed.tui_id.is_none());
        assert!(parsed.capabilities.is_empty());
    }

    #[test]
    fn approval_decisions_use_the_daemon_wire_spelling() {
        assert_eq!(ApprovalDecision::AllowOnce.wire(), "allow_once");
        assert_eq!(ApprovalDecision::AllowAlways.wire(), "allow_always");
        assert_eq!(ApprovalDecision::Reject.wire(), "reject");
        assert_eq!(ApprovalDecision::RejectWithEdit.wire(), "reject_with_edit");
    }

    #[test]
    fn version_floor_accepts_newer_and_unparseable_versions() {
        assert!(version_at_least("0.8.5", "0.8.0"));
        assert!(version_at_least("0.9.0", "0.8.0"));
        assert!(version_at_least("1.0.0", "0.8.0"));
        assert!(!version_at_least("0.7.9", "0.8.0"));
        assert!(version_at_least("0.8.6-dev", "0.8.0"));
        assert!(version_at_least("git-build", "0.8.0"));
    }
}
