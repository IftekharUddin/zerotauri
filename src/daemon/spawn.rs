//! Start a daemon only when none is already listening.
//!
//! The spawned daemon is detached and never signalled on exit. `--ephemeral`
//! makes it self-terminate shortly after its last client disconnects, so an
//! app-started daemon goes away with the app while a daemon the user started
//! themselves is left strictly alone.
//!
//! Note for the operator-facing copy: `--ephemeral` changes only the exit
//! rule. The daemon still starts the gateway, configured channels, and cron
//! from the user's config, and any other client that attaches keeps it alive.

use std::path::Path;
use std::process::{Command, Stdio};

use anyhow::{Context, Result};

use crate::rpc::client::Endpoint;

/// Spawn `zeroclaw daemon --ephemeral` bound to a specific endpoint and
/// config directory. Returns the child PID so the app can offer an explicit
/// "stop the daemon this app started" action later.
pub fn spawn_ephemeral(
    binary: &Path,
    config_dir: &Path,
    endpoint: &Endpoint,
    log: &Path,
) -> Result<u32> {
    if let Some(parent) = log.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let out = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log)
        .with_context(|| format!("open daemon log {}", log.display()))?;
    let err = out.try_clone().context("clone daemon log handle")?;

    let mut cmd = Command::new(binary);
    cmd.arg("daemon")
        .arg("--ephemeral")
        .arg("--config-dir")
        .arg(config_dir)
        // Pin the endpoint explicitly so the daemon and this client cannot
        // disagree about where to meet.
        .env("ZEROCLAW_SOCKET", endpoint.display())
        .stdin(Stdio::null())
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err));

    // Detach: a signal to the app's process group (Ctrl-C on a dev run) must
    // not take the daemon with it, and the daemon outlives app exit.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
        cmd.creation_flags(0x0000_0008 | 0x0000_0200 | 0x0800_0000);
    }

    let child = cmd
        .spawn()
        .with_context(|| format!("spawn {} daemon --ephemeral", binary.display()))?;
    Ok(child.id())
}

/// Ask a daemon this app started to stop. Only ever called with a PID the app
/// recorded for a daemon it spawned itself.
#[cfg(unix)]
pub fn stop_owned(pid: u32) -> Result<()> {
    let status = Command::new("kill")
        .arg("-TERM")
        .arg(pid.to_string())
        .status()
        .context("signal the app-started daemon")?;
    if status.success() {
        Ok(())
    } else {
        Err(anyhow::Error::msg(format!(
            "could not stop daemon process {pid}"
        )))
    }
}

#[cfg(windows)]
pub fn stop_owned(pid: u32) -> Result<()> {
    let status = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .status()
        .context("signal the app-started daemon")?;
    if status.success() {
        Ok(())
    } else {
        Err(anyhow::Error::msg(format!(
            "could not stop daemon process {pid}"
        )))
    }
}
