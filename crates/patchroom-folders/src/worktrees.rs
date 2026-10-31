//! Linked git worktrees of a folder, from `git worktree list --porcelain` (read only).

use std::path::Path;
use std::process::{Command, Stdio};

use crate::encode::is_under;

/// Worktree paths named by `git worktree list --porcelain` output.
#[must_use]
pub fn parse_porcelain(out: &str) -> Vec<String> {
    let mut paths = Vec::new();
    let mut cur: Option<String> = None;
    let mut bare = false;
    for line in out.lines().chain(std::iter::once("")) {
        if let Some(p) = line.strip_prefix("worktree ") {
            cur = Some(p.to_owned());
            bare = false;
        } else if line == "bare" {
            bare = true;
        } else if line.is_empty() {
            if let Some(p) = cur.take() {
                if !bare {
                    paths.push(p);
                }
            }
        }
    }
    paths
}

/// The branch checked out in `home` (`git rev-parse --abbrev-ref HEAD`, read only). `None`
/// when `home` is not in a repository, git is missing, or HEAD is detached.
#[must_use]
pub fn current_branch(home: &Path) -> Option<String> {
    let git = if Path::new("/usr/bin/git").is_file() {
        "/usr/bin/git"
    } else {
        "git"
    };
    let out = Command::new(git)
        .arg("-C")
        .arg(home)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let b = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    (!b.is_empty() && b != "HEAD").then_some(b)
}

/// Worktrees of the repository containing `home` that sit outside `home`. A worktree that
/// contains `home` is not one of them. Empty when `home` is not in a repository or git is
/// missing.
#[must_use]
pub fn linked_outside(home: &Path) -> Vec<String> {
    let Some(home_str) = home.to_str() else {
        return Vec::new();
    };
    let git = if Path::new("/usr/bin/git").is_file() {
        "/usr/bin/git"
    } else {
        "git"
    };
    let Ok(out) = Command::new(git)
        .arg("-C")
        .arg(home)
        .args(["worktree", "list", "--porcelain"])
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
    else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    let canon_home = std::fs::canonicalize(home)
        .ok()
        .and_then(|p| p.to_str().map(str::to_owned));
    parse_porcelain(&String::from_utf8_lossy(&out.stdout))
        .into_iter()
        .filter(|w| {
            let contains_home =
                is_under(w, home_str) || canon_home.as_deref().is_some_and(|c| is_under(w, c));
            !contains_home
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_and_skips_bare() {
        let out = "worktree /r/main\nHEAD abc\nbranch refs/heads/main\n\n\
                   worktree /r/wt-a\nHEAD def\nbranch refs/heads/a\n\n\
                   worktree /r/bare.git\nbare\n\n\
                   worktree /r/wt b\nHEAD 123\ndetached\n";
        assert_eq!(parse_porcelain(out), ["/r/main", "/r/wt-a", "/r/wt b"]);
    }

    #[test]
    fn a_plain_folder_has_no_current_branch() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(current_branch(d.path()), None);
    }

    #[test]
    fn current_branch_reads_the_checked_out_branch() {
        let d = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| {
            let st = Command::new("git")
                .arg("-C")
                .arg(d.path())
                .args(args)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@example.com")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@example.com")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap();
            assert!(st.success(), "git {args:?}");
        };
        git(&["init", "-q", "-b", "dev"]);
        git(&["commit", "-q", "--allow-empty", "-m", "i"]);
        assert_eq!(current_branch(d.path()).as_deref(), Some("dev"));
        git(&["checkout", "-q", "-b", "feat/x"]);
        assert_eq!(current_branch(d.path()).as_deref(), Some("feat/x"));
    }

    #[test]
    fn a_plain_folder_has_no_linked_worktrees() {
        let d = tempfile::tempdir().unwrap();
        assert!(linked_outside(d.path()).is_empty());
    }

    #[test]
    fn real_linked_worktrees_outside_the_folder_are_listed() {
        let d = tempfile::tempdir().unwrap();
        let repo = d.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let git = |dir: &Path, args: &[&str]| {
            let st = Command::new("git")
                .arg("-C")
                .arg(dir)
                .args(args)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@example.com")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@example.com")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap();
            assert!(st.success(), "git {args:?}");
        };
        git(&repo, &["init", "-q", "-b", "main"]);
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "i"]);
        let wt = d.path().join("repo-wt");
        git(
            &repo,
            &["worktree", "add", "-q", wt.to_str().unwrap(), "-b", "feat"],
        );
        let got = linked_outside(&repo);
        assert_eq!(got.len(), 1, "{got:?}");
        assert!(got[0].ends_with("repo-wt"));
        // From the worktree's point of view, the main checkout is the outside one.
        let from_wt = linked_outside(&wt);
        assert_eq!(from_wt.len(), 1);
        assert!(from_wt[0].ends_with("repo"));
    }
}
