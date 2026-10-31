//! How Claude Code names a project directory, and path containment tests.

/// Claude's project directory name for a launch folder: every character that is not an ASCII
/// letter or digit becomes `-` (`/a/b.c` is `-a-b-c`).
#[must_use]
pub fn encode_dir(path: &str) -> String {
    path.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// The path without trailing slashes (the root stays `/`).
#[must_use]
pub fn normalize(path: &str) -> String {
    let t = path.trim_end_matches('/');
    if t.is_empty() && path.starts_with('/') {
        "/".into()
    } else {
        t.to_owned()
    }
}

/// Is `path` equal to `root` or inside it? Compared by whole path components.
#[must_use]
pub fn is_under(root: &str, path: &str) -> bool {
    rel_path(root, path).is_some()
}

/// `path` relative to `root` (empty when equal), or `None` when it is outside.
#[must_use]
pub fn rel_path(root: &str, path: &str) -> Option<String> {
    let (root, path) = (normalize(root), normalize(path));
    if root == path {
        return Some(String::new());
    }
    let prefix = if root == "/" {
        "/".to_owned()
    } else {
        format!("{root}/")
    };
    path.strip_prefix(&prefix).map(str::to_owned)
}

/// Does a project directory name belong to `root` or to a folder inside it? Encoding loses
/// information (`/a/b-c` and `/a/b/c` collide), so this only selects candidates; the launch
/// folder inside each transcript decides.
#[must_use]
pub fn dir_may_belong(dir_name: &str, root: &str) -> bool {
    let enc = encode_dir(&normalize(root));
    dir_name == enc
        || dir_name
            .strip_prefix(&enc)
            .is_some_and(|r| r.starts_with('-'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_like_claude() {
        assert_eq!(
            encode_dir("/Users/alex/temp/patchroom"),
            "-Users-alex-temp-patchroom"
        );
        assert_eq!(
            encode_dir("/a/.claude/worktrees/x_y"),
            "-a--claude-worktrees-x-y"
        );
    }

    #[test]
    fn containment_is_by_component() {
        assert!(is_under("/a/b", "/a/b"));
        assert!(is_under("/a/b/", "/a/b/c/d"));
        assert!(!is_under("/a/b", "/a/bc"));
        assert!(!is_under("/a/b", "/a"));
        assert!(is_under("/", "/x"));
        assert_eq!(rel_path("/a/b", "/a/b/c/d").as_deref(), Some("c/d"));
        assert_eq!(rel_path("/a/b", "/a/b").as_deref(), Some(""));
        assert_eq!(rel_path("/a/b", "/z"), None);
    }

    #[test]
    fn candidate_dirs_include_subfolders_and_collisions() {
        let root = "/w/proj";
        assert!(dir_may_belong("-w-proj", root));
        assert!(dir_may_belong("-w-proj--claude-worktrees-x", root));
        assert!(dir_may_belong("-w-proj-sub", root));
        // A sibling that merely shares the prefix is a candidate; the transcript cwd rejects it.
        assert!(dir_may_belong("-w-proj-other", root));
        assert!(!dir_may_belong("-w-projx", root));
        assert!(!dir_may_belong("-w", root));
    }
}
