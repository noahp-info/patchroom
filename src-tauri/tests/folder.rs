//! Folder sections end to end in the manager: discovery over synthetic transcripts, lazy DMs,
//! `claude --resume` from the launch folder, hide, the watcher, restart and read-only checks.
//! Claude is a stub that records its arguments and cwd; the config dir is a temp dir.

mod common;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use patchroom_lib::events::{EventSink, UiEvent};
use patchroom_lib::manager::{Manager, ManagerConfig, SessionManager};
use serde_json::{json, Value};

#[derive(Default)]
struct Sink {
    events: Mutex<Vec<(Instant, UiEvent)>>,
    cv: Condvar,
}

impl EventSink for Sink {
    fn emit(&self, event: UiEvent) {
        self.events.lock().unwrap().push((Instant::now(), event));
        self.cv.notify_all();
    }
}

impl Sink {
    /// Wait for a `folder:changed` event for `section` after `count_before` earlier ones.
    fn wait_changed(&self, section: &str, count_before: usize, timeout: Duration) -> Instant {
        let end = Instant::now() + timeout;
        let mut g = self.events.lock().unwrap();
        loop {
            let hits: Vec<Instant> = g
                .iter()
                .filter(|(_, e)| {
                    e.name() == "folder:changed" && e.payload()["sectionId"] == section
                })
                .map(|(t, _)| *t)
                .collect();
            if hits.len() > count_before {
                return hits[count_before];
            }
            let left = end.saturating_duration_since(Instant::now());
            assert!(!left.is_zero(), "no folder:changed within {timeout:?}");
            g = self.cv.wait_timeout(g, left).unwrap().0;
        }
    }

    fn changed_count(&self, section: &str) -> usize {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, e)| e.name() == "folder:changed" && e.payload()["sectionId"] == section)
            .count()
    }
}

fn hook_bin() -> PathBuf {
    static COPY: OnceLock<(tempfile::TempDir, PathBuf)> = OnceLock::new();
    COPY.get_or_init(|| {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
        let staged = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.path())
            .find(|p| {
                p.file_name()
                    .is_some_and(|n| n.to_string_lossy().starts_with("patchroom-hook-"))
            })
            .expect("build.rs stages binaries/patchroom-hook-<triple>");
        let tmp = tempfile::tempdir().unwrap();
        let copy = tmp.path().join("patchroom-hook");
        std::fs::copy(staged, &copy).unwrap();
        (tmp, copy)
    })
    .1
    .clone()
}

/// A stand-in for `claude`: records its arguments and working directory next to itself, then
/// stays alive.
fn claude_stub(dir: &Path) -> PathBuf {
    let p = dir.join("claude-stub");
    common::write_exe(
        &p,
        &format!(
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{d}/args.txt'\npwd -P > '{d}/cwd.txt'\necho $$ > '{d}/pid.txt'\nsleep 60\n",
            d = dir.display()
        ),
    );
    p
}

struct Env {
    data: tempfile::TempDir,
    config: PathBuf,
    stub_dir: tempfile::TempDir,
    /// Canonical path of the home folder under a temp dir.
    home: PathBuf,
    _root: tempfile::TempDir,
    sink: Arc<Sink>,
    m: SessionManager,
}

fn mk_manager(data: &Path, config: &Path, stub: &Path, sink: &Arc<Sink>) -> SessionManager {
    let mut cfg = ManagerConfig::new(data, hook_bin());
    cfg.claude_program = stub.to_string_lossy().into_owned();
    cfg.shell = Some("/bin/sh".into());
    cfg.kill_grace = Duration::from_millis(300);
    cfg.claude_config_dir = Some(config.to_path_buf());
    Manager::new(cfg, Arc::clone(sink) as Arc<dyn EventSink>).unwrap()
}

fn env() -> Env {
    let data = tempfile::Builder::new()
        .prefix("pr")
        .tempdir_in("/tmp")
        .unwrap();
    let root = tempfile::tempdir().unwrap();
    let base = std::fs::canonicalize(root.path()).unwrap();
    let config = base.join("claude");
    std::fs::create_dir_all(config.join("projects")).unwrap();
    std::fs::create_dir_all(config.join(".state")).unwrap();
    let home = base.join("work").join("proj");
    std::fs::create_dir_all(&home).unwrap();
    let stub_dir = tempfile::tempdir().unwrap();
    let stub = claude_stub(stub_dir.path());
    let sink = Arc::new(Sink::default());
    let m = mk_manager(data.path(), &config, &stub, &sink);
    Env {
        data,
        config,
        stub_dir,
        home,
        _root: root,
        sink,
        m,
    }
}

fn encode(p: &Path) -> String {
    p.to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

impl Env {
    fn transcript(&self, cwd: &Path, sid: &str, lines: &[Value]) -> PathBuf {
        let dir = self.config.join("projects").join(encode(cwd));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{sid}.jsonl"));
        let mut text = String::new();
        for l in lines {
            text += &l.to_string();
            text.push('\n');
        }
        std::fs::write(&path, text).unwrap();
        path
    }

    fn section(&self) -> String {
        self.m
            .section_create_from_folder(self.home.to_str().unwrap(), None)
            .unwrap()
    }

    fn pid_file(&self) -> PathBuf {
        self.stub_dir.path().join("pid.txt")
    }

    fn wait_file(&self, name: &str) -> String {
        let p = self.stub_dir.path().join(name);
        let end = Instant::now() + Duration::from_secs(10);
        loop {
            if let Ok(t) = std::fs::read_to_string(&p) {
                if !t.is_empty() {
                    return t;
                }
            }
            assert!(Instant::now() < end, "stub never wrote {name}");
            std::thread::sleep(Duration::from_millis(30));
        }
    }
}

fn user(text: &str, cwd: &Path, ts: &str) -> Value {
    json!({"type":"user","isSidechain":false,"cwd":cwd,"gitBranch":"main","entrypoint":"cli",
        "timestamp":ts,"origin":{"kind":"human"},"message":{"role":"user","content":text}})
}

fn tree_hashes(dir: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut out = BTreeMap::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else {
                out.insert(p.clone(), std::fs::read(&p).unwrap());
            }
        }
    }
    out
}

#[test]
fn a_folder_section_keeps_its_folder_and_archive_days_across_a_restart() {
    let e = env();
    let id = e.section();
    let list = e.m.sections().unwrap();
    let s = list.iter().find(|s| s.id == id).unwrap();
    assert_eq!(s.folder.as_deref(), e.home.to_str());
    assert_eq!(s.archive_days, 14);
    assert_eq!(s.name, "proj");
    let json = serde_json::to_value(s).unwrap();
    assert_eq!(json["archiveDays"], 14);
    assert!(list
        .iter()
        .filter(|s| s.id != id)
        .all(|s| s.folder.is_none()));
    e.m.section_set_archive_days(&id, 30).unwrap();
    assert!(e.m.section_set_archive_days(&id, 0).is_err());
    assert!(e
        .m
        .section_create_from_folder("/definitely/not/a/folder", None)
        .is_err());
    assert!(e
        .m
        .section_create_from_folder("relative/path", None)
        .is_err());
    let named =
        e.m.section_create_from_folder(e.home.to_str().unwrap(), Some("Mine"))
            .unwrap();
    assert!(e
        .m
        .sections()
        .unwrap()
        .iter()
        .any(|s| s.id == named && s.name == "Mine"));
    e.m.shutdown();
    let sink = Arc::new(Sink::default());
    let m2 = mk_manager(
        e.data.path(),
        &e.config,
        &e.stub_dir.path().join("claude-stub"),
        &sink,
    );
    let again = m2.sections().unwrap();
    let s = again.iter().find(|s| s.id == id).unwrap();
    assert_eq!((s.folder.as_deref(), s.archive_days), (e.home.to_str(), 30));
    m2.shutdown();
}

#[test]
fn listing_is_lazy_and_open_resumes_from_the_launch_folder_through_the_shell() {
    let e = env();
    let sub = e.home.join("pkg").join("a");
    std::fs::create_dir_all(&sub).unwrap();
    e.transcript(
        &e.home,
        "aaaaaaaa-0000-4000-8000-000000000001",
        &[user("fix the login bug", &e.home, "2026-03-01T10:00:00Z")],
    );
    e.transcript(
        &sub,
        "aaaaaaaa-0000-4000-8000-000000000002",
        &[
            user("sub work", &sub, "2026-03-02T10:00:00Z"),
            json!({"type":"custom-title","customTitle":"Renamed in claude"}),
        ],
    );
    let before = tree_hashes(&e.config);
    let sec = e.section();
    let dms_before = e.m.list().unwrap().len();
    let l = e.m.folder_sessions(&sec).unwrap();
    assert_eq!(l.sessions.len(), 2);
    assert_eq!(l.hidden_count, 0);
    assert_eq!(l.sessions[0].name, "Renamed in claude");
    assert_eq!(l.sessions[0].rel_path, "pkg/a");
    assert_eq!(l.sessions[1].name, "fix the login bug");
    assert!(l.sessions.iter().all(|s| s.dm_id.is_none()));
    // Nothing started and no DM row exists yet.
    assert_eq!(e.m.list().unwrap().len(), dms_before);
    assert!(!e.pid_file().exists());

    let info =
        e.m.folder_session_open(&sec, "aaaaaaaa-0000-4000-8000-000000000002")
            .unwrap();
    assert_eq!(info.section_id.as_deref(), Some(sec.as_str()));
    assert_eq!(info.name, "Renamed in claude");
    assert_eq!(
        info.claude_session_id.as_deref(),
        Some("aaaaaaaa-0000-4000-8000-000000000002")
    );
    assert_eq!(info.folder_chip, None);
    let args = e.wait_file("args.txt");
    let args: Vec<&str> = args.lines().collect();
    assert_eq!(
        &args[..2],
        ["--resume", "aaaaaaaa-0000-4000-8000-000000000002"]
    );
    assert!(
        args.contains(&"--settings"),
        "per-launch hooks are injected"
    );
    assert_eq!(
        e.wait_file("cwd.txt").trim(),
        sub.to_str().unwrap(),
        "resume starts in the launch folder"
    );

    // Listed again, the row knows its DM; opening again is the same DM and the same process.
    let l = e.m.folder_sessions(&sec).unwrap();
    let row = l.sessions.iter().find(|s| s.dm_id.is_some()).unwrap();
    assert_eq!(row.dm_id.as_deref(), Some(info.id.as_str()));
    assert_eq!(serde_json::to_value(row.name_source).unwrap(), "user");
    let pid = e.m.pid_of(&info.id).unwrap();
    let again =
        e.m.folder_session_open(&sec, "aaaaaaaa-0000-4000-8000-000000000002")
            .unwrap();
    assert_eq!(again.id, info.id);
    assert_eq!(e.m.pid_of(&info.id), Some(pid), "no second process");
    assert_eq!(e.m.list().unwrap().len(), dms_before + 1);
    assert!(e.m.folder_session_open(&sec, "no-such-session").is_err());
    assert!(e.m.folder_session_open(&sec, "../etc/passwd").is_err());
    assert_eq!(e.m.list().unwrap().len(), dms_before + 1);

    assert_eq!(
        before,
        tree_hashes(&e.config),
        "the config dir is only read"
    );
    e.m.shutdown();
}

#[test]
fn a_failed_spawn_leaves_no_dm_row() {
    let e = env();
    let gone = e.home.join("gone");
    std::fs::create_dir_all(&gone).unwrap();
    e.transcript(
        &gone,
        "bbbbbbbb-0000-4000-8000-000000000001",
        &[user(
            "work in a folder that vanishes",
            &gone,
            "2026-03-01T10:00:00Z",
        )],
    );
    let sec = e.section();
    let l = e.m.folder_sessions(&sec).unwrap();
    assert_eq!(l.sessions.len(), 1);
    std::fs::remove_dir_all(&gone).unwrap();
    let n = e.m.list().unwrap().len();
    let err =
        e.m.folder_session_open(&sec, "bbbbbbbb-0000-4000-8000-000000000001")
            .unwrap_err()
            .to_string();
    assert!(err.contains("no longer exists"), "{err}");
    assert_eq!(e.m.list().unwrap().len(), n);
    e.m.shutdown();
}

#[test]
fn hide_removes_a_row_from_the_list_only_and_survives_restart() {
    let e = env();
    let t = e.transcript(
        &e.home,
        "cccccccc-0000-4000-8000-000000000001",
        &[user("keep me on disk", &e.home, "2026-03-01T10:00:00Z")],
    );
    let bytes = std::fs::read(&t).unwrap();
    let sec = e.section();
    let before = e.sink.changed_count(&sec);
    e.m.folder_session_hide(&sec, "cccccccc-0000-4000-8000-000000000001", true)
        .unwrap();
    assert!(e.sink.changed_count(&sec) > before);
    let l = e.m.folder_sessions(&sec).unwrap();
    assert_eq!((l.sessions.len(), l.hidden_count), (1, 1));
    assert!(l.sessions[0].hidden);
    assert_eq!(bytes, std::fs::read(&t).unwrap(), "transcript untouched");
    e.m.folder_session_hide(&sec, "cccccccc-0000-4000-8000-000000000001", false)
        .unwrap();
    let l = e.m.folder_sessions(&sec).unwrap();
    assert_eq!(l.hidden_count, 0);
    e.m.folder_session_hide(&sec, "cccccccc-0000-4000-8000-000000000001", true)
        .unwrap();
    e.m.shutdown();
    let sink = Arc::new(Sink::default());
    let m2 = mk_manager(
        e.data.path(),
        &e.config,
        &e.stub_dir.path().join("claude-stub"),
        &sink,
    );
    assert_eq!(m2.folder_sessions(&sec).unwrap().hidden_count, 1);
    m2.shutdown();
}

#[test]
fn a_session_started_elsewhere_raises_folder_changed_within_two_seconds() {
    let e = env();
    e.transcript(
        &e.home,
        "dddddddd-0000-4000-8000-000000000001",
        &[user("first", &e.home, "2026-03-01T10:00:00Z")],
    );
    let sec = e.section();
    assert_eq!(e.m.folder_sessions(&sec).unwrap().sessions.len(), 1);
    // Let the watcher settle, then start a session "in iTerm".
    std::thread::sleep(Duration::from_millis(300));
    let n = e.sink.changed_count(&sec);
    let t0 = Instant::now();
    e.transcript(
        &e.home,
        "dddddddd-0000-4000-8000-000000000002",
        &[user("started elsewhere", &e.home, "2026-03-02T10:00:00Z")],
    );
    let at = e.sink.wait_changed(&sec, n, Duration::from_secs(4));
    let took = at.duration_since(t0);
    assert!(took < Duration::from_secs(2), "took {took:?}");
    let l = e.m.folder_sessions(&sec).unwrap();
    assert_eq!(l.sessions.len(), 2);
    assert_eq!(l.sessions[0].first_prompt, "started elsewhere");
    // An update to an existing transcript is noticed too.
    let n = e.sink.changed_count(&sec);
    let path = e
        .config
        .join("projects")
        .join(encode(&e.home))
        .join("dddddddd-0000-4000-8000-000000000001.jsonl");
    let mut f = std::fs::OpenOptions::new().append(true).open(path).unwrap();
    std::io::Write::write_all(
        &mut f,
        format!("{}\n", user("more", &e.home, "2026-03-03T10:00:00Z")).as_bytes(),
    )
    .unwrap();
    drop(f);
    let t0 = Instant::now();
    let at = e.sink.wait_changed(&sec, n, Duration::from_secs(4));
    assert!(at.duration_since(t0) < Duration::from_secs(2));
    // Quiet when nothing changes.
    let n = e.sink.changed_count(&sec);
    std::thread::sleep(Duration::from_millis(2500));
    assert_eq!(e.sink.changed_count(&sec), n, "no change, no event");
    e.m.shutdown();
}

#[test]
fn live_elsewhere_comes_from_the_agents_listing_and_not_for_our_own_dms() {
    let e = env();
    e.transcript(
        &e.home,
        "eeeeeeee-0000-4000-8000-000000000001",
        &[user("running in iTerm", &e.home, "2026-03-01T10:00:00Z")],
    );
    e.transcript(
        &e.home,
        "eeeeeeee-0000-4000-8000-000000000002",
        &[user("ours", &e.home, "2026-03-02T10:00:00Z")],
    );
    let sec = e.section();
    e.m.set_folder_live_override(Some(
        [
            "eeeeeeee-0000-4000-8000-000000000001",
            "eeeeeeee-0000-4000-8000-000000000002",
        ]
        .map(String::from)
        .into(),
    ));
    let l = e.m.folder_sessions(&sec).unwrap();
    assert!(l.sessions.iter().all(|s| s.live_elsewhere));
    // The second one stops running elsewhere; once we run it ourselves it is no longer
    // "elsewhere". (Opening a session that does run elsewhere mirrors it instead of spawning:
    // see tests/session_parity.rs.)
    e.m.set_folder_live_override(Some(
        ["eeeeeeee-0000-4000-8000-000000000001"]
            .map(String::from)
            .into(),
    ));
    e.m.folder_session_open(&sec, "eeeeeeee-0000-4000-8000-000000000002")
        .unwrap();
    let l = e.m.folder_sessions(&sec).unwrap();
    let ours = l.sessions.iter().find(|s| s.dm_id.is_some()).unwrap();
    assert!(!ours.live_elsewhere);
    assert!(l.sessions.iter().any(|s| s.live_elsewhere));
    e.m.shutdown();
}

#[test]
fn a_dm_from_another_folder_shows_a_chip_and_is_never_respawned() {
    let e = env();
    let other = e.home.parent().unwrap().join("knowfirst");
    std::fs::create_dir_all(&other).unwrap();
    let sec = e.section();
    let dm =
        e.m.create(&patchroom_lib::manager::CreateRequest {
            cwd: other.to_string_lossy().into_owned(),
            command: Some("sh".into()),
            args: Some(vec!["-c".into(), "sleep 30".into()]),
            name: Some("kf".into()),
            ..patchroom_lib::manager::CreateRequest::default()
        })
        .unwrap();
    let inside =
        e.m.create(&patchroom_lib::manager::CreateRequest {
            cwd: e.home.to_string_lossy().into_owned(),
            command: Some("sh".into()),
            args: Some(vec!["-c".into(), "sleep 30".into()]),
            name: Some("in".into()),
            ..patchroom_lib::manager::CreateRequest::default()
        })
        .unwrap();
    let pid = e.m.pid_of(&dm).unwrap();
    e.m.set_section(&dm, Some(&sec)).unwrap();
    e.m.set_section(&inside, Some(&sec)).unwrap();
    let list = e.m.list().unwrap();
    let chip = |id: &str| {
        list.iter()
            .find(|s| s.id == id)
            .unwrap()
            .folder_chip
            .clone()
    };
    assert_eq!(chip(&dm).as_deref(), Some("knowfirst"));
    assert_eq!(chip(&inside), None);
    assert_eq!(
        serde_json::to_value(list.iter().find(|s| s.id == dm).unwrap()).unwrap()["folderChip"],
        "knowfirst"
    );
    assert_eq!(e.m.pid_of(&dm), Some(pid), "filing a DM never respawns it");
    // Moved out again: no chip (a plain section has no folder).
    e.m.set_section(&dm, None).unwrap();
    assert_eq!(
        e.m.list()
            .unwrap()
            .iter()
            .find(|s| s.id == dm)
            .unwrap()
            .folder_chip,
        None
    );
    e.m.shutdown();
}

#[test]
fn three_hundred_sessions_list_in_under_300_ms_through_the_manager() {
    let e = env();
    let wt = e.home.join(".claude").join("worktrees").join("feat");
    let sub = e.home.join("pkg");
    std::fs::create_dir_all(&wt).unwrap();
    std::fs::create_dir_all(&sub).unwrap();
    let filler =
        json!({"type":"assistant","timestamp":"2026-03-01T10:00:01Z","m":"y".repeat(1500)});
    for i in 0..310 {
        let cwd = match i % 3 {
            0 => &e.home,
            1 => &sub,
            _ => &wt,
        };
        let sid = format!("{i:08x}-0000-4000-8000-000000000000");
        let mut lines = vec![user(&format!("prompt {i}"), cwd, "2026-03-01T10:00:00Z")];
        for _ in 0..20 {
            lines.push(filler.clone());
        }
        e.transcript(cwd, &sid, &lines);
    }
    let sec = e.section();
    // A cold listing needs an empty scan cache, and each manager owns its own. Time the cold
    // listing on up to five fresh managers over the same files and keep the best, so one
    // scheduling stall on a loaded machine cannot fail the test. The threshold stays 300 ms.
    let stub = e.stub_dir.path().join("claude-stub");
    let mut cold = Duration::MAX;
    let mut current: Option<SessionManager> = None;
    let mut listed = 0;
    for attempt in 0..5 {
        let m = if attempt == 0 {
            None
        } else {
            match current.take() {
                Some(prev) => prev.shutdown(),
                None => e.m.shutdown(),
            }
            Some(mk_manager(e.data.path(), &e.config, &stub, &e.sink))
        };
        let mgr = m.as_ref().unwrap_or(&e.m);
        let t0 = Instant::now();
        let l = mgr.folder_sessions(&sec).unwrap();
        cold = cold.min(t0.elapsed());
        listed = l.sessions.len();
        // Warm: the same manager again, best of three.
        let mut warm = Duration::MAX;
        for _ in 0..3 {
            let t1 = Instant::now();
            let _ = mgr.folder_sessions(&sec).unwrap();
            warm = warm.min(t1.elapsed());
        }
        eprintln!("300 sessions: cold {cold:?} (best so far), warm {warm:?}");
        assert!(warm < Duration::from_millis(100), "warm {warm:?}");
        current = m;
        if cold < Duration::from_millis(300) {
            break;
        }
    }
    assert_eq!(listed, 310);
    assert!(cold < Duration::from_millis(300), "cold {cold:?}");
    match current {
        Some(m) => m.shutdown(),
        None => e.m.shutdown(),
    }
}

#[test]
fn extra_transcript_roots_are_listed_and_watched_like_the_config_dir() {
    let e = env();
    let extra = tempfile::tempdir().unwrap();
    let extra_root = std::fs::canonicalize(extra.path()).unwrap();
    e.m.shutdown();
    let sink = Arc::new(Sink::default());
    let mut cfg = ManagerConfig::new(e.data.path(), hook_bin());
    cfg.claude_program = e
        .stub_dir
        .path()
        .join("claude-stub")
        .to_string_lossy()
        .into_owned();
    cfg.shell = Some("/bin/sh".into());
    cfg.claude_config_dir = Some(e.config.clone());
    cfg.extra_projects_dirs = vec![extra_root.clone()];
    let m = Manager::new(cfg, Arc::clone(&sink) as Arc<dyn EventSink>).unwrap();
    let dir = extra_root.join(encode(&e.home));
    std::fs::create_dir_all(&dir).unwrap();
    let write = |sid: &str, ts: &str| {
        std::fs::write(
            dir.join(format!("{sid}.jsonl")),
            format!("{}\n", user("a fixture session", &e.home, ts)),
        )
        .unwrap();
    };
    write(
        "ffffffff-0000-4000-8000-000000000001",
        "2020-01-01T00:00:00Z",
    );
    let sec = m
        .section_create_from_folder(e.home.to_str().unwrap(), None)
        .unwrap();
    let l = m.folder_sessions(&sec).unwrap();
    assert_eq!(l.sessions.len(), 1);
    assert_eq!(l.sessions[0].last_activity, 1_577_836_800_000);
    // The watcher sees a new file in the extra root too.
    let n = sink.changed_count(&sec);
    write(
        "ffffffff-0000-4000-8000-000000000002",
        "2020-01-02T00:00:00Z",
    );
    sink.wait_changed(&sec, n, Duration::from_secs(4));
    assert_eq!(m.folder_sessions(&sec).unwrap().sessions.len(), 2);
    m.shutdown();
}

#[test]
fn folder_sessions_report_the_folders_current_branch_read_only() {
    let e = env();
    e.transcript(
        &e.home,
        "aaaaaaaa-0000-4000-8000-000000000011",
        &[user("on main", &e.home, "2026-03-01T10:00:00Z")],
    );
    let sec = e.section();
    // Not a repository: no folder branch.
    let l = e.m.folder_sessions(&sec).unwrap();
    assert_eq!(l.sessions[0].folder_branch, None);
    assert!(serde_json::to_value(&l.sessions[0])
        .unwrap()
        .get("folderBranch")
        .is_none());
    let git = |args: &[&str]| {
        let st = std::process::Command::new("git")
            .arg("-C")
            .arg(&e.home)
            .args(args)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(st.success(), "git {args:?}");
    };
    git(&["init", "-q", "-b", "dev"]);
    git(&["commit", "-q", "--allow-empty", "-m", "i"]);
    let l = e.m.folder_sessions(&sec).unwrap();
    assert_eq!(l.sessions[0].folder_branch.as_deref(), Some("dev"));
    assert_eq!(l.sessions[0].branch.as_deref(), Some("main"));
    let json = serde_json::to_value(&l.sessions[0]).unwrap();
    assert_eq!(json["folderBranch"], "dev");
    git(&["checkout", "-q", "-b", "feat/x"]);
    let l = e.m.folder_sessions(&sec).unwrap();
    assert_eq!(l.sessions[0].folder_branch.as_deref(), Some("feat/x"));
}

#[test]
fn dividers_and_emoji_survive_a_restart_and_serialize_for_the_ui() {
    let e = env();
    let work = e.m.create_section_of("Work", None, Some("🚀")).unwrap();
    let div =
        e.m.create_section_of("Later", Some("divider"), None)
            .unwrap();
    let bare = e.m.create_section_of("", Some("divider"), None).unwrap();
    assert!(e.m.create_section_of("", None, None).is_err());
    assert!(e.m.create_section_of("x", Some("bogus"), None).is_err());
    e.m.set_section_emoji(&div, Some("📦")).unwrap();
    e.m.set_section_emoji(&work, None).unwrap();
    e.m.set_section_emoji(&work, Some("🔥")).unwrap();
    let list = e.m.sections().unwrap();
    let by = |id: &str| list.iter().find(|s| s.id == id).unwrap().clone();
    assert_eq!(
        (by(&work).kind.as_str(), by(&work).emoji.as_deref()),
        ("section", Some("🔥"))
    );
    assert_eq!(
        (by(&div).kind.as_str(), by(&div).emoji.as_deref()),
        ("divider", Some("📦"))
    );
    assert_eq!(by(&bare).name, "");
    let json = serde_json::to_value(by(&div)).unwrap();
    assert_eq!(
        (json["kind"].as_str(), json["emoji"].as_str()),
        (Some("divider"), Some("📦"))
    );
    // A divider takes no DMs, and deleting it leaves the sections alone.
    let dm = e.m.list().unwrap();
    if let Some(d) = dm.first() {
        assert!(e.m.set_section(&d.id, Some(&div)).is_err());
    }
    e.m.section_delete(&bare).unwrap();
    assert!(e.m.sections().unwrap().iter().any(|s| s.id == work));
    e.m.shutdown();
    let sink = Arc::new(Sink::default());
    let m2 = mk_manager(
        e.data.path(),
        &e.config,
        &e.stub_dir.path().join("claude-stub"),
        &sink,
    );
    let again = m2.sections().unwrap();
    let s = again.iter().find(|s| s.id == div).unwrap();
    assert_eq!(
        (s.kind.as_str(), s.emoji.as_deref(), s.name.as_str()),
        ("divider", Some("📦"), "Later")
    );
    let s = again.iter().find(|s| s.id == work).unwrap();
    assert_eq!(
        (s.kind.as_str(), s.emoji.as_deref()),
        ("section", Some("🔥"))
    );
    assert!(again.iter().all(|s| s.id != bare));
    m2.shutdown();
}

#[test]
fn history_lists_every_folder_read_only_and_opens_with_resume_in_the_launch_folder() {
    let e = env();
    let other = e.home.parent().unwrap().join("other");
    let wt = other.join(".claude").join("worktrees").join("feat");
    std::fs::create_dir_all(&wt).unwrap();
    e.transcript(
        &e.home,
        "dddddddd-0000-4000-8000-000000000001",
        &[
            user("fix the login bug", &e.home, "2026-03-01T10:00:00Z"),
            json!({"type":"assistant","message":{"model":"claude-opus-5-5"}}),
            json!({"type":"ai-title","aiTitle":"Login bug fix"}),
        ],
    );
    e.transcript(
        &wt,
        "dddddddd-0000-4000-8000-000000000002",
        &[user("polish the header", &wt, "2026-03-02T10:00:00Z")],
    );
    let sec = e.section();
    let before = tree_hashes(&e.config);
    let l = e.m.history_sessions().unwrap();
    assert_eq!(l.sessions.len(), 2);
    let feat = &l.sessions[0];
    assert_eq!(feat.title, "polish the header");
    assert_eq!(feat.folder, other.to_string_lossy());
    let bug = &l.sessions[1];
    assert_eq!(bug.title, "Login bug fix");
    assert_eq!(bug.first_prompt, "fix the login bug");
    assert_eq!(bug.model.as_deref(), Some("claude-opus-5-5"));
    assert!(l.sessions.iter().all(|s| s.dm_id.is_none()));
    // Only the fields the panel shows go out: no last prompt, no other transcript text.
    let row = serde_json::to_value(bug).unwrap();
    let mut keys: Vec<&str> = row
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "branch",
            "firstPrompt",
            "folder",
            "lastActivity",
            "launchCwd",
            "liveState",
            "model",
            "sessionId",
            "title",
            "titleSource",
            "userTurns"
        ]
    );
    assert!(!e.pid_file().exists(), "listing started nothing");

    // Opening a row under a folder section files the DM there and resumes in its folder.
    let info =
        e.m.history_session_open("dddddddd-0000-4000-8000-000000000001", false)
            .unwrap();
    assert_eq!(info.section_id.as_deref(), Some(sec.as_str()));
    assert_eq!(info.name, "Login bug fix");
    let args = e.wait_file("args.txt");
    assert!(args.contains("--resume\ndddddddd-0000-4000-8000-000000000001"));
    assert_eq!(e.wait_file("cwd.txt").trim(), e.home.to_string_lossy());
    // A second open returns the same DM.
    let again =
        e.m.history_session_open("dddddddd-0000-4000-8000-000000000001", false)
            .unwrap();
    assert_eq!(again.id, info.id);
    let l = e.m.history_sessions().unwrap();
    assert_eq!(l.sessions[1].dm_id.as_deref(), Some(info.id.as_str()));
    // A row outside every folder section is ungrouped.
    let wt_dm =
        e.m.history_session_open("dddddddd-0000-4000-8000-000000000002", false)
            .unwrap();
    assert_eq!(wt_dm.section_id, None);
    assert!(e.m.history_session_open("no-such-session", false).is_err());
    assert!(e.m.history_session_open("../etc/passwd", false).is_err());
    assert_eq!(
        before,
        tree_hashes(&e.config),
        "nothing written under the config dir"
    );
    e.m.shutdown();
}
