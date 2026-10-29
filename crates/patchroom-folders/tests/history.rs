//! The History listing over synthetic transcript roots: the 300-session perf bar the folder
//! listing keeps, a few thousand sessions, and proof that nothing under the roots changes.
//! Nothing here is copied from a real transcript.

use std::collections::{HashMap, HashSet};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime};

use patchroom_folders::encode::encode_dir;
use patchroom_folders::{History, HistoryListing, HistoryQuery, TitleSource};
use serde_json::json;

fn write(root: &Path, cwd: &str, sid: &str, lines: &[String]) {
    let d = root.join(encode_dir(cwd));
    std::fs::create_dir_all(&d).unwrap();
    let mut f = std::fs::File::create(d.join(format!("{sid}.jsonl"))).unwrap();
    for l in lines {
        f.write_all(l.as_bytes()).unwrap();
        f.write_all(b"\n").unwrap();
    }
}

/// `n` sessions spread over 30 folders, each a few kilobytes, with titles, models, branches
/// and some worktrees.
fn build(n: usize) -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("projects");
    for i in 0..n {
        let folder = format!("/Users/alex/code/proj-{:02}", i % 30);
        let cwd = if i % 7 == 0 {
            format!("{folder}/.claude/worktrees/wt-{i}")
        } else {
            folder.clone()
        };
        let ts = format!("2026-{:02}-{:02}T10:00:00Z", 1 + i % 9, 1 + i % 27);
        let mut lines = vec![json!({"type":"user","cwd":cwd,"gitBranch":format!("b-{}", i % 5),
            "entrypoint":"cli","timestamp":ts,"message":{"content":format!("prompt of session {i}")}})
        .to_string()];
        for _ in 0..3 {
            lines.push(
                json!({"type":"assistant","timestamp":ts,"message":{
                    "model": if i % 2 == 0 { "claude-opus-5-5" } else { "claude-sonnet-4-6" },
                    "content":"y".repeat(1500)}})
                .to_string(),
            );
        }
        if i % 3 == 0 {
            lines.push(json!({"type":"ai-title","aiTitle":format!("Title {i}")}).to_string());
        }
        write(
            &root,
            &cwd,
            &format!("{i:08x}-0000-4000-8000-{i:012x}"),
            &lines,
        );
    }
    (dir, root)
}

fn list(h: &History, roots: &[PathBuf]) -> HistoryListing {
    h.list(&HistoryQuery {
        projects_dirs: roots,
        dms: &HashMap::new(),
        live: &HashSet::new(),
        live_checked: true,
    })
}

/// Paths, sizes, mtimes and bytes of everything under `root`.
fn snapshot(root: &Path) -> Vec<(PathBuf, u64, SystemTime, Vec<u8>)> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).unwrap() {
            let e = e.unwrap();
            let m = e.metadata().unwrap();
            if m.is_dir() {
                stack.push(e.path());
            } else {
                out.push((
                    e.path(),
                    m.len(),
                    m.modified().unwrap(),
                    std::fs::read(e.path()).unwrap(),
                ));
            }
        }
    }
    out.sort();
    out
}

#[test]
fn three_hundred_sessions_list_fast_across_folders() {
    let (_d, root) = build(300);
    let roots = [root];
    let mut cold_ms = u128::MAX;
    let mut warm_ms = u128::MAX;
    let mut l = None;
    // Best of three, each on a fresh cache, so a busy CI runner does not flake.
    for _ in 0..3 {
        let h = History::new();
        let t0 = Instant::now();
        let first = list(&h, &roots);
        cold_ms = cold_ms.min(t0.elapsed().as_millis());
        let t1 = Instant::now();
        let second = list(&h, &roots);
        warm_ms = warm_ms.min(t1.elapsed().as_millis());
        assert_eq!(first, second);
        l = Some(first);
    }
    let l = l.unwrap();
    assert!(cold_ms < 300, "cold list took {cold_ms} ms");
    assert!(warm_ms < 100, "warm list took {warm_ms} ms");
    assert_eq!(l.sessions.len(), 300);
    let folders: HashSet<&str> = l.sessions.iter().map(|s| s.folder.as_str()).collect();
    assert_eq!(folders.len(), 30, "worktrees group under their project");
    assert!(l
        .sessions
        .windows(2)
        .all(|w| w[0].last_activity >= w[1].last_activity));
    let titled = l
        .sessions
        .iter()
        .filter(|s| s.title_source == TitleSource::AiTitle)
        .count();
    assert_eq!(titled, 100);
    assert!(l.sessions.iter().all(|s| s.model.is_some()));
}

#[test]
fn three_thousand_sessions_list_warm_in_well_under_a_second() {
    let (_d, root) = build(3000);
    let roots = [root];
    let h = History::new();
    let t0 = Instant::now();
    assert_eq!(list(&h, &roots).sessions.len(), 3000);
    let cold = t0.elapsed().as_millis();
    let t1 = Instant::now();
    let _ = list(&h, &roots);
    let warm = t1.elapsed().as_millis();
    assert!(cold < 3000, "cold list of 3000 took {cold} ms");
    assert!(warm < 500, "warm list of 3000 took {warm} ms");
}

#[test]
fn listing_never_writes_under_the_transcript_roots() {
    let (d, root) = build(40);
    let before = snapshot(d.path());
    let h = History::new();
    let _ = list(&h, std::slice::from_ref(&root));
    let _ = list(&h, std::slice::from_ref(&root));
    assert_eq!(
        before,
        snapshot(d.path()),
        "nothing created, changed or touched"
    );
}
