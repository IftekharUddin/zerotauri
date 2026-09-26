//! Newline-delimited JSON-RPC 2.0 client for the ZeroClaw daemon.
//!
//! Framing, handshake, and reconnect identity follow the daemon contract in
//! `crates/zeroclaw-runtime/src/rpc/local.rs`: one complete JSON object per
//! line, `initialize` before any other method, and a `tui_id`/`tui_sig` pair
//! replayed on reconnect so the daemon restores the same client identity.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use anyhow::{Context, Result};
use serde_json::{Value, json};
use tauri::async_runtime::JoinHandle;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{Mutex, mpsc, oneshot};

use super::wire::{self, InitializeParams, InitializeResult, error_code, method};

/// How long the handshake may take before the connection is abandoned.
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(10);
/// Default ceiling for an ordinary request. The daemon dispatches a
/// connection's frames serially, so a slow neighbour call must not hang the
/// UI forever.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(45);

/// A structured JSON-RPC error from the daemon.
#[derive(Debug, Clone, serde::Serialize)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
}

impl RpcError {
    fn local(message: impl Into<String>) -> Self {
        Self {
            code: error_code::METHOD_NOT_FOUND,
            message: message.into(),
        }
    }

    /// Plain-language text for the states the coding workspace can hit.
    pub fn user_message(&self) -> String {
        match self.code {
            error_code::SESSION_NOT_FOUND => {
                "That session is no longer available on the daemon.".into()
            }
            error_code::SESSION_BUSY => {
                "The agent is still working on the previous message. Cancel it or wait.".into()
            }
            error_code::SESSION_LIMIT_REACHED => {
                "The daemon has reached its session limit. Close a session and retry.".into()
            }
            error_code::SESSION_NOT_OWNED => {
                "Another client owns this session. Reopen it here to take ownership.".into()
            }
            error_code::AUTH_REQUIRED => "The daemon connection needs to be re-established.".into(),
            _ => self.message.clone(),
        }
    }
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} (code {})", self.message, self.code)
    }
}

/// Where the daemon listens. Resolution mirrors zerocode so both clients
/// agree on the endpoint for a given config directory.
#[derive(Debug, Clone)]
pub enum Endpoint {
    /// Unix domain socket path.
    Socket(std::path::PathBuf),
    /// Windows named pipe name.
    Pipe(String),
}

impl Endpoint {
    pub fn display(&self) -> String {
        match self {
            Self::Socket(p) => p.display().to_string(),
            Self::Pipe(name) => name.clone(),
        }
    }
}

type PendingMap = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, RpcError>>>>>;

/// What the reader task does with a frame the daemon initiated.
pub enum Inbound {
    /// A `session/update` notification: the raw params, forwarded verbatim.
    Update(Value),
    /// Any other notification.
    Notification { method: String, params: Value },
    /// The transport ended.
    Closed,
}

/// Type-erased sink for daemon-initiated traffic. Erasing the closure type
/// here is load bearing: the reconnect path calls back into `connect`, and a
/// generic callback would make the two future types refer to each other.
pub type InboundSink = Arc<dyn Fn(Inbound) + Send + Sync + 'static>;

/// A live, initialized connection to one daemon endpoint.
pub struct DaemonClient {
    tx: mpsc::UnboundedSender<String>,
    pending: PendingMap,
    next_id: AtomicU64,
    tasks: Mutex<Vec<JoinHandle<()>>>,
    pub init: InitializeResult,
    pub endpoint: String,
}

impl DaemonClient {
    /// True when the daemon advertised this method in its capability list. An
    /// empty list means the daemon predates capability reporting, so the
    /// feature is offered and allowed to fail at call time instead.
    pub fn supports(&self, method_name: &str) -> bool {
        self.init.capabilities.is_empty() || self.init.capabilities.iter().any(|m| m == method_name)
    }

    pub fn identity(&self) -> Option<(String, String)> {
        match (self.init.tui_id.clone(), self.init.tui_sig.clone()) {
            (Some(id), Some(sig)) => Some((id, sig)),
            _ => None,
        }
    }

    pub fn tui_id(&self) -> Option<String> {
        self.init.tui_id.clone()
    }

    /// Issue a request and await its response.
    pub async fn request(&self, method_name: &str, params: Value) -> Result<Value, RpcError> {
        self.request_with_timeout(method_name, params, REQUEST_TIMEOUT)
            .await
    }

    /// Issue a request with a ceiling of the caller's choosing. For a call
    /// that may reach a provider over the network: the daemon answers one
    /// connection's requests in order, so a slow answer holds up whatever is
    /// queued behind it, including a cancel.
    pub async fn request_with_timeout(
        &self,
        method_name: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, RpcError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        let frame = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method_name,
            "params": params,
        });
        if self.tx.send(frame.to_string()).is_err() {
            self.pending.lock().await.remove(&id);
            return Err(RpcError::local("the daemon connection is closed"));
        }

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => {
                self.pending.lock().await.remove(&id);
                Err(RpcError::local("the daemon connection dropped mid-request"))
            }
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(RpcError::local(format!("`{method_name}` timed out")))
            }
        }
    }

    /// Fire a notification. `session/prompt` is sent this way: the daemon
    /// always spawns the handler and reports the outcome through
    /// `turn_complete`, so a response would carry no extra authority.
    pub fn notify(&self, method_name: &str, params: Value) -> Result<(), RpcError> {
        let frame = json!({
            "jsonrpc": "2.0",
            "method": method_name,
            "params": params,
        });
        self.tx
            .send(frame.to_string())
            .map_err(|_| RpcError::local("the daemon connection is closed"))
    }

    /// Drop the transport. Sessions survive on the daemon; only this
    /// connection goes away.
    pub async fn shutdown(&self) {
        for handle in self.tasks.lock().await.drain(..) {
            handle.abort();
        }
    }
}

/// Open a transport to the endpoint and run the `initialize` handshake.
pub async fn connect(
    endpoint: &Endpoint,
    identity: Option<(String, String)>,
    forward_env: bool,
    on_inbound: InboundSink,
) -> Result<DaemonClient> {
    let (reader, writer) = open_stream(endpoint).await?;

    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));

    let mut writer = writer;
    let write_task = tauri::async_runtime::spawn(async move {
        while let Some(line) = rx.recv().await {
            let mut bytes = line.into_bytes();
            if bytes.last() != Some(&b'\n') {
                bytes.push(b'\n');
            }
            if writer.write_all(&bytes).await.is_err() {
                break;
            }
            if writer.flush().await.is_err() {
                break;
            }
        }
    });

    let read_pending = Arc::clone(&pending);
    let read_tx = tx.clone();
    let reader_inbound = Arc::clone(&on_inbound);
    let read_task = tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(frame) = serde_json::from_str::<Value>(trimmed) else {
                continue;
            };
            route_frame(frame, &read_pending, &read_tx, reader_inbound.as_ref()).await;
        }
        reader_inbound(Inbound::Closed);
    });

    let client = DaemonClient {
        tx,
        pending,
        next_id: AtomicU64::new(1),
        tasks: Mutex::new(vec![write_task, read_task]),
        init: InitializeResult::default(),
        endpoint: endpoint.display(),
    };

    let (tui_id, tui_sig) = match identity {
        Some((id, sig)) => (Some(id), Some(sig)),
        None => (None, None),
    };
    let params = InitializeParams {
        protocol_version: wire::PROTOCOL_VERSION,
        tui_id,
        tui_sig,
        // The daemon forwards this to subprocesses it spawns for the agent,
        // so the user's PATH and toolchain env reach the agent's shells.
        // Deliberately no `clientCapabilities.elicitation`: advertising it
        // obligates answering `elicitation/create`, and unanswered requests
        // park tool calls until they time out.
        env: if forward_env {
            std::env::vars().collect()
        } else {
            HashMap::new()
        },
    };

    let value = serde_json::to_value(params).context("serialize initialize params")?;
    let result = client
        .request_with_timeout(method::INITIALIZE, value, INITIALIZE_TIMEOUT)
        .await
        .map_err(|e| {
            if e.code == error_code::VERSION_MISMATCH {
                anyhow::Error::msg(format!(
                    "protocol mismatch: this app speaks protocol version {}, the daemon reported a different one ({})",
                    wire::PROTOCOL_VERSION,
                    e.message
                ))
            } else {
                anyhow::Error::msg(format!("initialize failed: {e}"))
            }
        })?;

    let init: InitializeResult =
        serde_json::from_value(result).context("parse initialize result")?;

    if init.protocol_version != wire::PROTOCOL_VERSION {
        client.shutdown().await;
        anyhow::bail!(
            "protocol mismatch: this app speaks version {}, the daemon speaks version {}",
            wire::PROTOCOL_VERSION,
            init.protocol_version
        );
    }
    if !wire::version_at_least(&init.server_version, wire::MIN_SERVER_VERSION) {
        client.shutdown().await;
        anyhow::bail!(
            "the daemon is version {} but this app needs at least {}",
            init.server_version,
            wire::MIN_SERVER_VERSION
        );
    }

    Ok(DaemonClient { init, ..client })
}

async fn route_frame(
    frame: Value,
    pending: &PendingMap,
    tx: &mpsc::UnboundedSender<String>,
    on_inbound: &(dyn Fn(Inbound) + Send + Sync),
) {
    let has_method = frame.get("method").and_then(Value::as_str).is_some();
    let id = frame.get("id").cloned().filter(|v| !v.is_null());

    match (has_method, id) {
        // A daemon-initiated request. The app advertises no elicitation
        // capability, so nothing here is answerable: reply method-not-found
        // right away rather than letting the daemon wait out its timeout.
        (true, Some(id)) => {
            let reply = json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": {
                    "code": error_code::METHOD_NOT_FOUND,
                    "message": "ZeroTauri does not handle daemon-initiated requests yet",
                },
            });
            let _ = tx.send(reply.to_string());
        }
        // A notification.
        (true, None) => {
            let method_name = frame
                .get("method")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let params = frame.get("params").cloned().unwrap_or(Value::Null);
            if method_name == "session/update" {
                on_inbound(Inbound::Update(params));
            } else {
                on_inbound(Inbound::Notification {
                    method: method_name,
                    params,
                });
            }
        }
        // A response to one of our requests.
        (false, Some(id)) => {
            let Some(key) = id.as_u64() else { return };
            let Some(slot) = pending.lock().await.remove(&key) else {
                return;
            };
            let outcome = if let Some(err) = frame.get("error") {
                Err(RpcError {
                    code: err.get("code").and_then(Value::as_i64).unwrap_or(-32603),
                    message: err
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown daemon error")
                        .to_string(),
                })
            } else {
                Ok(frame.get("result").cloned().unwrap_or(Value::Null))
            };
            let _ = slot.send(outcome);
        }
        (false, None) => {}
    }
}

type BoxedReader = Box<dyn AsyncRead + Unpin + Send>;
type BoxedWriter = Box<dyn AsyncWrite + Unpin + Send>;

#[cfg(unix)]
async fn open_stream(endpoint: &Endpoint) -> Result<(BoxedReader, BoxedWriter)> {
    let Endpoint::Socket(path) = endpoint else {
        anyhow::bail!("a named pipe endpoint is not supported on this OS");
    };
    let stream = tokio::net::UnixStream::connect(path)
        .await
        .with_context(|| format!("connect to {}", path.display()))?;
    let (reader, writer) = tokio::io::split(stream);
    Ok((Box::new(reader), Box::new(writer)))
}

#[cfg(windows)]
async fn open_stream(endpoint: &Endpoint) -> Result<(BoxedReader, BoxedWriter)> {
    use tokio::net::windows::named_pipe::ClientOptions;
    let Endpoint::Pipe(name) = endpoint else {
        anyhow::bail!("a unix socket endpoint is not supported on this OS");
    };
    // The daemon creates a fresh pipe instance after each accept, so a
    // connect can legitimately land while no instance is pending.
    const ERROR_PIPE_BUSY: i32 = 231;
    let mut last_err = None;
    for _ in 0..50 {
        match ClientOptions::new().open(name.as_str()) {
            Ok(stream) => {
                let (reader, writer) = tokio::io::split(stream);
                return Ok((Box::new(reader), Box::new(writer)));
            }
            Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) => {
                last_err = Some(e);
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            Err(e) => return Err(anyhow::Error::from(e).context(format!("connect to {name}"))),
        }
    }
    Err(anyhow::Error::from(
        last_err.unwrap_or_else(|| std::io::Error::other("named pipe stayed busy")),
    )
    .context(format!("connect to {name}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn responses_resolve_the_matching_pending_request() {
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let (tx, _rx) = mpsc::unbounded_channel();
        let (slot_tx, slot_rx) = oneshot::channel();
        pending.lock().await.insert(7, slot_tx);

        route_frame(
            json!({"jsonrpc": "2.0", "id": 7, "result": {"ok": true}}),
            &pending,
            &tx,
            &|_| {},
        )
        .await;

        let got = slot_rx.await.expect("slot resolved").expect("ok result");
        assert_eq!(got["ok"], true);
        assert!(pending.lock().await.is_empty());
    }

    #[tokio::test]
    async fn error_responses_carry_the_daemon_code() {
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let (tx, _rx) = mpsc::unbounded_channel();
        let (slot_tx, slot_rx) = oneshot::channel();
        pending.lock().await.insert(1, slot_tx);

        route_frame(
            json!({"jsonrpc":"2.0","id":1,"error":{"code":-32002,"message":"busy"}}),
            &pending,
            &tx,
            &|_| {},
        )
        .await;

        let err = slot_rx.await.expect("slot").expect_err("error result");
        assert_eq!(err.code, error_code::SESSION_BUSY);
        assert!(err.user_message().contains("still working"));
    }

    #[tokio::test]
    async fn session_updates_are_forwarded_verbatim() {
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let (tx, _rx) = mpsc::unbounded_channel();
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);

        route_frame(
            json!({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {"type": "agent_message_chunk", "session_id": "s1", "text": "hi"}
            }),
            &pending,
            &tx,
            &move |inbound| {
                if let Inbound::Update(v) = inbound {
                    sink.lock().expect("lock").push(v);
                }
            },
        )
        .await;

        let captured = seen.lock().expect("lock");
        assert_eq!(captured.len(), 1);
        assert_eq!(captured[0]["type"], "agent_message_chunk");
        assert_eq!(captured[0]["text"], "hi");
    }

    #[tokio::test]
    async fn daemon_initiated_requests_are_declined_immediately() {
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let (tx, mut rx) = mpsc::unbounded_channel();

        route_frame(
            json!({
                "jsonrpc": "2.0",
                "id": "zc-out-0",
                "method": "elicitation/create",
                "params": {"message": "Continue?"}
            }),
            &pending,
            &tx,
            &|_| {},
        )
        .await;

        let reply: Value =
            serde_json::from_str(&rx.recv().await.expect("a reply was queued")).expect("json");
        assert_eq!(reply["id"], "zc-out-0");
        assert_eq!(reply["error"]["code"], error_code::METHOD_NOT_FOUND);
    }

    #[tokio::test]
    async fn an_unknown_response_id_is_ignored_rather_than_answered() {
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let (tx, mut rx) = mpsc::unbounded_channel();

        route_frame(
            json!({"jsonrpc": "2.0", "id": 999, "result": {}}),
            &pending,
            &tx,
            &|_| {},
        )
        .await;

        assert!(rx.try_recv().is_err());
    }
}
