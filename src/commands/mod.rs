//! The app's IPC surface. Every command is a projection of a daemon RPC; the
//! webview reaches the daemon only through these.

pub mod connection;
pub mod session;
pub mod workspace;

use serde::Serialize;

use crate::rpc::client::RpcError;

/// An error the webview can branch on.
///
/// Most commands flatten a daemon error to its plain-language text. The
/// session-settings commands keep the code as well, so the UI can tell "a
/// turn is running" from "the daemon refused that value" and word each one.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcFailure {
    pub code: i64,
    /// The daemon's own text, which names accepted values on a refusal.
    pub message: String,
    pub user_message: String,
}

impl RpcFailure {
    /// A failure raised by this app rather than by the daemon.
    pub fn local(code: i64, message: impl Into<String>) -> Self {
        let message = message.into();
        Self {
            code,
            user_message: message.clone(),
            message,
        }
    }
}

impl From<RpcError> for RpcFailure {
    fn from(error: RpcError) -> Self {
        Self {
            code: error.code,
            user_message: error.user_message(),
            message: error.message,
        }
    }
}
