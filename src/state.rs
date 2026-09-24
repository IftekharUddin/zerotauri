//! Connection ownership: one RPC connection per daemon endpoint per process.
//!
//! Every window shares this connection. Session ownership is connection
//! scoped daemon-side, so sharing one connection is what lets a cancel issued
//! from any window reach a session opened in another.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{Mutex, RwLock};

use crate::daemon::discovery;
use crate::daemon::spawn;
use crate::rpc::client::{DaemonClient, Endpoint, Inbound, RpcError, connect};
use crate::rpc::wire;

/// Event channel names the webview listens on.
pub const EVENT_UPDATE: &str = "code://session-update";
pub const EVENT_CONNECTION: &str = "code://connection";

/// How long to keep polling for a daemon we just spawned.
const SPAWN_READY_TIMEOUT: Duration = Duration::from_secs(25);
/// Reconnect attempt spacing, matching zerocode's one-per-second throttle.
const RECONNECT_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub endpoint: String,
    pub config_dir: String,
    pub server_version: String,
    pub server_pid: u32,
    pub protocol_version: u64,
    /// True when this app spawned the daemon it is talking to. Drives the
    /// status bar wording and whether "stop this daemon" is offered.
    pub started_by_app: bool,
    /// Methods the UI wanted that this daemon does not advertise. The UI
    /// hides those affordances instead of failing at click time.
    pub missing_methods: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum ConnectionEvent {
    Connected { info: ConnectionInfo, resumed: bool },
    Lost,
    Reconnecting { attempt: u32 },
    Failed { message: String },
}

pub struct AppState {
    pub config_dir: PathBuf,
    pub endpoint: Endpoint,
    client: RwLock<Option<Arc<DaemonClient>>>,
    identity: Mutex<Option<(String, String)>>,
    owned_pid: Mutex<Option<u32>>,
    reconnecting: AtomicBool,
}

impl AppState {
    pub fn new() -> anyhow::Result<Self> {
        let explicit = config_dir_from_args();
        let config_dir = discovery::resolve_config_dir(explicit.as_deref())?;
        let endpoint = discovery::resolve_endpoint(&config_dir);
        Ok(Self {
            config_dir,
            endpoint,
            client: RwLock::new(None),
            identity: Mutex::new(None),
            owned_pid: Mutex::new(None),
            reconnecting: AtomicBool::new(false),
        })
    }

    /// The live connection, or a plain-language error when there is none.
    pub async fn client(&self) -> Result<Arc<DaemonClient>, RpcError> {
        self.client.read().await.clone().ok_or_else(|| RpcError {
            code: crate::rpc::wire::error_code::AUTH_REQUIRED,
            message: "not connected to a ZeroClaw daemon".into(),
        })
    }

    pub async fn is_connected(&self) -> bool {
        self.client.read().await.is_some()
    }

    pub async fn owned_pid(&self) -> Option<u32> {
        *self.owned_pid.lock().await
    }

    pub async fn info(&self) -> Option<ConnectionInfo> {
        let client = self.client.read().await.clone()?;
        let started_by_app = self.owned_pid.lock().await.is_some();
        Some(build_info(
            &client,
            &self.endpoint,
            &self.config_dir,
            started_by_app,
        ))
    }
}

fn build_info(
    client: &DaemonClient,
    endpoint: &Endpoint,
    config_dir: &std::path::Path,
    started_by_app: bool,
) -> ConnectionInfo {
    let wanted = [
        wire::method::SESSION_LIST_ACP,
        wire::method::SESSION_MESSAGES,
        wire::method::SESSION_GIT_BRANCH,
        wire::method::SESSION_STATE,
        wire::method::SESSION_APPROVE,
        wire::method::SESSION_CANCEL,
    ];
    let missing_methods = wanted
        .iter()
        .filter(|m| !client.supports(m))
        .map(|m| (*m).to_string())
        .collect();

    ConnectionInfo {
        endpoint: endpoint.display(),
        config_dir: config_dir.display().to_string(),
        server_version: client.init.server_version.clone(),
        server_pid: client.init.server_pid,
        protocol_version: client.init.protocol_version,
        started_by_app,
        missing_methods,
    }
}

/// Attach to a running daemon, or start an ephemeral one when nothing
/// answers. Never signals a daemon it did not start.
pub async fn establish(app: &AppHandle, allow_spawn: bool) -> anyhow::Result<ConnectionInfo> {
    let state = app.state::<AppState>();

    if let Some(existing) = state.info().await {
        return Ok(existing);
    }

    let identity = state.identity.lock().await.clone();

    // 1. Try an already-running daemon first, so an independently started one
    //    is reused rather than competing with a second instance.
    match try_connect(app, identity.clone()).await {
        Ok(info) => return Ok(info),
        Err(fatal) if is_fatal(&fatal) => return Err(fatal),
        Err(_) if !allow_spawn => {
            anyhow::bail!(
                "no ZeroClaw daemon is listening at {}",
                state.endpoint.display()
            );
        }
        Err(_) => {}
    }

    // 2. Nothing listening: start one of our own.
    let Some(binary) = discovery::find_zeroclaw_binary() else {
        anyhow::bail!(
            "could not find the `zeroclaw` binary. Install ZeroClaw, or start a daemon yourself, then retry."
        );
    };

    let log = app
        .path()
        .app_log_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("zero-claw-code-daemon.log");

    let pid = spawn::spawn_ephemeral(&binary, &state.config_dir, &state.endpoint, &log)?;
    *state.owned_pid.lock().await = Some(pid);

    let deadline = std::time::Instant::now() + SPAWN_READY_TIMEOUT;
    let mut last_error: Option<anyhow::Error> = None;
    while std::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(400)).await;
        match try_connect(app, identity.clone()).await {
            Ok(info) => return Ok(info),
            Err(fatal) if is_fatal(&fatal) => return Err(fatal),
            Err(e) => last_error = Some(e),
        }
    }

    *state.owned_pid.lock().await = None;
    Err(anyhow::Error::msg(format!(
        "started a daemon from {} but it never became ready: {}",
        binary.display(),
        last_error
            .map(|e| e.to_string())
            .unwrap_or_else(|| "no response".into())
    )))
}

/// A connect failure the caller must surface rather than retry. A protocol or
/// version-floor mismatch will not fix itself by spawning another daemon.
fn is_fatal(error: &anyhow::Error) -> bool {
    let text = error.to_string();
    text.contains("protocol mismatch") || text.contains("needs at least")
}

async fn try_connect(
    app: &AppHandle,
    identity: Option<(String, String)>,
) -> anyhow::Result<ConnectionInfo> {
    let state = app.state::<AppState>();
    let emitter = app.clone();

    let client = connect(
        &state.endpoint,
        identity,
        true,
        Arc::new(move |inbound| match inbound {
            Inbound::Update(params) => {
                let _ = emitter.emit(EVENT_UPDATE, params);
            }
            Inbound::Notification { .. } => {}
            Inbound::Closed => on_transport_closed(emitter.clone()),
        }),
    )
    .await?;

    let client = Arc::new(client);
    if let Some(pair) = client.identity() {
        *state.identity.lock().await = Some(pair);
    }
    let started_by_app = state.owned_pid.lock().await.is_some();
    let info = build_info(&client, &state.endpoint, &state.config_dir, started_by_app);
    *state.client.write().await = Some(client);
    Ok(info)
}

/// The transport ended. Sessions survive on the daemon, so the app clears the
/// connection, tells the UI, and retries with the cached identity.
///
/// Deliberately a plain function that spawns: making it `async` would put its
/// future inside the connect path that spawns it, and the two opaque future
/// types would refer to each other.
fn on_transport_closed(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        {
            let mut slot = state.client.write().await;
            if slot.is_none() {
                return;
            }
            *slot = None;
        }
        let _ = app.emit(EVENT_CONNECTION, ConnectionEvent::Lost);

        if state.reconnecting.swap(true, Ordering::SeqCst) {
            return;
        }

        let handle = app.clone();
        let mut attempt: u32 = 0;
        loop {
            attempt += 1;
            let _ = handle.emit(EVENT_CONNECTION, ConnectionEvent::Reconnecting { attempt });
            tokio::time::sleep(RECONNECT_INTERVAL).await;

            let identity = state.identity.lock().await.clone();
            match try_connect(&handle, identity).await {
                Ok(info) => {
                    state.reconnecting.store(false, Ordering::SeqCst);
                    let _ = handle.emit(
                        EVENT_CONNECTION,
                        ConnectionEvent::Connected {
                            info,
                            resumed: true,
                        },
                    );
                    return;
                }
                Err(e) if is_fatal(&e) => {
                    state.reconnecting.store(false, Ordering::SeqCst);
                    let _ = handle.emit(
                        EVENT_CONNECTION,
                        ConnectionEvent::Failed {
                            message: e.to_string(),
                        },
                    );
                    return;
                }
                Err(_) => {}
            }

            // Give up the automatic loop after a couple of minutes so a
            // machine that suspended overnight is not spinning forever; the
            // UI keeps a manual retry.
            if attempt >= 120 {
                state.reconnecting.store(false, Ordering::SeqCst);
                let _ = handle.emit(
                    EVENT_CONNECTION,
                    ConnectionEvent::Failed {
                        message: "the daemon did not come back. Use Retry to try again.".into(),
                    },
                );
                return;
            }
        }
    });
}

/// Forward a raw `session/update` payload to the webview. Used when replaying
/// a plan after a resume.
pub fn emit_update(app: &AppHandle, params: Value) {
    let _ = app.emit(EVENT_UPDATE, params);
}

/// `--config-dir <path>` or `--config-dir=<path>` on the command line. An
/// explicit flag beats the environment, the same precedence zerocode uses,
/// and it works from launchers that do not pass `VAR=value` prefixes through.
fn config_dir_from_args() -> Option<PathBuf> {
    parse_config_dir(std::env::args_os().skip(1))
}

fn parse_config_dir<I>(args: I) -> Option<PathBuf>
where
    I: IntoIterator<Item = std::ffi::OsString>,
{
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        let text = arg.to_string_lossy();
        if text == "--config-dir" {
            return args.next().map(PathBuf::from);
        }
        if let Some(value) = text.strip_prefix("--config-dir=")
            && !value.is_empty()
        {
            return Some(PathBuf::from(value));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<std::ffi::OsString> {
        list.iter().map(std::ffi::OsString::from).collect()
    }

    #[test]
    fn config_dir_flag_is_parsed_in_both_spellings() {
        assert_eq!(
            parse_config_dir(args(&["--config-dir", "/tmp/a"])),
            Some(PathBuf::from("/tmp/a"))
        );
        assert_eq!(
            parse_config_dir(args(&["--config-dir=/tmp/b"])),
            Some(PathBuf::from("/tmp/b"))
        );
        assert_eq!(parse_config_dir(args(&["--other", "x"])), None);
        assert_eq!(parse_config_dir(args(&["--config-dir"])), None);
        assert_eq!(parse_config_dir(args(&["--config-dir="])), None);
    }

    #[test]
    fn protocol_and_floor_failures_are_fatal_but_a_missing_socket_is_not() {
        assert!(is_fatal(&anyhow::Error::msg(
            "protocol mismatch: this app speaks version 1, the daemon speaks version 2"
        )));
        assert!(is_fatal(&anyhow::Error::msg(
            "the daemon is version 0.7.0 but this app needs at least 0.8.0"
        )));
        assert!(!is_fatal(&anyhow::Error::msg(
            "connect to /tmp/daemon.sock: No such file or directory"
        )));
    }
}
