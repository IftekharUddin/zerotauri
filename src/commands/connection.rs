//! Commands that own the daemon connection and the pre-session choices.

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::daemon::spawn;
use crate::rpc::wire::{self, AgentsListResult, method};
use crate::state::{AppState, ConnectionInfo};

/// Attach to a running daemon, or start an ephemeral one when nothing is
/// listening. Safe to call repeatedly: an existing connection is returned.
#[tauri::command]
pub async fn connect(app: AppHandle, allow_spawn: bool) -> Result<ConnectionInfo, String> {
    crate::state::establish(&app, allow_spawn)
        .await
        .map_err(|e| e.to_string())
}

/// The current connection, if any. Used on window load so a reopened window
/// picks up the process-wide connection instead of making a second one.
#[tauri::command]
pub async fn connection_info(state: State<'_, AppState>) -> Result<Option<ConnectionInfo>, String> {
    Ok(state.info().await)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChoice {
    pub alias: String,
    pub enabled: bool,
}

/// Agents the user can start a coding session with. Disabled agents are
/// filtered out here so the picker never offers a session that cannot start.
#[tauri::command]
pub async fn agents_list(state: State<'_, AppState>) -> Result<Vec<AgentChoice>, String> {
    let client = state.client().await.map_err(|e| e.user_message())?;
    let value = client
        .request(method::AGENTS_LIST, serde_json::json!({}))
        .await
        .map_err(|e| e.user_message())?;
    let parsed: AgentsListResult = serde_json::from_value(value).map_err(|e| e.to_string())?;
    Ok(parsed
        .agents
        .into_iter()
        .filter(|a| a.enabled)
        .map(|a| AgentChoice {
            alias: a.alias,
            enabled: a.enabled,
        })
        .collect())
}

/// Open the OS folder picker. The chosen absolute path becomes the session's
/// `cwd`; the app never reads the folder itself.
#[tauri::command]
pub async fn pick_folder(app: AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |picked| {
        let _ = tx.send(picked);
    });
    let picked = rx
        .await
        .map_err(|_| "the folder picker was closed".to_string())?;
    Ok(picked.and_then(|p| p.into_path().ok().map(|p| p.display().to_string())))
}

/// Stop a daemon this app started. Refuses when the daemon was already
/// running: the app never signals a process it did not spawn.
#[tauri::command]
pub async fn daemon_stop_owned(state: State<'_, AppState>) -> Result<bool, String> {
    let Some(pid) = state.owned_pid().await else {
        return Err("this daemon was already running; ZeroTauri will not stop it".into());
    };
    spawn::stop_owned(pid).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Longest address the app will hand to the system browser.
const LINK_MAX: usize = 2048;

/// True for an absolute http or https address with nothing odd in it.
fn is_web_link(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    url.len() <= LINK_MAX
        && (lower.starts_with("http://") || lower.starts_with("https://"))
        && !url.chars().any(|c| c.is_control() || c.is_whitespace())
}

/// Open a transcript link in the system browser. The webview never
/// navigates, so a link in agent output cannot replace this window, and
/// only http and https addresses are handed on.
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    if !is_web_link(&url) {
        return Err("Only http and https links can be opened.".into());
    }
    open::that_detached(&url).map_err(|e| format!("could not open the link: {e}"))
}

/// The protocol version this build speaks, for the About surface.
#[tauri::command]
pub fn client_protocol_version() -> u64 {
    wire::PROTOCOL_VERSION
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plain_web_addresses_may_be_opened() {
        assert!(is_web_link("https://example.com/a?b=1#c"));
        assert!(is_web_link("HTTP://example.com"));
        assert!(!is_web_link("javascript:alert(1)"));
        assert!(!is_web_link("file:///etc/passwd"));
        assert!(!is_web_link("https://example.com/with space"));
        assert!(!is_web_link("https://example.com/\n"));
        assert!(!is_web_link(&format!("https://{}", "a".repeat(LINK_MAX))));
        assert!(!is_web_link(""));
    }
}
