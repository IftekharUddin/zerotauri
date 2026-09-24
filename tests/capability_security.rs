//! The webview must never gain a native capability beyond the small,
//! deliberately chosen allowlist, and must never be granted to remote
//! content. Unlike the tray app's test, this one runs in CI: the app crate
//! has its own workflow.

use std::path::Path;

use tauri_utils::acl::build::parse_capabilities;

/// Permissions this app is allowed to grant its own local content. `core:` is
/// the Tauri core surface; `dialog:allow-open` is the OS folder picker used
/// to choose a workspace. No filesystem, shell, or HTTP plugin belongs here:
/// the daemon owns the workspace and every action on it.
const ALLOWED_PREFIXES: [&str; 1] = ["core:"];
const ALLOWED_EXACT: [&str; 1] = ["dialog:allow-open"];

#[test]
fn webview_capabilities_stay_inside_the_allowlist_and_refuse_remote_content() {
    let pattern = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("capabilities")
        .join("**")
        .join("*");
    let capabilities = parse_capabilities(
        pattern
            .to_str()
            .expect("Tauri capability path must be valid UTF-8"),
    )
    .unwrap_or_else(|error| panic!("parse {}: {error}", pattern.display()));

    assert!(!capabilities.is_empty(), "no Tauri capabilities found");

    for (identifier, capability) in capabilities {
        assert!(
            capability.remote.is_none(),
            "capability `{identifier}` grants remote content access to native IPC"
        );

        for permission in capability.permissions {
            let id = permission.identifier().get();
            let allowed =
                ALLOWED_PREFIXES.iter().any(|p| id.starts_with(p)) || ALLOWED_EXACT.contains(&id);
            assert!(
                allowed,
                "capability `{identifier}` grants `{id}`, which is outside the allowlist"
            );
        }
    }
}
