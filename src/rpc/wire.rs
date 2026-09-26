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

/// Session settings carried by `session/configure`, in both directions.
///
/// A request names only what it changes; the result echoes the whole set the
/// daemon kept. The set grew over time: `model`, `model_provider`, and
/// `temperature` exist on every supported daemon, `mode` only where the daemon
/// enforces plan mode, and the two thinking fields only where it has
/// per-session thinking controls. A daemon drops a field it does not know
/// without an error, so a requested field missing from the echo means "not
/// supported here", which [`dropped_override_fields`] reports. Enum-valued
/// fields stay strings so a value a newer daemon adds cannot fail the parse.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct SessionOverrides {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// A `<provider_type>.<alias>` reference.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    /// `build` or `plan`. Goal mode is this app's own loop and is never sent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_display: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SessionConfigureParams {
    pub session_id: String,
    pub overrides: SessionOverrides,
    /// Thinking fields to clear before the patch applies. Only daemons with
    /// thinking controls know it, so it is left out when empty.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub reset: Vec<String>,
}

/// What the session's current model accepts for reasoning depth and display,
/// and what the session has now. Empty lists mean nothing is adjustable.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ThinkingOptions {
    #[serde(default)]
    pub model_provider: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub levels: Vec<String>,
    #[serde(default)]
    pub displays: Vec<String>,
    #[serde(default)]
    pub current_level: Option<String>,
    #[serde(default)]
    pub level_source: Option<String>,
    #[serde(default)]
    pub current_display: Option<String>,
    #[serde(default)]
    pub display_source: Option<String>,
}

/// The result of `session/configure`, and of `session/thinking-options` on
/// daemons that have it. `thinking_options` is absent on daemons without
/// per-session thinking controls.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct SessionSettingsResult {
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub overrides: SessionOverrides,
    #[serde(default)]
    pub thinking_options: Option<ThinkingOptions>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct CatalogModelsResult {
    #[serde(default)]
    pub model_provider: String,
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default)]
    pub local: bool,
    #[serde(default)]
    pub live: bool,
}

/// The one `quickstart/state` field this app reads.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct QuickstartStateResult {
    /// Configured `<provider_type>.<alias>` references.
    #[serde(default)]
    pub model_providers: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ConfigFieldEntry {
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub value: Option<Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ConfigListResult {
    #[serde(default)]
    pub entries: Vec<ConfigFieldEntry>,
}

/// Wire names of the fields `requested` set that `echo` does not carry.
///
/// The daemon ignores an override field it does not know rather than refusing
/// it, so this is how the app learns that, for example, the daemon it is
/// talking to does not enforce plan mode.
pub fn dropped_override_fields(
    requested: &SessionOverrides,
    echo: &SessionOverrides,
) -> Vec<&'static str> {
    [
        ("model", requested.model.is_some(), echo.model.is_some()),
        (
            "model_provider",
            requested.model_provider.is_some(),
            echo.model_provider.is_some(),
        ),
        (
            "temperature",
            requested.temperature.is_some(),
            echo.temperature.is_some(),
        ),
        ("mode", requested.mode.is_some(), echo.mode.is_some()),
        (
            "thinking_level",
            requested.thinking_level.is_some(),
            echo.thinking_level.is_some(),
        ),
        (
            "thinking_display",
            requested.thinking_display.is_some(),
            echo.thinking_display.is_some(),
        ),
    ]
    .into_iter()
    .filter(|(_, asked, kept)| *asked && !*kept)
    .map(|(name, _, _)| name)
    .collect()
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
    pub const SESSION_CONFIGURE: &str = "session/configure";
    /// Present only on daemons with per-session thinking controls.
    pub const SESSION_THINKING_OPTIONS: &str = "session/thinking-options";
    pub const CONFIG_CATALOG_MODELS: &str = "config/catalog-models";
    pub const CONFIG_LIST: &str = "config/list";
    pub const QUICKSTART_STATE: &str = "quickstart/state";
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
    pub const INVALID_PARAMS: i64 = -32602;
    pub const INTERNAL_ERROR: i64 = -32603;
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
    fn configure_params_carry_only_the_fields_being_changed() {
        let params = SessionConfigureParams {
            session_id: "s1".into(),
            overrides: SessionOverrides {
                model: Some("claude-fable-5-1".into()),
                ..SessionOverrides::default()
            },
            reset: Vec::new(),
        };
        let value = serde_json::to_value(params).expect("serialize");
        assert_eq!(value["session_id"], "s1");
        assert_eq!(
            value["overrides"],
            serde_json::json!({"model": "claude-fable-5-1"})
        );
        // Older daemons do not know `reset`; an empty one must not be sent.
        assert!(value.get("reset").is_none());
    }

    #[test]
    fn configure_params_send_a_reset_list_when_one_is_given() {
        let params = SessionConfigureParams {
            session_id: "s1".into(),
            overrides: SessionOverrides::default(),
            reset: vec!["thinking_level".into()],
        };
        let value = serde_json::to_value(params).expect("serialize");
        assert_eq!(value["reset"], serde_json::json!(["thinking_level"]));
        assert_eq!(value["overrides"], serde_json::json!({}));
    }

    #[test]
    fn a_configure_result_from_a_daemon_without_thinking_controls_parses() {
        let parsed: SessionSettingsResult = serde_json::from_value(serde_json::json!({
            "session_id": "s1",
            "overrides": {"model": "m1", "model_provider": "anthropic.default"}
        }))
        .expect("parse");
        assert_eq!(parsed.overrides.model.as_deref(), Some("m1"));
        assert!(parsed.overrides.mode.is_none());
        assert!(parsed.thinking_options.is_none());
    }

    #[test]
    fn a_configure_result_with_thinking_options_parses() {
        let parsed: SessionSettingsResult = serde_json::from_value(serde_json::json!({
            "session_id": "s1",
            "overrides": {"model": "claude-fable-5-1", "thinking_level": "high"},
            "thinking_options": {
                "model_provider": "anthropic.default",
                "model": "claude-fable-5-1",
                "levels": ["low", "medium", "high", "xhigh", "max"],
                "displays": ["omitted", "summarized"],
                "current_level": "high",
                "level_source": "session",
                "current_display": "summarized",
                "display_source": "profile",
                "something_newer": true
            }
        }))
        .expect("parse");
        let options = parsed.thinking_options.expect("thinking options");
        assert_eq!(options.levels.len(), 5);
        assert_eq!(options.current_level.as_deref(), Some("high"));
        assert_eq!(options.display_source.as_deref(), Some("profile"));
        assert_eq!(parsed.overrides.thinking_level.as_deref(), Some("high"));
    }

    #[test]
    fn a_plan_request_echoed_without_a_mode_is_reported_as_dropped() {
        let requested = SessionOverrides {
            mode: Some("plan".into()),
            ..SessionOverrides::default()
        };
        // What a daemon without plan mode answers: the merged set, no mode.
        let echo = SessionOverrides {
            model: Some("m1".into()),
            ..SessionOverrides::default()
        };
        assert_eq!(dropped_override_fields(&requested, &echo), vec!["mode"]);

        let enforced = SessionOverrides {
            mode: Some("plan".into()),
            ..SessionOverrides::default()
        };
        assert!(dropped_override_fields(&requested, &enforced).is_empty());
    }

    #[test]
    fn thinking_fields_a_daemon_does_not_know_are_reported_as_dropped() {
        let requested = SessionOverrides {
            model: Some("m2".into()),
            thinking_level: Some("high".into()),
            thinking_display: Some("summarized".into()),
            ..SessionOverrides::default()
        };
        let echo = SessionOverrides {
            model: Some("m2".into()),
            ..SessionOverrides::default()
        };
        assert_eq!(
            dropped_override_fields(&requested, &echo),
            vec!["thinking_level", "thinking_display"]
        );
    }

    #[test]
    fn a_provider_switch_that_clears_the_model_is_not_a_dropped_field() {
        // Switching provider without naming a model clears the model override
        // daemon-side. The model was not requested, so nothing was dropped.
        let requested = SessionOverrides {
            model_provider: Some("openai.work".into()),
            ..SessionOverrides::default()
        };
        let echo = SessionOverrides {
            model_provider: Some("openai.work".into()),
            ..SessionOverrides::default()
        };
        assert!(dropped_override_fields(&requested, &echo).is_empty());
    }

    #[test]
    fn catalog_quickstart_and_config_list_ignore_fields_they_do_not_use() {
        let catalog: CatalogModelsResult = serde_json::from_value(serde_json::json!({
            "model_provider": "anthropic.default",
            "models": ["a", "b"],
            "pricing": {"a": {"input": 1.0}},
            "local": false,
            "live": true
        }))
        .expect("catalog");
        assert_eq!(catalog.models, vec!["a", "b"]);
        assert!(catalog.live);

        let quickstart: QuickstartStateResult = serde_json::from_value(serde_json::json!({
            "quickstart_completed": true,
            "agents": ["coder"],
            "model_providers": ["anthropic.default", "openai.work"],
            "channels": []
        }))
        .expect("quickstart");
        assert_eq!(quickstart.model_providers.len(), 2);

        let listed: ConfigListResult = serde_json::from_value(serde_json::json!({
            "entries": [{
                "path": "agents.coder.model_provider",
                "category": "agents",
                "kind": "string",
                "type_hint": "String",
                "value": "anthropic.default",
                "populated": true,
                "is_secret": false,
                "description": ""
            }]
        }))
        .expect("config list");
        assert_eq!(listed.entries[0].path, "agents.coder.model_provider");
        assert_eq!(
            listed.entries[0].value,
            Some(serde_json::json!("anthropic.default"))
        );
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
