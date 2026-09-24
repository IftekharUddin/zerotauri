//! The app's IPC surface. Every command is a projection of a daemon RPC; the
//! webview reaches the daemon only through these.

pub mod connection;
pub mod session;
