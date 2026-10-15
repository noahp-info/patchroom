//! A synthetic 300-transcript fixture: a folder, a worktree under it, a linked git worktree
//! outside it, subfolders, sidechains, every name source, noise and old sessions. Nothing here
//! is copied from a real transcript.

use std::collections::{HashMap, HashSet};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Instant;

use patchroom_folders::encode::encode_dir;
use patchroom_folders::{signature, Discovery, FolderSession, NameSource, Query};
use serde_json::json;

const DAY_MS: i64 = 86_400_000;

struct Fx {
    _dir: tempfile::TempDir,
    projects: PathBuf,
    registry: PathBuf,
    home: String,
    wt_inside: String,
    wt_outside: String,
    now_ms: i64,
}

fn git(dir: &Path, args: &[&str]) {
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
}

fn iso(ms: i64) -> String {
    chrono_free_iso(ms)
}

/// Epoch ms to `YYYY-MM-DDTHH:MM:SS.mmmZ` without a date crate (civil-from-days).
fn chrono_free_iso(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60,
        ms.rem_euclid(1000)
    )
}

fn write(fx_projects: &Path, cwd: &str, file: &str, lines: &[String]) {
    let d = fx_projects.join(encode_dir(cwd));
    std::fs::create_dir_all(&d).unwrap();
    let mut f = std::fs::File::create(d.join(file)).unwrap();
    for l in lines {
        f.write_all(l.as_bytes()).unwrap();
        f.write_all(b"\n").unwrap();
    }
}

fn user(text: &str, cwd: &str, ms: i64) -> String {
    json!({"type":"user","isSidechain":false,"cwd":cwd,"gitBranch":"main","entrypoint":"cli",
        "timestamp":iso(ms),"origin":{"kind":"human"},"message":{"role":"user","content":text}})
    .to_string()
}

fn filler(ms: i64) -> String {
    json!({"type":"assistant","timestamp":iso(ms),"message":{"content":"y".repeat(1500)}})
        .to_string()
}

fn build() -> Fx {
    let dir = tempfile::tempdir().unwrap();
    let base = std::fs::canonicalize(dir.path()).unwrap();
    let projects = base.join("projects");
    let home_p = base.join("work").join("proj");
    std::fs::create_dir_all(&home_p).unwrap();
    git(&home_p, &["init", "-q", "-b", "main"]);
    git(&home_p, &["commit", "-q", "--allow-empty", "-m", "i"]);
    let inside = home_p.join(".claude").join("worktrees").join("feat-in");
    git(
        &home_p,
        &[
            "worktree",
            "add",
            "-q",
            inside.to_str().unwrap(),
            "-b",
            "feat-in",
        ],
    );
    let outside = base.join("work").join("proj-wt-out");
    git(
        &home_p,
        &[
            "worktree",
            "add",
            "-q",
            outside.to_str().unwrap(),
            "-b",
            "feat-out",
        ],
    );
    let (home, wt_inside, wt_outside) = (
        home_p.to_string_lossy().into_owned(),
        inside.to_string_lossy().into_owned(),
        outside.to_string_lossy().into_owned(),
    );
    let now_ms = 1_800_000_000_000_i64;
    let sub = format!("{home}/packages/ui");
    let mut n = 0;
    let mut session = |cwd: &str, n_prompts: usize, age_days: i64, extra: Vec<String>| {
        n += 1;
        let sid = format!("{:08x}-0000-4000-8000-{:012x}", n, n);
        let newest = now_ms - age_days * DAY_MS - n as i64 * 1000;
        let mut lines = Vec::new();
        if n_prompts > 0 {
            lines.push(user(
                &format!("prompt one of session {n}"),
                cwd,
                newest - 5000 - n_prompts as i64,
            ));
        }
        for k in 1..n_prompts.max(1) {
            lines.push(filler(newest - 4000));
            lines.push(user(
                &format!("prompt {} of session {n}", k + 1),
                cwd,
                newest - 3000 + k as i64,
            ));
        }
        lines.extend(extra);
        lines.push(filler(newest));
        write(&projects, cwd, &format!("{sid}.jsonl"), &lines);
        sid
    };
    // 100 in the home folder: 40 old (20 to 60 days), 60 recent.
    for i in 0..100 {
        session(
            &home,
            3,
            if i < 40 { 20 + i as i64 } else { i as i64 % 10 },
            vec![],
        );
    }
    for _ in 0..50 {
        session(&sub, 2, 1, vec![]);
    }
    for _ in 0..50 {
        session(&wt_inside, 2, 2, vec![]);
    }
    for _ in 0..60 {
        session(&wt_outside, 2, 3, vec![]);
    }
    // Name sources, in the first four home sessions' place: separate sessions.
    session(
        &home,
        2,
        0,
        vec![
            json!({"type":"ai-title","aiTitle":"AI title"}).to_string(),
            json!({"type":"custom-title","customTitle":"Custom title"}).to_string(),
        ],
    );
    session(
        &home,
        2,
        0,
        vec![json!({"type":"ai-title","aiTitle":"Only AI"}).to_string()],
    );
    // 30 noise: 10 empty starts, 10 -p runs, 10 hook-only (only machine-made user lines).
    for _ in 0..10 {
        session(
            &home,
            0,
            1,
            vec![json!({"type":"last-prompt","sessionId":"x"}).to_string()],
        );
    }
    for _ in 0..10 {
        n += 1;
        let sid = format!("{:08x}-0000-4000-8000-{:012x}", n, n);
        let l = json!({"type":"user","entrypoint":"sdk-cli","cwd":home,"timestamp":iso(now_ms),
            "message":{"content":"print the date"}})
        .to_string();
        write(&projects, &home, &format!("{sid}.jsonl"), &[l]);
    }
    for _ in 0..10 {
        n += 1;
        let sid = format!("{:08x}-0000-4000-8000-{:012x}", n, n);
        let l = json!({"type":"user","promptSource":"system","cwd":home,"timestamp":iso(now_ms),
            "message":{"content":"Stop hook feedback: keep going"}})
        .to_string();
        write(&projects, &home, &format!("{sid}.jsonl"), &[l]);
    }
    // 10 sidechains: flagged inside, or filed as agent-*.jsonl.
    for _ in 0..5 {
        n += 1;
        let sid = format!("{:08x}-0000-4000-8000-{:012x}", n, n);
        let l = json!({"type":"user","isSidechain":true,"cwd":home,"timestamp":iso(now_ms),
            "message":{"content":"subagent task"}})
        .to_string();
        write(&projects, &home, &format!("{sid}.jsonl"), &[l]);
    }
    for k in 0..5 {
        write(
            &projects,
            &home,
            &format!("agent-a{k}.jsonl"),
            &[user("agent file", &home, now_ms)],
        );
    }
    // A lookalike folder that must not be listed.
    let other = format!("{home}-other");
    write(
        &projects,
        &other,
        "99999999-0000-4000-8000-000000000000.jsonl",
        &[user("elsewhere", &other, now_ms)],
    );
    Fx {
        _dir: dir,
        projects,
        registry: base.join("session-names.jsonl"),
        home,
        wt_inside,
        wt_outside,
        now_ms,
    }
}

fn list(
    fx: &Fx,
    d: &Discovery,
    dms: &HashMap<String, (String, String)>,
) -> patchroom_folders::Listing {
    let (hidden, live) = (HashSet::new(), HashSet::new());
    d.list(&Query {
        home: &fx.home,
        projects_dirs: std::slice::from_ref(&fx.projects),
        registry_path: Some(&fx.registry),
        dms,
        hidden: &hidden,
        live: &live,
    })
}

#[test]
fn three_hundred_sessions_list_fast_with_the_right_shape() {
    let fx = build();
    let files: usize = std::fs::read_dir(&fx.projects)
        .unwrap()
        .flatten()
        .map(|d| std::fs::read_dir(d.path()).unwrap().count())
        .sum();
    assert!(files >= 300, "fixture has {files} transcripts");

    // A cold list needs an empty cache, which a fresh `Discovery` has. Time up to five fresh
    // ones and keep the best, then the best of three warm lists on the last one, so a stall on a
    // loaded machine cannot fail the test. The limits stay 300 ms and 100 ms.
    let no_dms = HashMap::new();
    let (mut cold_ms, mut warm_ms) = (u128::MAX, u128::MAX);
    let mut cold = None;
    let mut warm = None;
    for _ in 0..5 {
        let d = Discovery::new();
        let t0 = Instant::now();
        let c = list(&fx, &d, &no_dms);
        cold_ms = cold_ms.min(t0.elapsed().as_millis());
        for _ in 0..3 {
            let t1 = Instant::now();
            let w = list(&fx, &d, &no_dms);
            warm_ms = warm_ms.min(t1.elapsed().as_millis());
            warm = Some(w);
        }
        cold = Some(c);
        if cold_ms < 300 && warm_ms < 100 {
            break;
        }
    }
    let (cold, warm) = (cold.unwrap(), warm.unwrap());
    eprintln!(
        "{} sessions: cold {cold_ms} ms, warm {warm_ms} ms",
        cold.sessions.len()
    );
    assert!(cold_ms < 300, "cold list took {cold_ms} ms");
    assert!(warm_ms < 100, "warm list took {warm_ms} ms");
    assert_eq!(cold, warm);

    // 100 home + 50 sub + 50 inside + 60 outside + 2 named + 30 noise; sidechains and the
    // lookalike are not listed.
    assert_eq!(cold.sessions.len(), 292);
    assert_eq!(cold.hidden_count, 30);
    let by = |f: &dyn Fn(&FolderSession) -> bool| cold.sessions.iter().filter(|s| f(s)).count();
    assert_eq!(by(&|s| s.rel_path.is_empty()), 100 + 2 + 30);
    assert_eq!(by(&|s| s.rel_path == "packages/ui"), 50);
    assert_eq!(by(&|s| s.rel_path == ".claude/worktrees/feat-in"), 50);
    assert_eq!(by(&|s| s.rel_path == "proj-wt-out"), 60);
    assert!(cold
        .sessions
        .iter()
        .all(|s| !s.launch_cwd.ends_with("-other")));
    // Sorted newest first.
    assert!(cold
        .sessions
        .windows(2)
        .all(|w| w[0].last_activity >= w[1].last_activity));
    // lastActivity is the newest transcript timestamp.
    let newest = cold.sessions.iter().map(|s| s.last_activity).max().unwrap();
    assert!(newest >= fx.now_ms - 60_000 && newest <= fx.now_ms + 1000);
    // Older than 14 days: exactly the 40 old home sessions.
    let cutoff = fx.now_ms - 14 * DAY_MS;
    assert_eq!(by(&|s| s.last_activity < cutoff), 40);
    // userTurns.
    assert!(cold
        .sessions
        .iter()
        .filter(|s| !s.hidden)
        .all(|s| s.user_turns >= 2));
    assert!(cold
        .sessions
        .iter()
        .filter(|s| s.hidden)
        .all(|s| s.user_turns <= 1));
    // Every name source shows up with the right source tag.
    let named = |src: NameSource| {
        cold.sessions
            .iter()
            .filter(|s| s.name_source == src)
            .count()
    };
    assert_eq!(named(NameSource::CustomTitle), 1);
    assert_eq!(named(NameSource::AiTitle), 1);
    assert!(named(NameSource::Prompt) > 200);
}

#[test]
fn the_registry_and_patchroom_names_outrank_the_transcript_and_a_touch_updates_one_row() {
    let fx = build();
    let d = Discovery::new();
    let first = list(&fx, &d, &HashMap::new());
    let target = first.sessions[5].session_id.clone();
    std::fs::write(
        &fx.registry,
        format!("{{\"session_id\":\"{target}\",\"name\":\"Registry name\",\"named_at\":\"2026-01-01T00:00:00Z\"}}\n"),
    )
    .unwrap();
    let l = list(&fx, &d, &HashMap::new());
    let s = l.sessions.iter().find(|s| s.session_id == target).unwrap();
    assert_eq!(
        (s.name.as_str(), s.name_source),
        ("Registry name", NameSource::Registry)
    );
    let dms = HashMap::from([(target.clone(), ("dm-1".to_owned(), "Mine".to_owned()))]);
    let l = list(&fx, &d, &dms);
    let s = l.sessions.iter().find(|s| s.session_id == target).unwrap();
    assert_eq!((s.name.as_str(), s.name_source), ("Mine", NameSource::User));
    assert_eq!(s.dm_id.as_deref(), Some("dm-1"));
}

#[test]
fn a_new_transcript_moves_the_signature_and_shows_up_on_the_next_list() {
    let fx = build();
    let d = Discovery::new();
    let sig = || signature(std::slice::from_ref(&fx.projects), &d.roots(&fx.home));
    let before = sig();
    let n_before = list(&fx, &d, &HashMap::new()).sessions.len();
    write(
        &fx.projects,
        &fx.home,
        "aaaaaaaa-0000-4000-8000-00000000ffff.jsonl",
        &[user("started in iTerm", &fx.home, fx.now_ms + 1000)],
    );
    assert_ne!(before, sig());
    let l = list(&fx, &d, &HashMap::new());
    assert_eq!(l.sessions.len(), n_before + 1);
    assert_eq!(l.sessions[0].first_prompt, "started in iTerm");
    let _ = (&fx.wt_inside, &fx.wt_outside);
}
