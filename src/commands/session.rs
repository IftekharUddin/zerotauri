//! Commands for the coding session itself.
//!
//! Every one of these is a thin projection of a daemon RPC. The daemon owns
//! agent execution, tool approval, and the authoritative transcript; this app
//! only asks and renders.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::State;

use super::RpcFailure;
use crate::rpc::client::DaemonClient;
use crate::rpc::wire::{
    ApprovalDecision, CatalogModelsResult, ConfigListResult, MessageEntry, QuickstartStateResult,
    SessionConfigureParams, SessionEntry, SessionGitBranchResult, SessionListResult,
    SessionMessagesResult, SessionNewParams, SessionNewResult, SessionOverrides,
    SessionSettingsResult, SessionStateResult, ThinkingOptions, dropped_override_fields,
    error_code, method,
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
    // loss to the user. A resume always asks: the daemon counts a session's
    // messages with a try-lock on its agent, so a session with a turn in
    // flight reports zero even when it has a long history.
    let mut messages = Vec::new();
    if client.supports(method::SESSION_MESSAGES) && (resuming || created.message_count > 0) {
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

/// Session settings as the webview sees them: [`SessionOverrides`] with the
/// IPC's camelCase names. `None` is an unset field in both directions.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Overrides {
    pub model: Option<String>,
    pub model_provider: Option<String>,
    pub temperature: Option<f64>,
    pub mode: Option<String>,
    pub thinking_level: Option<String>,
    pub thinking_display: Option<String>,
}

impl From<Overrides> for SessionOverrides {
    fn from(o: Overrides) -> Self {
        Self {
            model: o.model,
            model_provider: o.model_provider,
            temperature: o.temperature,
            mode: o.mode,
            thinking_level: o.thinking_level,
            thinking_display: o.thinking_display,
        }
    }
}

impl From<SessionOverrides> for Overrides {
    fn from(o: SessionOverrides) -> Self {
        Self {
            model: o.model,
            model_provider: o.model_provider,
            temperature: o.temperature,
            mode: o.mode,
            thinking_level: o.thinking_level,
            thinking_display: o.thinking_display,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThinkingReport {
    pub model_provider: String,
    pub model: String,
    pub levels: Vec<String>,
    pub displays: Vec<String>,
    pub current_level: Option<String>,
    pub level_source: Option<String>,
    pub current_display: Option<String>,
    pub display_source: Option<String>,
}

impl From<ThinkingOptions> for ThinkingReport {
    fn from(o: ThinkingOptions) -> Self {
        Self {
            model_provider: o.model_provider,
            model: o.model,
            levels: o.levels,
            displays: o.displays,
            current_level: o.current_level,
            level_source: o.level_source,
            current_display: o.current_display,
            display_source: o.display_source,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigureRequest {
    pub session_id: String,
    #[serde(default)]
    pub overrides: Overrides,
    /// Thinking fields to clear first. Only daemons with thinking controls
    /// accept it; the UI sends it only to those.
    #[serde(default)]
    pub reset: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Configured {
    pub session_id: String,
    /// The merged set the daemon kept, not just what was sent.
    pub overrides: Overrides,
    pub thinking_options: Option<ThinkingReport>,
    /// Wire names of requested fields the daemon ignored because it does not
    /// know them. `mode` here means the daemon does not enforce plan mode.
    pub dropped_fields: Vec<String>,
}

/// Change this session's settings. The daemon keeps them in memory only, so
/// they last until the daemon restarts or drops the session.
#[tauri::command]
pub async fn session_configure(
    state: State<'_, AppState>,
    request: ConfigureRequest,
) -> Result<Configured, RpcFailure> {
    let client = state.client().await?;
    if !client.supports(method::SESSION_CONFIGURE) {
        return Err(RpcFailure::local(
            error_code::METHOD_NOT_FOUND,
            "This daemon cannot change session settings.",
        ));
    }
    let requested: SessionOverrides = request.overrides.into();
    validate_overrides(&requested).map_err(|m| RpcFailure::local(error_code::INVALID_PARAMS, m))?;
    validate_reset(&request.reset).map_err(|m| RpcFailure::local(error_code::INVALID_PARAMS, m))?;
    let params = SessionConfigureParams {
        session_id: request.session_id.clone(),
        overrides: requested.clone(),
        reset: request.reset,
    };
    let value = serde_json::to_value(params)
        .map_err(|e| RpcFailure::local(error_code::INTERNAL_ERROR, e.to_string()))?;
    let echoed = client.request(method::SESSION_CONFIGURE, value).await?;
    let result: SessionSettingsResult = serde_json::from_value(echoed)
        .map_err(|e| RpcFailure::local(error_code::INTERNAL_ERROR, e.to_string()))?;

    let dropped_fields = dropped_override_fields(&requested, &result.overrides)
        .into_iter()
        .map(str::to_owned)
        .collect();
    Ok(Configured {
        session_id: if result.session_id.is_empty() {
            request.session_id
        } else {
            result.session_id
        },
        overrides: result.overrides.into(),
        thinking_options: result.thinking_options.map(Into::into),
        dropped_fields,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSettings {
    pub overrides: Overrides,
    pub thinking_options: Option<ThinkingReport>,
}

/// The session's current settings and what its model accepts for thinking.
/// `None` on a daemon without per-session thinking controls, which is also
/// the only daemon that has no read-only way to report its overrides.
#[tauri::command]
pub async fn session_thinking_options(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Option<SessionSettings>, RpcFailure> {
    let client = state.client().await?;
    if !client.supports(method::SESSION_THINKING_OPTIONS) {
        return Ok(None);
    }
    match client
        .request(
            method::SESSION_THINKING_OPTIONS,
            json!({ "session_id": session_id }),
        )
        .await
    {
        Ok(value) => {
            let parsed: SessionSettingsResult = serde_json::from_value(value)
                .map_err(|e| RpcFailure::local(error_code::INTERNAL_ERROR, e.to_string()))?;
            Ok(Some(SessionSettings {
                overrides: parsed.overrides.into(),
                thinking_options: parsed.thinking_options.map(Into::into),
            }))
        }
        // A daemon that predates capability reporting offers every method
        // and refuses the call instead.
        Err(e) if e.code == error_code::METHOD_NOT_FOUND => Ok(None),
        Err(e) => Err(e.into()),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalog {
    pub model_provider: String,
    pub models: Vec<String>,
    /// True when the provider runs locally.
    pub local: bool,
    /// True when the list came from the provider rather than a built-in
    /// catalogue.
    pub live: bool,
    /// True when the daemon's list was longer than the app shows.
    pub truncated: bool,
}

/// Models the daemon knows for a provider reference. The daemon does not
/// check a model id against this list, so the UI also accepts a typed id.
///
/// The list can come live from the provider, so the call has a short
/// ceiling of its own and the answer is bounded: an oversized or slow
/// answer must not hold up a cancel or an approval queued behind it.
#[tauri::command]
pub async fn catalog_models(
    state: State<'_, AppState>,
    model_provider: String,
) -> Result<ModelCatalog, String> {
    if !is_plain_token(&model_provider, TOKEN_MAX) {
        return Err("That provider reference is not valid.".into());
    }
    let client = state.client().await.map_err(|e| e.user_message())?;
    if !client.supports(method::CONFIG_CATALOG_MODELS) {
        return Err("This daemon cannot list models.".into());
    }
    let value = client
        .request_with_timeout(
            method::CONFIG_CATALOG_MODELS,
            json!({ "model_provider": model_provider }),
            LIST_TIMEOUT,
        )
        .await
        .map_err(|e| e.user_message())?;
    let parsed: CatalogModelsResult = serde_json::from_value(value).map_err(|e| e.to_string())?;
    let (models, truncated) = bound_catalog(parsed.models);
    Ok(ModelCatalog {
        model_provider: if parsed.model_provider.is_empty() {
            model_provider
        } else {
            parsed.model_provider
        },
        models,
        local: parsed.local,
        live: parsed.live,
        truncated,
    })
}

/// Configured provider references (`<provider_type>.<alias>`).
#[tauri::command]
pub async fn model_providers(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let client = state.client().await.map_err(|e| e.user_message())?;
    if !client.supports(method::QUICKSTART_STATE) {
        return Err("This daemon cannot list its providers.".into());
    }
    let value = client
        .request_with_timeout(method::QUICKSTART_STATE, json!({}), LIST_TIMEOUT)
        .await
        .map_err(|e| e.user_message())?;
    let parsed: QuickstartStateResult = serde_json::from_value(value).map_err(|e| e.to_string())?;
    Ok(parsed.model_providers)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityRequest {
    pub agent_alias: String,
    /// Read this provider's configured model instead of the agent's
    /// provider. Used after a provider switch that named no model.
    #[serde(default)]
    pub model_provider: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub provider: Option<String>,
    pub model: Option<String>,
}

/// The provider and model a session runs on when it has no override, read
/// from the daemon's config. The daemon does not report a session's
/// effective model, so this is the same two-step read zerocode makes.
/// Display only: every failure reads as "unknown".
#[tauri::command]
pub async fn session_identity(
    state: State<'_, AppState>,
    request: IdentityRequest,
) -> Result<Identity, String> {
    // The alias and reference become config-path prefixes the daemon
    // matches as plain strings, so anything but a plain token reads as
    // unknown rather than being sent.
    if !is_plain_token(&request.agent_alias, TOKEN_MAX) {
        return Ok(Identity::default());
    }
    let client = state.client().await.map_err(|e| e.user_message())?;
    if !client.supports(method::CONFIG_LIST) {
        return Ok(Identity::default());
    }
    let provider = match request
        .model_provider
        .filter(|reference| is_plain_token(reference, TOKEN_MAX))
    {
        Some(reference) => Some(reference),
        None => {
            config_string_inner(
                &client,
                &format!("agents.{}.model_provider", request.agent_alias),
            )
            .await
        }
    };
    let model = match provider.as_deref() {
        Some(reference) => {
            config_string_inner(&client, &format!("providers.models.{reference}.model")).await
        }
        None => None,
    };
    Ok(Identity { provider, model })
}

/// One string value from `config/list`. Missing, unset, blank, or non-string
/// values read as `None`.
async fn config_string_inner(client: &DaemonClient, prop: &str) -> Option<String> {
    let value = client
        .request(method::CONFIG_LIST, json!({ "prefix": prop }))
        .await
        .ok()?;
    let parsed: ConfigListResult = serde_json::from_value(value).ok()?;
    parsed
        .entries
        .into_iter()
        .find(|entry| entry.path == prop)
        .and_then(|entry| entry.value)
        .and_then(|value| value.as_str().map(str::to_owned))
        .filter(|text| !text.trim().is_empty())
}

/// Longest value the session-settings commands pass to the daemon.
const TOKEN_MAX: usize = 256;
/// Most model ids the app shows from one catalogue answer.
const CATALOG_MAX: usize = 2000;
/// Ceiling for list calls that may reach a provider over the network.
const LIST_TIMEOUT: Duration = Duration::from_secs(12);
/// The only settings `reset` may name.
const RESET_FIELDS: [&str; 2] = ["thinking_level", "thinking_display"];

/// A value fit to travel as a model id, provider reference, agent alias, or
/// enum name: non-empty, bounded, and free of whitespace and control
/// characters. The daemon has its own rules on top; this keeps a stray
/// newline or a pasted paragraph from ever reaching it.
fn is_plain_token(text: &str, max: usize) -> bool {
    !text.is_empty()
        && text.len() <= max
        && !text.chars().any(|c| c.is_control() || c.is_whitespace())
}

fn validate_overrides(o: &SessionOverrides) -> Result<(), String> {
    let fields = [
        ("model", &o.model),
        ("model_provider", &o.model_provider),
        ("mode", &o.mode),
        ("thinking_level", &o.thinking_level),
        ("thinking_display", &o.thinking_display),
    ];
    for (name, value) in fields {
        if let Some(text) = value
            && !is_plain_token(text, TOKEN_MAX)
        {
            return Err(format!(
                "{name} must be one value with no spaces, up to {TOKEN_MAX} characters"
            ));
        }
    }
    if o.temperature.is_some_and(|t| !t.is_finite()) {
        return Err("temperature must be a finite number".into());
    }
    Ok(())
}

fn validate_reset(reset: &[String]) -> Result<(), String> {
    match reset
        .iter()
        .find(|field| !RESET_FIELDS.contains(&field.as_str()))
    {
        Some(other) => Err(format!(
            "`{other}` cannot be reset; only thinking_level and thinking_display can"
        )),
        None => Ok(()),
    }
}

/// Keep a catalogue to ids the UI can show, and to a size it can render.
fn bound_catalog(models: Vec<String>) -> (Vec<String>, bool) {
    let mut kept: Vec<String> = models
        .into_iter()
        .filter(|id| is_plain_token(id, TOKEN_MAX))
        .collect();
    let truncated = kept.len() > CATALOG_MAX;
    kept.truncate(CATALOG_MAX);
    (kept, truncated)
}

/// Branch lookup never fails the caller: a workspace outside a repository is
/// an ordinary state, not an error.
async fn git_branch_inner(
    client: &DaemonClient,
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
    client: &DaemonClient,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ipc_overrides_use_camel_case_and_map_onto_the_wire_names() {
        let from_ui: Overrides = serde_json::from_value(serde_json::json!({
            "modelProvider": "anthropic.default",
            "thinkingLevel": "high"
        }))
        .expect("parse");
        let wire = serde_json::to_value(SessionOverrides::from(from_ui)).expect("serialize");
        assert_eq!(
            wire,
            serde_json::json!({"model_provider": "anthropic.default", "thinking_level": "high"})
        );
    }

    #[test]
    fn an_echo_reaches_the_ui_with_every_field_present() {
        let echo = SessionOverrides {
            model: Some("m1".into()),
            ..SessionOverrides::default()
        };
        let value = serde_json::to_value(Overrides::from(echo)).expect("serialize");
        assert_eq!(value["model"], "m1");
        // Unset fields are explicit nulls so the UI never sees `undefined`.
        for key in [
            "modelProvider",
            "temperature",
            "mode",
            "thinkingLevel",
            "thinkingDisplay",
        ] {
            assert!(value[key].is_null(), "{key} should be null");
            assert!(value.get(key).is_some(), "{key} should be present");
        }
    }

    #[test]
    fn plain_tokens_exclude_whitespace_control_characters_and_empties() {
        assert!(is_plain_token("claude-fable-5-1", TOKEN_MAX));
        assert!(is_plain_token("anthropic.default", TOKEN_MAX));
        assert!(!is_plain_token("", TOKEN_MAX));
        assert!(!is_plain_token("two words", TOKEN_MAX));
        assert!(!is_plain_token("line\nbreak", TOKEN_MAX));
        assert!(!is_plain_token("tab\there", TOKEN_MAX));
        assert!(!is_plain_token(&"x".repeat(TOKEN_MAX + 1), TOKEN_MAX));
    }

    #[test]
    fn overrides_with_a_pasted_paragraph_or_a_nan_are_refused_before_the_daemon() {
        let mut o = SessionOverrides {
            model: Some("gpt-5".into()),
            ..SessionOverrides::default()
        };
        assert!(validate_overrides(&o).is_ok());
        o.model = Some("gpt-5\nplease".into());
        assert!(validate_overrides(&o).unwrap_err().contains("model"));
        o.model = None;
        o.temperature = Some(f64::NAN);
        assert!(validate_overrides(&o).is_err());
    }

    #[test]
    fn only_the_two_thinking_fields_can_be_reset() {
        assert!(validate_reset(&["thinking_level".into()]).is_ok());
        assert!(validate_reset(&[]).is_ok());
        assert!(validate_reset(&["model".into()]).is_err());
    }

    #[test]
    fn a_catalogue_is_bounded_and_scrubbed() {
        let mut models: Vec<String> = (0..CATALOG_MAX + 5).map(|i| format!("m{i}")).collect();
        models.push("has space".into());
        let (kept, truncated) = bound_catalog(models);
        assert_eq!(kept.len(), CATALOG_MAX);
        assert!(truncated);
        let (small, cut) = bound_catalog(vec!["a".into(), "bad id".into()]);
        assert_eq!(small, vec!["a"]);
        assert!(!cut);
    }

    #[test]
    fn a_configure_request_without_reset_or_overrides_still_parses() {
        let request: ConfigureRequest =
            serde_json::from_value(serde_json::json!({"sessionId": "s1"})).expect("parse");
        assert_eq!(request.session_id, "s1");
        assert!(request.reset.is_empty());
        assert_eq!(request.overrides, Overrides::default());
    }
}
