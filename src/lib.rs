//! ZeroTauri: a Tauri desktop GUI wrapper for a ZeroClaw daemon.
//!
//! The app is an RPC-only client of the ZeroClaw daemon. It links no
//! `zeroclaw-*` crate, owns no agent execution, and cannot approve a tool
//! call except by relaying the user's decision to the daemon.

pub mod commands;
pub mod daemon;
pub mod rpc;
pub mod state;

use tauri::Manager;

use state::AppState;

/// Build and run the desktop application.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // One process per user session: focus the existing window rather
            // than opening a second connection to the same daemon.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            app.manage(AppState::new()?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::connection::connect,
            commands::connection::connection_info,
            commands::connection::agents_list,
            commands::connection::pick_folder,
            commands::connection::daemon_stop_owned,
            commands::connection::client_protocol_version,
            commands::session::session_list,
            commands::session::session_open,
            commands::session::session_prompt,
            commands::session::session_cancel,
            commands::session::session_approve,
            commands::session::session_close,
            commands::session::session_state,
            commands::session::session_messages,
            commands::session::git_branch,
            commands::session::session_configure,
            commands::session::session_thinking_options,
            commands::session::catalog_models,
            commands::session::model_providers,
            commands::session::session_identity,
            commands::workspace::inspect_folder,
            commands::workspace::prepare_workspace,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ZeroTauri");
}
