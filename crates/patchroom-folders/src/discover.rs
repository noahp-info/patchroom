//! The session list of one folder section.

use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;

use crate::encode::{dir_may_belong, encode_dir, normalize, rel_path};
use crate::names::Registry;
use crate::scan::Scanner;
use crate::worktrees;

/// Longest session name taken from a prompt, in characters.
const NAME_PROMPT_CHARS: usize = 60;
/// How long `git worktree list` results are reused.
const WORKTREE_TTL: Duration = Duration::from_secs(10);

/// Where a session's name came from, in precedence order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum NameSource {
    /// A name the user set in Patchroom (the DM's name).
    #[serde(rename = "user")]
    User,
    /// The newest entry in the session-naming registry.
    #[serde(rename = "registry")]
    Registry,
    /// The newest `custom-title` line (from `/rename`).
    #[serde(rename = "custom-title")]
    CustomTitle,
    /// The newest `ai-title` line.
    #[serde(rename = "ai-title")]
    AiTitle,
    /// The first real user prompt, cut to 60 characters.
    #[serde(rename = "prompt")]
    Prompt,
}

/// One resumable session, as `folder_sessions` reports it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FolderSession {
    /// The Claude session id (the transcript's file stem).
    pub session_id: String,
    /// Display name.
    pub name: String,
    /// Which source gave the name.
    pub name_source: NameSource,
    /// The folder the session was launched from.
    pub launch_cwd: String,
    /// `launch_cwd` inside the home folder (empty for the folder itself); for a linked
    /// worktree outside it, the worktree's folder name plus any subpath.
    pub rel_path: String,
    /// Newest git branch seen.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// The branch currently checked out in the section's home folder (read only). The UI
    /// shows a branch chip only when `branch` differs from it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_branch: Option<String>,
    /// Newest transcript timestamp, epoch milliseconds.
    pub last_activity: i64,
    /// First real user prompt.
    pub first_prompt: String,
    /// Last user prompt.
    pub last_prompt: String,
    /// Real user prompts.
    pub user_turns: u32,
    /// Running in another terminal (`claude agents --json`).
    pub live_elsewhere: bool,
    /// Noise or hidden by the user.
    pub hidden: bool,
    /// The Patchroom DM that runs this session, once opened.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dm_id: Option<String>,
}

/// The result of one listing.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    /// Newest activity first.
    pub sessions: Vec<FolderSession>,
    /// How many of `sessions` are hidden.
    pub hidden_count: usize,
}

/// Inputs of one listing.
pub struct Query<'a> {
    /// The section's home folder.
    pub home: &'a str,
    /// `<claude config dir>/projects`, plus any extra transcript roots (debug fixtures).
    pub projects_dirs: &'a [PathBuf],
    /// `<claude config dir>/.state/session-names.jsonl`.
    pub registry_path: Option<&'a Path>,
    /// Patchroom DMs by Claude session id: `(dm id, dm name)`.
    pub dms: &'a HashMap<String, (String, String)>,
    /// Sessions the user hid from this section.
    pub hidden: &'a HashSet<String>,
    /// Session ids running in another terminal.
    pub live: &'a HashSet<String>,
}

/// A folder whose sessions belong to the section: the home folder or a linked worktree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Root {
    /// Absolute path (the folder as typed, or its resolved form).
    pub path: String,
    /// The folder as the user knows it: `path` itself, or the typed form of a resolved path.
    /// Sessions are shown and resumed under this spelling (`/tmp/x`, not `/private/tmp/x`).
    pub display: String,
    /// Folder name of a linked worktree outside the home folder; `None` for the home folder.
    pub label: Option<String>,
}

/// Session discovery with its caches.
#[derive(Default)]
pub struct Discovery {
    scanner: Scanner,
    registry: Registry,
    worktrees: Mutex<HashMap<String, (Instant, Vec<String>)>>,
}

impl Discovery {
    /// A new discovery with empty caches.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Every path whose sessions belong to the section of `home`: the folder as given and
    /// resolved (claude files `/tmp/x` sessions under `/private/tmp/x`), and the same for each
    /// linked worktree outside it.
    #[must_use]
    pub fn roots(&self, home: &str) -> Vec<Root> {
        let linked = self.linked(home);
        let mut roots = Vec::new();
        let mut add = |path: &str, label: Option<String>| {
            let display = normalize(path);
            for p in [Some(display.clone()), resolved(path)]
                .into_iter()
                .flatten()
            {
                if !roots.iter().any(|r: &Root| r.path == p) {
                    roots.push(Root {
                        path: p,
                        display: display.clone(),
                        label: label.clone(),
                    });
                }
            }
        };
        add(home, None);
        for w in &linked {
            let label = Path::new(w)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned());
            add(w, label);
        }
        roots
    }

    fn linked(&self, home: &str) -> Vec<String> {
        let mut cache = self
            .worktrees
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some((at, v)) = cache.get(home) {
            if at.elapsed() < WORKTREE_TTL {
                return v.clone();
            }
        }
        let v = worktrees::linked_outside(Path::new(home));
        cache.insert(home.to_owned(), (Instant::now(), v.clone()));
        v
    }

    /// List the section's sessions, newest activity first.
    #[must_use]
    pub fn list(&self, q: &Query<'_>) -> Listing {
        let roots = self.roots(q.home);
        let folder_branch = worktrees::current_branch(Path::new(q.home));
        let registry = q
            .registry_path
            .map(|p| self.registry.names(p))
            .unwrap_or_default();
        let mut by_id: HashMap<String, FolderSession> = HashMap::new();
        for (dir, name) in matching_dirs(q.projects_dirs, &roots) {
            for (path, session_id) in transcripts(&dir) {
                let Ok(scan) = self.scanner.scan(&path) else {
                    continue;
                };
                if scan.sidechain {
                    continue;
                }
                let cwd = match scan.launch_cwd.clone() {
                    Some(c) => c,
                    // An empty start has no cwd; trust the directory when it is exact.
                    None => match roots.iter().find(|r| encode_dir(&r.path) == name) {
                        Some(r) => r.path.clone(),
                        None => continue,
                    },
                };
                let Some((rel, display_cwd)) = place(&roots, &cwd) else {
                    continue;
                };
                let (name, name_source) = name_of(
                    q.dms.get(&session_id).map(|d| d.1.as_str()),
                    registry.get(&session_id).map(String::as_str),
                    &scan,
                    &session_id,
                );
                let noise = scan.user_turns == 0 || scan.non_interactive;
                let s = FolderSession {
                    name,
                    name_source,
                    launch_cwd: display_cwd,
                    rel_path: rel,
                    branch: scan.branch.clone(),
                    folder_branch: folder_branch.clone(),
                    last_activity: scan.last_ts_ms.unwrap_or(scan.mtime_ms),
                    first_prompt: scan.first_prompt.clone(),
                    last_prompt: scan.last_prompt.clone(),
                    user_turns: scan.user_turns,
                    live_elsewhere: q.live.contains(&session_id),
                    hidden: noise || q.hidden.contains(&session_id),
                    dm_id: q.dms.get(&session_id).map(|d| d.0.clone()),
                    session_id: session_id.clone(),
                };
                match by_id.get(&session_id) {
                    Some(prev) if prev.last_activity >= s.last_activity => {}
                    _ => {
                        by_id.insert(session_id, s);
                    }
                }
            }
        }
        let mut sessions: Vec<FolderSession> = by_id.into_values().collect();
        sessions.sort_by(|a, b| {
            b.last_activity
                .cmp(&a.last_activity)
                .then_with(|| a.session_id.cmp(&b.session_id))
        });
        let hidden_count = sessions.iter().filter(|s| s.hidden).count();
        Listing {
            sessions,
            hidden_count,
        }
    }
}

fn resolved(path: &str) -> Option<String> {
    std::fs::canonicalize(path)
        .ok()
        .and_then(|p| p.to_str().map(normalize))
}

/// Which root holds `cwd`: the relative path to show, and `cwd` spelled the way the user
/// knows the root. The home folder (label `None`) wins over a worktree that happens to
/// contain it.
fn place(roots: &[Root], cwd: &str) -> Option<(String, String)> {
    let mut best: Option<(String, String)> = None;
    for r in roots {
        let Some(rel) = rel_path(&r.path, cwd) else {
            continue;
        };
        let shown = match &r.label {
            None => rel.clone(),
            Some(l) if rel.is_empty() => l.clone(),
            Some(l) => format!("{l}/{rel}"),
        };
        let as_typed = if rel.is_empty() {
            r.display.clone()
        } else if r.display == "/" {
            format!("/{rel}")
        } else {
            format!("{}/{rel}", r.display)
        };
        if r.label.is_none() {
            return Some((shown, as_typed));
        }
        best.get_or_insert((shown, as_typed));
    }
    best
}

/// The name of a session by the fixed precedence.
fn name_of(
    dm: Option<&str>,
    registry: Option<&str>,
    scan: &crate::scan::FileScan,
    session_id: &str,
) -> (String, NameSource) {
    let usable = |s: Option<&str>| {
        s.map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    if let Some(n) = usable(dm) {
        return (n, NameSource::User);
    }
    if let Some(n) = usable(registry) {
        return (n, NameSource::Registry);
    }
    if let Some(n) = usable(scan.custom_title.as_deref()) {
        return (n, NameSource::CustomTitle);
    }
    if let Some(n) = usable(scan.ai_title.as_deref()) {
        return (n, NameSource::AiTitle);
    }
    if !scan.first_prompt.is_empty() {
        let cut: String = scan.first_prompt.chars().take(NAME_PROMPT_CHARS).collect();
        return (cut, NameSource::Prompt);
    }
    let short: String = session_id.chars().take(8).collect();
    (format!("Session {short}"), NameSource::Prompt)
}

/// Project directories (and their names) that may hold sessions of the roots.
fn matching_dirs(projects_dirs: &[PathBuf], roots: &[Root]) -> Vec<(PathBuf, String)> {
    let mut out: Vec<(PathBuf, String)> = Vec::new();
    for projects_dir in projects_dirs {
        let Ok(rd) = std::fs::read_dir(projects_dir) else {
            continue;
        };
        out.extend(rd.filter_map(Result::ok).filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let is_dir = e.file_type().is_ok_and(|t| t.is_dir());
            (is_dir && roots.iter().any(|r| dir_may_belong(&name, &r.path)))
                .then(|| (e.path(), name))
        }));
    }
    out.sort();
    out
}

/// Top-level `<session id>.jsonl` files of a project directory. Subagent files
/// (`agent-*.jsonl`) and ids that are not safe to pass to `--resume` are skipped.
fn transcripts(dir: &Path) -> Vec<(PathBuf, String)> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    rd.filter_map(Result::ok)
        .filter_map(|e| {
            let path = e.path();
            if !e.file_type().is_ok_and(|t| t.is_file()) {
                return None;
            }
            let stem = path.file_stem()?.to_str()?.to_owned();
            let ok = path.extension().is_some_and(|x| x == "jsonl")
                && !stem.starts_with("agent-")
                && is_session_id(&stem);
            ok.then_some((path, stem))
        })
        .collect()
}

/// Session ids are UUIDs; accept any short token of letters, digits, `-` and `_` so a typo
/// in a path can never become an argument.
#[must_use]
pub fn is_session_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 80
        && !s.starts_with('-')
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// A cheap fingerprint of the transcripts that belong to the roots: names, sizes and
/// mtimes. It changes when a session starts or a transcript is written. One `read_dir` of the
/// projects directory plus one per matching directory; no file is opened.
#[must_use]
pub fn signature(projects_dirs: &[PathBuf], roots: &[Root]) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    for (dir, name) in matching_dirs(projects_dirs, roots) {
        name.hash(&mut h);
        let mut files: Vec<(String, u64, SystemTime)> = std::fs::read_dir(&dir)
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .filter(|e| e.path().extension().is_some_and(|x| x == "jsonl"))
            .filter_map(|e| {
                let m = e.metadata().ok()?;
                Some((
                    e.file_name().to_string_lossy().into_owned(),
                    m.len(),
                    m.modified().ok()?,
                ))
            })
            .collect();
        files.sort();
        files.hash(&mut h);
    }
    h.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    pub(crate) struct Fx {
        pub dir: tempfile::TempDir,
        pub projects: PathBuf,
        pub projects_dirs: Vec<PathBuf>,
        pub home: String,
    }

    pub(crate) fn fx() -> Fx {
        let dir = tempfile::tempdir().unwrap();
        let projects = dir.path().join("projects");
        std::fs::create_dir_all(&projects).unwrap();
        let home = dir.path().join("work").join("proj");
        std::fs::create_dir_all(&home).unwrap();
        let home = std::fs::canonicalize(&home)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        Fx {
            dir,
            projects_dirs: vec![projects.clone()],
            projects,
            home,
        }
    }

    pub(crate) fn transcript(fx: &Fx, cwd: &str, sid: &str, lines: &[String]) {
        let d = fx.projects.join(encode_dir(cwd));
        std::fs::create_dir_all(&d).unwrap();
        let mut f = std::fs::File::create(d.join(format!("{sid}.jsonl"))).unwrap();
        for l in lines {
            f.write_all(l.as_bytes()).unwrap();
            f.write_all(b"\n").unwrap();
        }
    }

    pub(crate) fn user(text: &str, cwd: &str, ts: &str) -> String {
        serde_json::json!({
            "type": "user", "isSidechain": false, "cwd": cwd, "gitBranch": "main",
            "entrypoint": "cli", "timestamp": ts, "message": {"role": "user", "content": text}
        })
        .to_string()
    }

    fn q<'a>(
        fx: &'a Fx,
        dms: &'a HashMap<String, (String, String)>,
        hidden: &'a HashSet<String>,
        live: &'a HashSet<String>,
    ) -> Query<'a> {
        Query {
            home: &fx.home,
            projects_dirs: &fx.projects_dirs,
            registry_path: None,
            dms,
            hidden,
            live,
        }
    }

    #[test]
    fn lists_home_subfolder_and_worktree_sessions_and_rejects_lookalikes() {
        let fx = fx();
        let h = fx.home.clone();
        let sub = format!("{h}/pkg/a");
        let wt = format!("{h}/.claude/worktrees/feat");
        transcript(
            &fx,
            &h,
            "s-home",
            &[user("home prompt", &h, "2026-03-01T10:00:00Z")],
        );
        transcript(
            &fx,
            &sub,
            "s-sub",
            &[user("sub prompt", &sub, "2026-03-02T10:00:00Z")],
        );
        transcript(
            &fx,
            &wt,
            "s-wt",
            &[user("wt prompt", &wt, "2026-03-03T10:00:00Z")],
        );
        // A sibling folder whose encoded name merely starts with the home's.
        let other = format!("{h}-other");
        transcript(
            &fx,
            &other,
            "s-other",
            &[user("elsewhere", &other, "2026-03-04T10:00:00Z")],
        );
        let (dms, hidden, live) = Default::default();
        let l = Discovery::new().list(&q(&fx, &dms, &hidden, &live));
        let ids: Vec<&str> = l.sessions.iter().map(|s| s.session_id.as_str()).collect();
        assert_eq!(
            ids,
            ["s-wt", "s-sub", "s-home"],
            "newest first, lookalike gone"
        );
        let rel: Vec<&str> = l.sessions.iter().map(|s| s.rel_path.as_str()).collect();
        assert_eq!(rel, [".claude/worktrees/feat", "pkg/a", ""]);
        assert_eq!(l.sessions[2].launch_cwd, h);
        assert_eq!(l.sessions[2].branch.as_deref(), Some("main"));
        assert_eq!(l.hidden_count, 0);
    }

    #[test]
    fn sessions_filed_under_the_resolved_path_show_the_typed_path() {
        let fx = fx();
        // The user typed a symlink to the folder; claude filed its sessions under the real one.
        let link = fx.dir.path().join("link");
        std::os::unix::fs::symlink(&fx.home, &link).unwrap();
        let typed = link.to_string_lossy().into_owned();
        let sub = format!("{}/pkg", fx.home);
        transcript(
            &fx,
            &fx.home,
            "s-home",
            &[user("home", &fx.home, "2026-03-01T10:00:00Z")],
        );
        transcript(
            &fx,
            &sub,
            "s-sub",
            &[user("sub", &sub, "2026-03-02T10:00:00Z")],
        );
        let (dms, hidden, live) = Default::default();
        let mut query = q(&fx, &dms, &hidden, &live);
        query.home = &typed;
        let l = Discovery::new().list(&query);
        let cwds: Vec<&str> = l.sessions.iter().map(|s| s.launch_cwd.as_str()).collect();
        assert_eq!(cwds, [format!("{typed}/pkg"), typed.clone()]);
        assert_eq!(l.sessions[0].rel_path, "pkg");
    }

    #[test]
    fn excludes_sidechains_and_hides_noise() {
        let fx = fx();
        let h = fx.home.clone();
        transcript(
            &fx,
            &h,
            "real",
            &[user("a real prompt", &h, "2026-03-01T10:00:00Z")],
        );
        transcript(
            &fx,
            &h,
            "side",
            &[serde_json::json!({"type":"user","isSidechain":true,"cwd":h,
                "message":{"content":"subagent task"},"timestamp":"2026-03-01T11:00:00Z"})
            .to_string()],
        );
        transcript(
            &fx,
            &h,
            "agent-abc",
            &[user("agent file", &h, "2026-03-01T11:00:00Z")],
        );
        transcript(
            &fx,
            &h,
            "empty",
            &[serde_json::json!({"type":"last-prompt","sessionId":"empty"}).to_string()],
        );
        transcript(
            &fx,
            &h,
            "pmode",
            &[
                serde_json::json!({"type":"user","entrypoint":"sdk-cli","cwd":h,
                "message":{"content":"-p run"},"timestamp":"2026-03-01T12:00:00Z"})
                .to_string(),
            ],
        );
        let (dms, hidden, live) = Default::default();
        let l = Discovery::new().list(&q(&fx, &dms, &hidden, &live));
        let mut seen: Vec<(&str, bool)> = l
            .sessions
            .iter()
            .map(|s| (s.session_id.as_str(), s.hidden))
            .collect();
        seen.sort();
        assert_eq!(seen, [("empty", true), ("pmode", true), ("real", false)]);
        assert_eq!(l.hidden_count, 2);
    }

    #[test]
    fn user_hidden_and_live_and_dm_flags_come_through() {
        let fx = fx();
        let h = fx.home.clone();
        transcript(&fx, &h, "one", &[user("one", &h, "2026-03-01T10:00:00Z")]);
        transcript(&fx, &h, "two", &[user("two", &h, "2026-03-02T10:00:00Z")]);
        let dms = HashMap::from([("two".to_owned(), ("dm-9".to_owned(), "My DM".to_owned()))]);
        let hidden = HashSet::from(["one".to_owned()]);
        let live = HashSet::from(["two".to_owned()]);
        let l = Discovery::new().list(&q(&fx, &dms, &hidden, &live));
        let two = &l.sessions[0];
        assert_eq!(two.session_id, "two");
        assert!(two.live_elsewhere && !two.hidden);
        assert_eq!(two.dm_id.as_deref(), Some("dm-9"));
        assert_eq!(
            (two.name.as_str(), two.name_source),
            ("My DM", NameSource::User)
        );
        let one = &l.sessions[1];
        assert!(one.hidden && !one.live_elsewhere && one.dm_id.is_none());
        assert_eq!(l.hidden_count, 1);
    }

    #[test]
    fn names_follow_the_fixed_precedence() {
        let fx = fx();
        let h = fx.home.clone();
        let long = "x".repeat(100);
        let title =
            |kind: &str, key: &str, v: &str| serde_json::json!({"type": kind, key: v}).to_string();
        // Every name source present on `all`; each later session drops the top one.
        transcript(
            &fx,
            &h,
            "all",
            &[
                user(&long, &h, "2026-03-05T00:00:00Z"),
                title("ai-title", "aiTitle", "AI old"),
                title("custom-title", "customTitle", "Custom old"),
                title("ai-title", "aiTitle", "AI new"),
                title("custom-title", "customTitle", "Custom new"),
            ],
        );
        transcript(
            &fx,
            &h,
            "nocustom",
            &[
                user(&long, &h, "2026-03-04T00:00:00Z"),
                title("ai-title", "aiTitle", "AI old"),
                title("ai-title", "aiTitle", "AI new"),
            ],
        );
        transcript(&fx, &h, "noai", &[user(&long, &h, "2026-03-03T00:00:00Z")]);
        let reg = fx.dir.path().join("session-names.jsonl");
        std::fs::write(
            &reg,
            "{\"session_id\":\"all\",\"name\":\"Reg old\",\"named_at\":\"2026-01-01T00:00:00Z\"}\n\
             {\"session_id\":\"all\",\"name\":\"Reg new\",\"named_at\":\"2026-02-01T00:00:00Z\"}\n",
        )
        .unwrap();
        let (hidden, live) = (HashSet::new(), HashSet::new());
        let mut dms = HashMap::new();
        let mk = |dms: &HashMap<String, (String, String)>| {
            let mut query = q(&fx, dms, &hidden, &live);
            query.registry_path = Some(&reg);
            Discovery::new().list(&query)
        };
        let by = |l: &Listing, id: &str| {
            let s = l.sessions.iter().find(|s| s.session_id == id).unwrap();
            (s.name.clone(), s.name_source)
        };
        let l = mk(&dms);
        assert_eq!(by(&l, "all"), ("Reg new".into(), NameSource::Registry));
        assert_eq!(by(&l, "nocustom"), ("AI new".into(), NameSource::AiTitle));
        assert_eq!(by(&l, "noai"), ("x".repeat(60), NameSource::Prompt));
        // Remove the registry entry: the newest custom-title is next.
        std::fs::write(&reg, "").unwrap();
        let l = mk(&dms);
        assert_eq!(
            by(&l, "all"),
            ("Custom new".into(), NameSource::CustomTitle)
        );
        // A name set in Patchroom beats everything.
        dms.insert("all".into(), ("dm-1".into(), "Mine".into()));
        let l = mk(&dms);
        assert_eq!(by(&l, "all"), ("Mine".into(), NameSource::User));
    }

    #[test]
    fn last_activity_is_the_newest_timestamp_not_the_file_time() {
        let fx = fx();
        let h = fx.home.clone();
        transcript(&fx, &h, "old", &[user("p", &h, "2020-05-06T07:08:09.123Z")]);
        let (dms, hidden, live) = Default::default();
        let l = Discovery::new().list(&q(&fx, &dms, &hidden, &live));
        assert_eq!(l.sessions[0].last_activity, 1_588_748_889_123);
    }

    #[test]
    fn signature_changes_when_a_transcript_appears_or_grows_and_not_otherwise() {
        let fx = fx();
        let h = fx.home.clone();
        let d = Discovery::new();
        let sig = || signature(&fx.projects_dirs, &d.roots(&h));
        let empty = sig();
        transcript(&fx, &h, "a", &[user("p", &h, "2026-03-01T10:00:00Z")]);
        let one = sig();
        assert_ne!(empty, one);
        assert_eq!(one, sig());
        let p = fx.projects.join(encode_dir(&h)).join("a.jsonl");
        let mut f = std::fs::OpenOptions::new().append(true).open(p).unwrap();
        f.write_all(user("more", &h, "2026-03-01T10:01:00Z").as_bytes())
            .unwrap();
        drop(f);
        assert_ne!(one, sig());
        // A session of another folder does not move the signature.
        let before = sig();
        transcript(
            &fx,
            "/elsewhere/x",
            "z",
            &[user("p", "/elsewhere/x", "2026-03-01T10:00:00Z")],
        );
        assert_eq!(before, sig());
    }

    #[test]
    fn a_missing_projects_dir_lists_nothing() {
        let fx = fx();
        let (dms, hidden, live) = Default::default();
        let mut query = q(&fx, &dms, &hidden, &live);
        let gone = [fx.dir.path().join("nope")];
        query.projects_dirs = &gone;
        assert!(Discovery::new().list(&query).sessions.is_empty());
    }
}
