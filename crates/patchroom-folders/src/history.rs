//! Every Claude Code session on this Mac, across all folders, for the History panel.
//!
//! The listing walks each transcript root (`<claude config dir>/projects`) once: one `read_dir`
//! of the root, one per project directory, then a light scan of each `<session id>.jsonl`
//! (a head plus a tail for anything above 256 KB, cached by size and mtime, so a second
//! listing costs one `stat` per file). Files are scanned on a few threads.
//!
//! It is read only, like the rest of this crate. It reports only what the panel shows: a
//! title, the first prompt, the folder, the branch, the model and the newest activity. No
//! other transcript text leaves this module.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::Serialize;

use crate::discover::{is_session_id, LiveState};
use crate::scan::{FileScan, Scanner};

/// Longest title taken from a prompt, in characters.
const TITLE_PROMPT_CHARS: usize = 80;
/// Most scan threads.
const MAX_THREADS: usize = 8;

/// Where a history row's title came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum TitleSource {
    /// The newest `custom-title` line (from `/rename`).
    #[serde(rename = "custom-title")]
    CustomTitle,
    /// The newest `ai-title` line (Claude's own title).
    #[serde(rename = "ai-title")]
    AiTitle,
    /// The first real user prompt.
    #[serde(rename = "prompt")]
    Prompt,
}

/// One session in the History panel.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HistorySession {
    /// The Claude session id (the transcript's file stem).
    pub session_id: String,
    /// Claude's own title when the transcript has one, else the first prompt.
    pub title: String,
    /// Which source gave the title.
    pub title_source: TitleSource,
    /// First real user prompt, one line, at most 200 characters.
    pub first_prompt: String,
    /// The folder the session was launched from. `--resume` runs here.
    pub launch_cwd: String,
    /// The folder the panel groups it under: `launch_cwd`, or the project that holds it when
    /// it is one of Claude's own worktrees (`<project>/.claude/worktrees/<name>`).
    pub folder: String,
    /// Newest git branch seen.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// Newest model id seen.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Newest transcript timestamp, epoch milliseconds.
    pub last_activity: i64,
    /// Real user prompts (approximate for files above 256 KB).
    pub user_turns: u32,
    /// The Patchroom DM that runs this session, once opened.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dm_id: Option<String>,
    /// Whether another process runs it (see [`LiveState`]).
    pub live_state: LiveState,
}

/// The result of one history listing.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryListing {
    /// Newest activity first.
    pub sessions: Vec<HistorySession>,
    /// Transcripts left out: subagent runs, `-p` runs and sessions with no prompt.
    pub skipped: usize,
}

/// Inputs of one history listing.
pub struct HistoryQuery<'a> {
    /// Transcript roots (`<claude config dir>/projects`, plus debug fixtures).
    pub projects_dirs: &'a [PathBuf],
    /// Patchroom DM ids by Claude session id.
    pub dms: &'a HashMap<String, String>,
    /// Session ids that run in another process.
    pub live: &'a std::collections::HashSet<String>,
    /// `live` comes from a fresh check. False reports the rest as `checking`.
    pub live_checked: bool,
}

/// The history listing with its scan cache.
pub struct History {
    scanner: Scanner,
}

impl Default for History {
    fn default() -> Self {
        Self {
            scanner: Scanner::light(),
        }
    }
}

impl History {
    /// A new listing with an empty cache.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Every resumable session under the roots, newest activity first.
    #[must_use]
    pub fn list(&self, q: &HistoryQuery<'_>) -> HistoryListing {
        let files = all_transcripts(q.projects_dirs);
        let scans = self.scan_all(&files);
        let mut by_id: HashMap<String, HistorySession> = HashMap::new();
        let mut skipped = 0;
        for ((_, sid), scan) in files.iter().zip(scans) {
            let Some(scan) = scan else {
                continue;
            };
            let Some(cwd) = scan.launch_cwd.clone() else {
                skipped += 1;
                continue;
            };
            if scan.sidechain || scan.non_interactive || scan.user_turns == 0 {
                skipped += 1;
                continue;
            }
            let (title, title_source) = title_of(&scan);
            let row = HistorySession {
                session_id: sid.clone(),
                title,
                title_source,
                first_prompt: scan.first_prompt.clone(),
                folder: group_folder(&cwd),
                launch_cwd: cwd,
                branch: scan.branch.clone(),
                model: scan.model.clone(),
                last_activity: scan.last_ts_ms.unwrap_or(scan.mtime_ms),
                user_turns: scan.user_turns,
                dm_id: q.dms.get(sid).cloned(),
                live_state: if q.live.contains(sid) {
                    LiveState::Live
                } else if q.live_checked {
                    LiveState::Free
                } else {
                    LiveState::Checking
                },
            };
            match by_id.get(sid) {
                Some(prev) if prev.last_activity >= row.last_activity => {}
                _ => {
                    by_id.insert(sid.clone(), row);
                }
            }
        }
        let mut sessions: Vec<HistorySession> = by_id.into_values().collect();
        sessions.sort_by(|a, b| {
            b.last_activity
                .cmp(&a.last_activity)
                .then_with(|| a.session_id.cmp(&b.session_id))
        });
        self.scanner
            .retain(|p| files.iter().any(|(f, _)| f.as_path() == p));
        HistoryListing { sessions, skipped }
    }

    /// Scan every file, on up to [`MAX_THREADS`] threads. `None` for a file that cannot be read.
    fn scan_all(&self, files: &[(PathBuf, String)]) -> Vec<Option<std::sync::Arc<FileScan>>> {
        let threads = std::thread::available_parallelism()
            .map_or(2, std::num::NonZeroUsize::get)
            .clamp(1, MAX_THREADS);
        let chunk = files.len().div_ceil(threads).max(64);
        let scanner = &self.scanner;
        std::thread::scope(|s| {
            let handles: Vec<_> = files
                .chunks(chunk)
                .map(|part| {
                    s.spawn(move || {
                        part.iter()
                            .map(|(p, _)| scanner.scan(p).ok())
                            .collect::<Vec<_>>()
                    })
                })
                .collect();
            handles
                .into_iter()
                .flat_map(|h| h.join().unwrap_or_default())
                .collect()
        })
    }
}

/// Claude's own title, else the first prompt.
fn title_of(scan: &FileScan) -> (String, TitleSource) {
    let usable = |s: Option<&str>| {
        s.map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    if let Some(t) = usable(scan.custom_title.as_deref()) {
        return (t, TitleSource::CustomTitle);
    }
    if let Some(t) = usable(scan.ai_title.as_deref()) {
        return (t, TitleSource::AiTitle);
    }
    (
        scan.first_prompt.chars().take(TITLE_PROMPT_CHARS).collect(),
        TitleSource::Prompt,
    )
}

/// The project a launch folder belongs to: the part before `/.claude/worktrees/`, which is
/// where Claude Code puts its own worktrees, else the folder itself.
#[must_use]
pub fn group_folder(cwd: &str) -> String {
    let marker = "/.claude/worktrees/";
    match cwd.find(marker) {
        Some(i) if i > 0 => cwd[..i].to_owned(),
        _ => cwd.trim_end_matches('/').to_owned(),
    }
}

/// Every top-level `<session id>.jsonl` under every project directory of every root.
fn all_transcripts(roots: &[PathBuf]) -> Vec<(PathBuf, String)> {
    let mut out = Vec::new();
    for root in roots {
        let Ok(rd) = std::fs::read_dir(root) else {
            continue;
        };
        let mut dirs: Vec<PathBuf> = rd
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
            .map(|e| e.path())
            .collect();
        dirs.sort();
        for dir in dirs {
            let Ok(rd) = std::fs::read_dir(&dir) else {
                continue;
            };
            out.extend(rd.filter_map(Result::ok).filter_map(|e| {
                let path = e.path();
                if !e.file_type().is_ok_and(|t| t.is_file()) {
                    return None;
                }
                let stem = path.file_stem()?.to_str()?.to_owned();
                let ok = path.extension().is_some_and(|x| x == "jsonl")
                    && !stem.starts_with("agent-")
                    && is_session_id(&stem);
                ok.then_some((path, stem))
            }));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encode::encode_dir;
    use std::collections::HashSet;
    use std::io::Write as _;

    fn transcript(root: &std::path::Path, cwd: &str, sid: &str, lines: &[String]) {
        let d = root.join(encode_dir(cwd));
        std::fs::create_dir_all(&d).unwrap();
        let mut f = std::fs::File::create(d.join(format!("{sid}.jsonl"))).unwrap();
        for l in lines {
            f.write_all(l.as_bytes()).unwrap();
            f.write_all(b"\n").unwrap();
        }
    }

    fn user(text: &str, cwd: &str, ts: &str, branch: &str) -> String {
        serde_json::json!({"type": "user", "cwd": cwd, "gitBranch": branch, "entrypoint": "cli",
            "timestamp": ts, "message": {"role": "user", "content": text}})
        .to_string()
    }

    fn listing(roots: &[PathBuf], dms: &HashMap<String, String>) -> HistoryListing {
        History::new().list(&HistoryQuery {
            projects_dirs: roots,
            dms,
            live: &HashSet::new(),
            live_checked: true,
        })
    }

    #[test]
    fn lists_every_folder_with_titles_models_and_branches() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path().join("projects");
        transcript(
            &root,
            "/w/api",
            "s-api",
            &[
                user(
                    "fix the login bug",
                    "/w/api",
                    "2026-03-01T10:00:00Z",
                    "main",
                ),
                serde_json::json!({"type":"assistant","message":{"model":"claude-opus-5-5"}})
                    .to_string(),
                serde_json::json!({"type":"ai-title","aiTitle":"Login bug fix"}).to_string(),
            ],
        );
        transcript(
            &root,
            "/w/web/.claude/worktrees/feat",
            "s-wt",
            &[user(
                "polish the header",
                "/w/web/.claude/worktrees/feat",
                "2026-03-02T10:00:00Z",
                "feat",
            )],
        );
        let dms = HashMap::from([("s-api".to_owned(), "dm-1".to_owned())]);
        let l = listing(&[root], &dms);
        assert_eq!(l.sessions.len(), 2);
        let wt = &l.sessions[0];
        assert_eq!(wt.session_id, "s-wt");
        assert_eq!(wt.folder, "/w/web");
        assert_eq!(wt.launch_cwd, "/w/web/.claude/worktrees/feat");
        assert_eq!(
            (wt.title.as_str(), wt.title_source),
            ("polish the header", TitleSource::Prompt)
        );
        assert!(wt.dm_id.is_none() && wt.model.is_none());
        let api = &l.sessions[1];
        assert_eq!(
            (api.title.as_str(), api.title_source),
            ("Login bug fix", TitleSource::AiTitle)
        );
        assert_eq!(api.first_prompt, "fix the login bug");
        assert_eq!(api.model.as_deref(), Some("claude-opus-5-5"));
        assert_eq!(api.branch.as_deref(), Some("main"));
        assert_eq!(api.dm_id.as_deref(), Some("dm-1"));
    }

    #[test]
    fn skips_subagents_print_runs_and_empty_sessions() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path().join("projects");
        let ts = "2026-03-01T10:00:00Z";
        transcript(&root, "/w", "real", &[user("a prompt", "/w", ts, "main")]);
        transcript(&root, "/w", "agent-x", &[user("sub", "/w", ts, "main")]);
        transcript(
            &root,
            "/w",
            "side",
            &[
                serde_json::json!({"type":"user","isSidechain":true,"cwd":"/w",
                "message":{"content":"task"}})
                .to_string(),
            ],
        );
        transcript(
            &root,
            "/w",
            "print",
            &[
                serde_json::json!({"type":"user","entrypoint":"sdk-cli","cwd":"/w",
                "message":{"content":"-p"}})
                .to_string(),
            ],
        );
        transcript(
            &root,
            "/w",
            "empty",
            &[serde_json::json!({"type":"summary"}).to_string()],
        );
        let l = listing(&[root], &HashMap::new());
        let ids: Vec<&str> = l.sessions.iter().map(|s| s.session_id.as_str()).collect();
        assert_eq!(ids, ["real"]);
        assert_eq!(l.skipped, 3);
    }

    #[test]
    fn worktree_folders_group_under_their_project() {
        assert_eq!(group_folder("/a/b/.claude/worktrees/x"), "/a/b");
        assert_eq!(group_folder("/a/b/.claude/worktrees/x/sub"), "/a/b");
        assert_eq!(group_folder("/a/b/"), "/a/b");
        assert_eq!(group_folder("/a/b"), "/a/b");
    }

    #[test]
    fn a_missing_root_lists_nothing() {
        let d = tempfile::tempdir().unwrap();
        let l = listing(&[d.path().join("nope")], &HashMap::new());
        assert!(l.sessions.is_empty() && l.skipped == 0);
    }
}
