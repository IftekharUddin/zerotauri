//! Where the daemon is, and where the `zeroclaw` binary is.
//!
//! Endpoint and config-directory resolution mirror
//! `apps/zerocode/src/client.rs` exactly so both clients address the same
//! daemon for a given configuration.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use crate::rpc::client::Endpoint;

/// Config dir precedence: explicit override, then `ZEROCLAW_CONFIG_DIR`,
/// then `~/.zeroclaw`.
pub fn resolve_config_dir(explicit: Option<&Path>) -> Result<PathBuf> {
    if let Some(dir) = explicit {
        return Ok(dir.to_path_buf());
    }
    if let Ok(dir) = std::env::var("ZEROCLAW_CONFIG_DIR") {
        let dir = dir.trim();
        if !dir.is_empty() {
            return Ok(PathBuf::from(dir));
        }
    }
    #[cfg(unix)]
    {
        let home = std::env::var("HOME").context("HOME is not set")?;
        Ok(PathBuf::from(home).join(".zeroclaw"))
    }
    #[cfg(windows)]
    {
        let profile = std::env::var("USERPROFILE").context("USERPROFILE is not set")?;
        Ok(PathBuf::from(profile).join(".zeroclaw"))
    }
}

/// Endpoint precedence: `ZEROCLAW_SOCKET`, then the per-config-dir default.
pub fn resolve_endpoint(config_dir: &Path) -> Endpoint {
    if let Ok(raw) = std::env::var("ZEROCLAW_SOCKET") {
        let raw = raw.trim();
        if !raw.is_empty() {
            #[cfg(windows)]
            if raw.starts_with(r"\\.\pipe\") {
                return Endpoint::Pipe(raw.to_string());
            }
            return Endpoint::Socket(PathBuf::from(raw));
        }
    }
    #[cfg(unix)]
    {
        Endpoint::Socket(config_dir.join("data").join("daemon.sock"))
    }
    #[cfg(windows)]
    {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let data_dir = config_dir.join("data");
        let mut hasher = DefaultHasher::new();
        data_dir.hash(&mut hasher);
        Endpoint::Pipe(format!(r"\\.\pipe\zeroclaw-{:x}", hasher.finish()))
    }
}

fn exe_name() -> &'static str {
    if cfg!(windows) {
        "zeroclaw.exe"
    } else {
        "zeroclaw"
    }
}

/// Locate the kernel binary. Checks the directory beside this app first (an
/// installed side-by-side or bundled kernel), then `PATH`, then the install
/// locations a GUI launch's minimal `PATH` usually misses.
pub fn find_zeroclaw_binary() -> Option<PathBuf> {
    let name = exe_name();

    if let Ok(exe) = std::env::current_exe() {
        let sibling = exe.with_file_name(name);
        if sibling.is_file() {
            return Some(sibling);
        }
    }

    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        for rel in [".cargo/bin", ".local/bin"] {
            let candidate = home.join(rel).join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    for dir in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        let candidate = Path::new(dir).join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_explicit_config_dir_wins() {
        let explicit = PathBuf::from("/tmp/zeroclaw-explicit");
        let resolved = resolve_config_dir(Some(&explicit)).expect("resolve");
        assert_eq!(resolved, explicit);
    }

    #[cfg(unix)]
    #[test]
    fn the_default_endpoint_sits_under_the_config_data_dir() {
        // Guard against an ambient override leaking in from the environment.
        if std::env::var_os("ZEROCLAW_SOCKET").is_some() {
            return;
        }
        let endpoint = resolve_endpoint(Path::new("/home/someone/.zeroclaw"));
        match endpoint {
            Endpoint::Socket(path) => {
                assert_eq!(path, Path::new("/home/someone/.zeroclaw/data/daemon.sock"));
            }
            Endpoint::Pipe(_) => panic!("expected a unix socket endpoint"),
        }
    }
}
