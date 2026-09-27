//! Where a session works: the folder the user chose, or a worktree of it.
//!
//! This is the one place the app touches a folder itself. Everything here
//! runs `git` as a subprocess with fixed arguments, only on a folder the user
//! picked, only when they asked for a worktree, and never reads or edits a
//! file inside the checkout. The daemon still owns everything the agent does
//! in the folder afterwards.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tokio::process::Command;

/// Marker for the block this app adds to `.git/info/exclude`.
const EXCLUDE_MARKER: &str = "# ZeroTauri session worktrees";
/// A session folder is a local timestamp, with a numeric suffix on a clash.
/// gitignore syntax has character classes but no repetition, hence the shape.
const EXCLUDE_PATTERNS: [&str; 2] = [
    "/[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]/",
    "/[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]-*/",
];
const BRANCH_PREFIX: &str = "zerotauri/";
const GIT_MISSING: &str = "git is not installed or not on this app's PATH";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderInfo {
    pub path: String,
    pub exists: bool,
    pub is_dir: bool,
    /// Root of the git checkout the folder is in, when it is in one.
    pub repo_root: Option<String>,
    /// The checked-out branch; absent on a detached HEAD or an empty repo.
    pub branch: Option<String>,
    /// True when the checkout is itself a linked worktree of another.
    pub is_linked_worktree: bool,
    /// The checkout that holds the repository's history: for a linked
    /// worktree, its main worktree; otherwise the root itself.
    pub project: Option<String>,
    pub git_available: bool,
}

/// What can be learned about a folder without touching it.
#[tauri::command]
pub async fn inspect_folder(path: String) -> Result<FolderInfo, String> {
    let folder = PathBuf::from(&path);
    let mut info = FolderInfo {
        path,
        exists: folder.exists(),
        is_dir: folder.is_dir(),
        repo_root: None,
        branch: None,
        is_linked_worktree: false,
        project: None,
        git_available: true,
    };
    if !info.is_dir {
        return Ok(info);
    }
    let root = match git_query(
        &folder,
        &["rev-parse", "--path-format=absolute", "--show-toplevel"],
    )
    .await
    {
        Err(_) => {
            info.git_available = false;
            return Ok(info);
        }
        Ok(None) => return Ok(info),
        Ok(Some(root)) => from_git(&root),
    };
    let git_dir = git_query(
        &folder,
        &["rev-parse", "--path-format=absolute", "--git-dir"],
    )
    .await?
    .map(|p| from_git(&p));
    let common = git_query(
        &folder,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )
    .await?
    .map(|p| from_git(&p));
    info.is_linked_worktree = matches!((&git_dir, &common), (Some(g), Some(c)) if g != c);
    info.project = common
        .as_deref()
        .and_then(Path::parent)
        .map(|p| p.display().to_string())
        .or_else(|| Some(root.display().to_string()));
    info.branch = git_query(&folder, &["rev-parse", "--abbrev-ref", "HEAD"])
        .await?
        .filter(|b| b != "HEAD");
    info.repo_root = Some(root.display().to_string());
    Ok(info)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareRequest {
    pub folder: String,
    /// Give the session a worktree of its own. Needs a git checkout.
    pub worktree: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: String,
    /// The branch or commit the worktree was created from.
    pub base: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedWorkspace {
    /// The directory the session works in.
    pub cwd: String,
    /// The folder the user chose, resolved.
    pub project: String,
    pub worktree: Option<WorktreeInfo>,
}

/// Decide where a new session works, creating its worktree when asked.
///
/// The worktree goes at `<checkout>/<timestamp>` on a new branch from the
/// current `HEAD`, and that folder shape is added to the repository's own
/// `info/exclude` once, so session folders never show up in `git status`.
/// A folder inside a checkout keeps its place: the session starts in the
/// same subfolder of the new worktree.
#[tauri::command]
pub async fn prepare_workspace(request: PrepareRequest) -> Result<PreparedWorkspace, String> {
    let folder = resolve_folder(&request.folder)?;
    let project = folder.display().to_string();
    if !request.worktree {
        return Ok(PreparedWorkspace {
            cwd: project.clone(),
            project,
            worktree: None,
        });
    }

    let info = inspect_folder(project.clone()).await?;
    if !info.git_available {
        return Err(format!(
            "{GIT_MISSING}, so no worktree can be made. Start the session in the folder itself instead."
        ));
    }
    let Some(root) = info.repo_root.as_deref().map(PathBuf::from) else {
        return Err(
            "That folder is not a git checkout, so no worktree can be made. Start the session in the folder itself instead."
                .into(),
        );
    };
    let base = match info.branch.clone() {
        Some(branch) => branch,
        None => git_query(&root, &["rev-parse", "--short", "HEAD"])
            .await?
            .ok_or_else(|| {
                "That checkout has no commits yet, so no worktree can be made. Make a first commit, or start the session in the folder itself.".to_string()
            })?,
    };
    let common = git_query(
        &root,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )
    .await?
    .map(|p| from_git(&p))
    .unwrap_or_else(|| root.join(".git"));

    let name = next_free_name(&root, &timestamp_name());
    let path = root.join(&name);
    let branch = format!("{BRANCH_PREFIX}{name}");
    ensure_excluded(&common)?;
    let path_text = path
        .to_str()
        .ok_or_else(|| "the worktree path is not valid UTF-8".to_string())?;
    git_run(
        &root,
        &["worktree", "add", "-b", &branch, path_text, "HEAD"],
    )
    .await?;

    // A subfolder of the checkout keeps its place in the new worktree.
    let cwd = match folder.strip_prefix(&root) {
        Ok(rel) if !rel.as_os_str().is_empty() && path.join(rel).is_dir() => path.join(rel),
        _ => path.clone(),
    };
    Ok(PreparedWorkspace {
        cwd: cwd.display().to_string(),
        project,
        worktree: Some(WorktreeInfo {
            path: path.display().to_string(),
            branch,
            base,
        }),
    })
}

/// A folder the user chose: absolute, existing, a directory, and free of
/// control characters, resolved through any symlinks.
fn resolve_folder(text: &str) -> Result<PathBuf, String> {
    if text.trim().is_empty() || text.chars().any(char::is_control) {
        return Err("That is not a folder path.".into());
    }
    let path = PathBuf::from(text);
    if !path.is_absolute() {
        return Err("The folder must be an absolute path.".into());
    }
    let resolved = std::fs::canonicalize(&path)
        .map(tidy)
        .map_err(|e| format!("Cannot open {}: {e}", path.display()))?;
    if !resolved.is_dir() {
        return Err(format!("{} is not a folder.", path.display()));
    }
    Ok(resolved)
}

/// A canonical path in the spelling the rest of the system uses. On
/// Windows, `canonicalize` adds a `\\?\` prefix that git does not print and
/// users do not expect to see; it comes off here.
fn tidy(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    path
}

/// A path git printed, in the same spelling as everything else here. Git
/// uses forward slashes even on Windows, so the path is resolved through the
/// file system when it exists.
fn from_git(text: &str) -> PathBuf {
    let path = PathBuf::from(text.trim());
    std::fs::canonicalize(&path).map(tidy).unwrap_or(path)
}

/// Local time, to the second: sorts in the rail and reads in Finder.
fn timestamp_name() -> String {
    chrono::Local::now().format("%Y%m%d-%H%M%S").to_string()
}

/// `base`, or `base-2`, `base-3`, ... when a folder of that name exists.
fn next_free_name(root: &Path, base: &str) -> String {
    if !root.join(base).exists() {
        return base.to_string();
    }
    (2..)
        .map(|n| format!("{base}-{n}"))
        .find(|candidate| !root.join(candidate).exists())
        .unwrap_or_else(|| base.to_string())
}

/// Add the session-folder shape to `<git dir>/info/exclude`, once.
///
/// `info/exclude` is the repository's own ignore list outside version
/// control, so nothing tracked changes and nothing the user might commit is
/// edited.
fn ensure_excluded(common_dir: &Path) -> Result<(), String> {
    let info_dir = common_dir.join("info");
    let exclude = info_dir.join("exclude");
    let existing = std::fs::read_to_string(&exclude).unwrap_or_default();
    if existing.contains(EXCLUDE_MARKER) {
        return Ok(());
    }
    std::fs::create_dir_all(&info_dir)
        .map_err(|e| format!("cannot create {}: {e}", info_dir.display()))?;
    let mut block = String::new();
    if !existing.is_empty() && !existing.ends_with('\n') {
        block.push('\n');
    }
    block.push_str(EXCLUDE_MARKER);
    block.push('\n');
    for pattern in EXCLUDE_PATTERNS {
        block.push_str(pattern);
        block.push('\n');
    }
    std::fs::write(&exclude, format!("{existing}{block}"))
        .map_err(|e| format!("cannot write {}: {e}", exclude.display()))
}

/// Run git and return its trimmed stdout, or its stderr as the error.
async fn git_run(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .await
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                GIT_MISSING.to_string()
            } else {
                format!("could not run git: {e}")
            }
        })?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("git {} failed", args.join(" "))
        } else {
            stderr
        })
    }
}

/// Like [`git_run`], but a git failure is an answer (`None`), not an error.
/// Only a git that cannot be run at all is an error.
async fn git_query(cwd: &Path, args: &[&str]) -> Result<Option<String>, String> {
    match git_run(cwd, args).await {
        Ok(text) => Ok(Some(text)),
        Err(message) if message == GIT_MISSING => Err(message),
        Err(_) => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "zerotauri-{label}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or_default()
            ));
            std::fs::create_dir_all(&path).expect("temp dir");
            Self(tidy(
                std::fs::canonicalize(&path).expect("canonical temp dir"),
            ))
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn git_available() -> bool {
        std::process::Command::new("git")
            .arg("--version")
            .output()
            .is_ok_and(|o| o.status.success())
    }

    fn sh_git(cwd: &Path, args: &[&str]) -> String {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .expect("git runs");
        assert!(
            output.status.success(),
            "git {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    #[test]
    fn a_timestamp_name_is_sortable_and_plain() {
        let name = timestamp_name();
        assert_eq!(name.len(), 15, "{name}");
        assert!(name[..8].chars().all(|c| c.is_ascii_digit()));
        assert_eq!(&name[8..9], "-");
        assert!(name[9..].chars().all(|c| c.is_ascii_digit()));
    }

    #[test]
    fn a_clashing_name_gets_a_numeric_suffix() {
        let tmp = TempDir::new("names");
        assert_eq!(next_free_name(&tmp.0, "20260926-120000"), "20260926-120000");
        std::fs::create_dir(tmp.0.join("20260926-120000")).unwrap();
        assert_eq!(
            next_free_name(&tmp.0, "20260926-120000"),
            "20260926-120000-2"
        );
        std::fs::create_dir(tmp.0.join("20260926-120000-2")).unwrap();
        assert_eq!(
            next_free_name(&tmp.0, "20260926-120000"),
            "20260926-120000-3"
        );
    }

    #[test]
    fn the_exclude_block_is_added_once_and_keeps_what_was_there() {
        let tmp = TempDir::new("exclude");
        let info = tmp.0.join("info");
        std::fs::create_dir_all(&info).unwrap();
        std::fs::write(info.join("exclude"), "*.log").unwrap();
        ensure_excluded(&tmp.0).unwrap();
        ensure_excluded(&tmp.0).unwrap();
        let text = std::fs::read_to_string(info.join("exclude")).unwrap();
        assert!(
            text.starts_with("*.log\n"),
            "the existing line is kept whole"
        );
        assert_eq!(text.matches(EXCLUDE_MARKER).count(), 1);
        for pattern in EXCLUDE_PATTERNS {
            assert!(text.contains(pattern));
        }
    }

    #[test]
    fn tidy_paths_carry_no_verbatim_prefix() {
        assert_eq!(
            tidy(PathBuf::from("/plain/path")),
            PathBuf::from("/plain/path")
        );
        #[cfg(windows)]
        {
            assert_eq!(
                tidy(PathBuf::from(r"\\?\C:\repo")),
                PathBuf::from(r"C:\repo")
            );
            assert_eq!(
                tidy(PathBuf::from(r"\\?\UNC\host\share")),
                PathBuf::from(r"\\host\share")
            );
        }
        let tmp = TempDir::new("tidy");
        let forward = tmp.0.display().to_string().replace('\\', "/");
        assert_eq!(from_git(&forward), tmp.0);
        assert_eq!(from_git("/no/such/place"), PathBuf::from("/no/such/place"));
    }

    #[test]
    fn folders_must_be_absolute_existing_directories() {
        assert!(resolve_folder("").is_err());
        assert!(resolve_folder("relative/path").is_err());
        assert!(resolve_folder("/definitely/not/here/zerotauri").is_err());
        assert!(resolve_folder("/tmp\nx").is_err());
        let tmp = TempDir::new("resolve");
        assert_eq!(resolve_folder(tmp.0.to_str().unwrap()).unwrap(), tmp.0);
    }

    #[tokio::test]
    async fn a_worktree_is_created_on_its_own_branch_and_kept_out_of_status() {
        if !git_available() {
            return;
        }
        let tmp = TempDir::new("repo");
        let repo = tmp.0.join("repo");
        std::fs::create_dir(&repo).unwrap();
        sh_git(&repo, &["init", "-q", "-b", "main"]);
        sh_git(
            &repo,
            &[
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@example.com",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "init",
            ],
        );
        std::fs::create_dir(repo.join("src")).unwrap();
        std::fs::write(repo.join("src/lib.rs"), "").unwrap();
        sh_git(&repo, &["add", "."]);
        sh_git(
            &repo,
            &[
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@example.com",
                "commit",
                "-q",
                "-m",
                "src",
            ],
        );

        let plain = prepare_workspace(PrepareRequest {
            folder: repo.display().to_string(),
            worktree: false,
        })
        .await
        .unwrap();
        assert!(plain.worktree.is_none());
        assert_eq!(plain.cwd, repo.display().to_string());

        let info = inspect_folder(repo.display().to_string()).await.unwrap();
        assert_eq!(info.branch.as_deref(), Some("main"));
        assert!(!info.is_linked_worktree);

        // Start from a subfolder: the session keeps its place in the worktree.
        let prepared = prepare_workspace(PrepareRequest {
            folder: repo.join("src").display().to_string(),
            worktree: true,
        })
        .await
        .unwrap();
        let worktree = prepared.worktree.expect("a worktree");
        let path = PathBuf::from(&worktree.path);
        assert_eq!(path.parent(), Some(repo.as_path()));
        assert!(
            path.join(".git").is_file(),
            "a linked worktree has a .git file"
        );
        assert!(worktree.branch.starts_with(BRANCH_PREFIX));
        assert_eq!(worktree.base, "main");
        assert_eq!(prepared.cwd, path.join("src").display().to_string());
        assert_eq!(
            sh_git(&path, &["rev-parse", "--abbrev-ref", "HEAD"]),
            worktree.branch
        );
        assert_eq!(
            sh_git(&repo, &["status", "--porcelain"]),
            "",
            "the session folder is excluded from status"
        );

        let inside = inspect_folder(worktree.path.clone()).await.unwrap();
        assert!(inside.is_linked_worktree);
        assert_eq!(inside.project.as_deref(), Some(repo.to_str().unwrap()));

        let again = prepare_workspace(PrepareRequest {
            folder: repo.display().to_string(),
            worktree: true,
        })
        .await
        .unwrap();
        assert_ne!(
            again.worktree.unwrap().path,
            worktree.path,
            "a second session gets its own folder"
        );
    }

    #[tokio::test]
    async fn a_plain_folder_refuses_a_worktree_with_a_way_out() {
        if !git_available() {
            return;
        }
        let tmp = TempDir::new("plain");
        let error = prepare_workspace(PrepareRequest {
            folder: tmp.0.display().to_string(),
            worktree: true,
        })
        .await
        .unwrap_err();
        assert!(error.contains("not a git checkout"), "{error}");
        let info = inspect_folder(tmp.0.display().to_string()).await.unwrap();
        assert!(info.repo_root.is_none());
        assert!(info.git_available);
    }
}
