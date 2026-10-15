//! Live backend checks against the real `claude` CLI (model: haiku, temp dirs under /tmp).
//!
//! Every test is `#[ignore]`: they need the `claude` CLI on the login-shell PATH, a login,
//! and they use the network. Run them with:
//!
//! ```text
//! cargo test -p patchroom --test live_chat -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! Each test starts its own manager over a temp data dir, runs `claude --model haiku` in a
//! fresh temp dir, and kills everything it started on exit. User settings files are only
//! read by claude, never written here.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command as Proc;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use patchroom_lib::events::{EventSink, UiEvent};
use patchroom_lib::manager::{CreateRequest, Manager, ManagerConfig, PromptAnswer, SessionManager};
use serde_json::{json, Value};

struct Stamped {
    at: Instant,
    event: UiEvent,
}

struct Sink {
    events: Mutex<Vec<Stamped>>,
    cv: Condvar,
}

impl Sink {
    fn new() -> Arc<Self> {
        Arc::new(Sink {
            events: Mutex::new(Vec::new()),
            cv: Condvar::new(),
        })
    }

    /// Output bytes so far, ANSI stripped, as one string.
    fn screen_text(&self) -> String {
        let g = self.events.lock().unwrap();
        let mut bytes = Vec::new();
        for s in g.iter() {
            if let UiEvent::Output { data, .. } = &s.event {
                bytes.extend(B64.decode(data).unwrap());
            }
        }
        strip_ansi(&String::from_utf8_lossy(&bytes))
    }

    /// Wait for the first event after index `from` whose payload satisfies `f`.
    fn wait<T>(
        &self,
        from: usize,
        timeout: Duration,
        what: &str,
        mut f: impl FnMut(&UiEvent) -> Option<T>,
    ) -> (usize, Instant, T) {
        let end = Instant::now() + timeout;
        let mut g = self.events.lock().unwrap();
        let mut i = from;
        loop {
            while i < g.len() {
                if let Some(t) = f(&g[i].event) {
                    return (i + 1, g[i].at, t);
                }
                i += 1;
            }
            let left = end.saturating_duration_since(Instant::now());
            if left.is_zero() {
                drop(g);
                let screen = self.screen_text();
                {
                    let g = self.events.lock().unwrap();
                    for s in g.iter().filter(|s| s.event.name() != "pty:output") {
                        let p: String = s.event.payload().to_string().chars().take(160).collect();
                        eprintln!("  event {} {p}", s.event.name());
                    }
                }
                let tail: String = screen
                    .chars()
                    .rev()
                    .take(1500)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect();
                panic!("timed out after {timeout:?} waiting for {what}. Screen tail:\n{tail}");
            }
            g = self.cv.wait_timeout(g, left).unwrap().0;
        }
    }

    /// Like `wait`, but `None` on timeout instead of a panic.
    fn try_wait<T>(
        &self,
        from: usize,
        timeout: Duration,
        mut f: impl FnMut(&UiEvent) -> Option<T>,
    ) -> Option<(usize, Instant, T)> {
        let end = Instant::now() + timeout;
        let mut g = self.events.lock().unwrap();
        let mut i = from;
        loop {
            while i < g.len() {
                if let Some(t) = f(&g[i].event) {
                    return Some((i + 1, g[i].at, t));
                }
                i += 1;
            }
            let left = end.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return None;
            }
            g = self.cv.wait_timeout(g, left).unwrap().0;
        }
    }

    fn len(&self) -> usize {
        self.events.lock().unwrap().len()
    }

    fn all_named(&self, name: &str) -> Vec<Value> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter(|s| s.event.name() == name)
            .map(|s| s.event.payload())
            .collect()
    }
}

impl EventSink for Sink {
    fn emit(&self, event: UiEvent) {
        self.events.lock().unwrap().push(Stamped {
            at: Instant::now(),
            event,
        });
        self.cv.notify_all();
    }
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::new();
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c == '\u{1b}' {
            match it.peek() {
                Some('[') => {
                    it.next();
                    for n in it.by_ref() {
                        if ('\u{40}'..='\u{7e}').contains(&n) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    it.next();
                    while let Some(n) = it.next() {
                        if n == '\u{7}' {
                            break;
                        }
                        if n == '\u{1b}' {
                            it.next();
                            break;
                        }
                    }
                }
                _ => {
                    it.next();
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn staged(name: &str) -> PathBuf {
    static DIR: OnceLock<tempfile::TempDir> = OnceLock::new();
    let tmp = DIR.get_or_init(|| tempfile::tempdir().unwrap());
    let copy = tmp.path().join(name);
    if !copy.exists() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
        let src = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.path())
            .find(|p| {
                p.file_name()
                    .is_some_and(|n| n.to_string_lossy().starts_with(&format!("{name}-")))
            })
            .unwrap_or_else(|| panic!("build.rs stages binaries/{name}-<triple>"));
        std::fs::copy(src, &copy).unwrap();
    }
    copy
}

struct Live {
    m: SessionManager,
    sink: Arc<Sink>,
    id: String,
    cwd: PathBuf,
    data: Arc<tempfile::TempDir>,
}

impl Drop for Live {
    fn drop(&mut self) {
        self.m.shutdown();
    }
}

/// Pids whose command line matches `pattern`, ignoring shells. (Another shell elsewhere
/// on the machine can carry the pattern in its own command line.)
fn pgrep(pattern: &str) -> Vec<String> {
    let out = Proc::new("pgrep").args(["-f", pattern]).output().unwrap();
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|pid| {
            let comm = Proc::new("ps")
                .args(["-o", "comm=", "-p", pid])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
                .unwrap_or_default();
            let base = comm.rsplit('/').next().unwrap_or("");
            !comm.is_empty() && !matches!(base, "bash" | "zsh" | "sh" | "pgrep")
        })
        .map(str::to_owned)
        .collect()
}

/// Start a haiku DM in a fresh /tmp dir. `extra` are more claude args.
fn start(extra: &[&str]) -> Live {
    start_with(extra, staged("patchroom-statusline"))
}

fn start_with(extra: &[&str], statusline_bin: PathBuf) -> Live {
    let data = tempfile::Builder::new()
        .prefix("prl")
        .tempdir_in("/tmp")
        .unwrap();
    // One fixed project dir: claude records trust per folder in its own state file, so a
    // fresh dir per run would add an entry per run.
    let cwd = PathBuf::from("/tmp/patchroom-live-p2");
    std::fs::create_dir_all(&cwd).unwrap();
    let sink = Sink::new();
    // The hook binary must be named `patchroom-hook` so pgrep finds leaks as it would
    // in the app bundle.
    let hook = staged("patchroom-hook");
    let mut cfg = ManagerConfig::new(data.path(), &hook);
    cfg.statusline_bin = Some(statusline_bin);
    let m = Manager::new(cfg, sink.clone()).unwrap();
    let mut args: Vec<String> = vec!["--model".into(), "haiku".into()];
    args.extend(extra.iter().map(|s| (*s).to_owned()));
    let cwd_real = cwd.canonicalize().unwrap();
    let id = m
        .create(&CreateRequest {
            cwd: cwd_real.to_string_lossy().into_owned(),
            args: Some(args),
            name: Some("live".into()),
            ..CreateRequest::default()
        })
        .unwrap();
    Live {
        m,
        sink,
        id,
        cwd: cwd_real,
        data: Arc::new(data),
    }
}

impl Live {
    /// A new manager over the same data dir, as after an app restart (the old manager
    /// must be shut down first).
    fn reopen(&self) -> Live {
        let sink = Sink::new();
        let mut cfg = ManagerConfig::new(self.data.path(), staged("patchroom-hook"));
        cfg.statusline_bin = Some(staged("patchroom-statusline"));
        Live {
            m: Manager::new(cfg, sink.clone()).unwrap(),
            sink,
            id: self.id.clone(),
            cwd: self.cwd.clone(),
            data: Arc::clone(&self.data),
        }
    }
}

const T: Duration = Duration::from_secs(120);

impl Live {
    /// Accept the folder-trust dialog if it shows, then wait for the main prompt.
    fn ready(&self) {
        let end = Instant::now() + Duration::from_secs(40);
        let mut trusted = false;
        loop {
            let t = self.sink.screen_text();
            if !trusted && (t.contains("Yes,Itrustthisfolder") || t.contains("Yes, I trust")) {
                trusted = true;
                self.m.write(&self.id, b"\x1b[B".to_vec()).unwrap();
                std::thread::sleep(Duration::from_millis(300));
                self.m.write(&self.id, b"\r".to_vec()).unwrap();
            }
            if t.contains("ClaudeCodev") || t.contains("Claude Code v") {
                break;
            }
            assert!(
                Instant::now() < end,
                "claude never showed its main screen:\n{t}"
            );
            std::thread::sleep(Duration::from_millis(200));
        }
        std::thread::sleep(Duration::from_millis(1500));
    }

    fn send(&self, text: &str) {
        self.m.send_text(&self.id, text.to_owned()).unwrap();
    }

    fn keys(&self, bytes: &[u8]) {
        self.m.write(&self.id, bytes.to_vec()).unwrap();
    }

    /// Wait for a `prompt:pending` of this kind after `from`.
    fn wait_prompt(&self, from: usize, kind: &str) -> (usize, Value) {
        self.wait_prompt_where(from, kind, false)
    }

    /// Like `wait_prompt` for a permission prompt, but wait for the announcement that
    /// carries `toolUseId`. The first one may lack it (the tool_use line trails the hook);
    /// the backend re-announces with the same promptId once the line lands. claude may
    /// hold that line until the prompt is answered, so only use this where the line
    /// reliably lands first (a plain Bash call in a fresh session).
    fn wait_prompt_linked(&self, from: usize) -> (usize, Value) {
        let (i, first) = self.wait_prompt_where(from, "permission", false);
        if first["toolUseId"].is_string() {
            return (i, first);
        }
        // Not linked yet: claude may hold the tool_use line until the prompt is answered, so
        // a short wait for the re-announcement is a bonus, never a requirement.
        let linked = self
            .sink
            .try_wait(from, Duration::from_secs(3), |e| match e {
                UiEvent::PromptPending { payload, .. }
                    if payload["kind"] == "permission"
                        && payload["promptId"] == first["promptId"]
                        && payload["toolUseId"].is_string() =>
                {
                    Some(payload.clone())
                }
                _ => None,
            });
        match linked {
            Some((j, _, v)) => (j, v),
            None => (i, first),
        }
    }

    fn wait_prompt_where(&self, from: usize, kind: &str, linked: bool) -> (usize, Value) {
        let (i, _, v) = self
            .sink
            .wait(from, T, &format!("prompt:pending {kind}"), |e| match e {
                UiEvent::PromptPending { payload, .. }
                    if payload["kind"] == kind && (!linked || payload["toolUseId"].is_string()) =>
                {
                    Some(payload.clone())
                }
                _ => None,
            });
        (i, v)
    }

    fn wait_resolved(&self, from: usize, prompt_id: &str) -> (usize, Value) {
        let (i, _, v) = self.sink.wait(
            from,
            Duration::from_secs(15),
            "prompt:resolved",
            |e| match e {
                UiEvent::PromptResolved {
                    prompt_id: p, by, ..
                } if p == prompt_id => Some(json!(by)),
                _ => None,
            },
        );
        (i, v)
    }

    /// Wait for a chat item matching `f` (in `chat:items` after `from`).
    fn wait_item(&self, from: usize, what: &str, f: impl Fn(&Value) -> bool) -> (usize, Value) {
        let (i, _, v) = self.sink.wait(from, T, what, |e| match e {
            UiEvent::ChatItems { items, .. } => items
                .as_array()
                .and_then(|a| a.iter().find(|x| f(x)).cloned()),
            _ => None,
        });
        (i, v)
    }

    /// Command-line pattern of the hook processes of this run only: every hook is started
    /// with `--session-key <this DM's id>`, and ids are unique per run, so parallel runs
    /// (another live_chat, scripts/e2e-live.sh) never match each other.
    fn hook_pattern(&self) -> String {
        format!("patchroom-hook.*--session-key {}", self.id)
    }

    fn no_hook_processes(&self) {
        let end = Instant::now() + Duration::from_secs(2);
        loop {
            let left = pgrep(&self.hook_pattern());
            if left.is_empty() {
                return;
            }
            if Instant::now() >= end {
                let ps = Proc::new("ps")
                    .args(["-o", "pid,ppid,etime,command", "-p", &left.join(",")])
                    .output()
                    .unwrap();
                panic!(
                    "hook processes still alive after 2 s:\n{}",
                    String::from_utf8_lossy(&ps.stdout)
                );
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

fn settle_models_turn(l: &Live, from: usize) -> usize {
    // The turn ends with a turn_duration system item.
    // The assistant reply and the turn_duration line can land in one event: look at it again.
    let (i, _) = l.wait_item(from.saturating_sub(1), "turn_duration", |x| {
        x["kind"] == "system" && x["subtype"] == "turn_duration"
    });
    i
}

const BASE: &[&str] = &[
    "--setting-sources",
    "project,local",
    "--permission-mode",
    "default",
];

#[test]
#[ignore = "needs the claude CLI and a login"]
fn permission_from_chat_then_terminal_then_always() {
    let _ = std::fs::remove_file("/tmp/patchroom-live-p2/p1.txt");
    let _ = std::fs::remove_file("/tmp/patchroom-live-p2/p2.txt");
    let _ = std::fs::remove_file("/tmp/patchroom-live-p2/p3.txt");
    let l = start(BASE);
    l.ready();

    // 1. A prompt typed in the composer appears as one user item, then a permission prompt.
    let mark = l.sink.len();
    l.send("Use the Bash tool to run exactly this command and nothing else: echo p1 > p1.txt");
    let (i, user) = l.wait_item(mark, "user message", |x| x["kind"] == "user");
    assert_eq!(
        user["text"],
        "Use the Bash tool to run exactly this command and nothing else: echo p1 > p1.txt"
    );
    let (i, p) = l.wait_prompt_linked(i);
    println!("prompt: {p}");
    assert_eq!(p["toolName"], "Bash");
    assert_eq!(p["toolInput"]["command"], "echo p1 > p1.txt");
    assert!(p["promptId"].as_str().unwrap().starts_with("prompt-"));
    let pid = p["promptId"].as_str().unwrap().to_owned();

    // 2. Allow from chat: the hook resolves, the tool runs, no hook process is left.
    l.m.prompt_answer(&l.id, &pid, PromptAnswer::Allow).unwrap();
    let t0 = Instant::now();
    let (i, by) = l.wait_resolved(i, &pid);
    assert_eq!(by, "chat");
    l.no_hook_processes();
    println!("chat allow -> no hook process in {:?}", t0.elapsed());
    let (i, tool) = l.wait_item(i, "tool ok", |x| {
        x["kind"] == "tool" && x["name"] == "Bash" && x["state"] == "ok"
    });
    if p["toolUseId"].is_string() {
        assert_eq!(tool["toolUseId"], p["toolUseId"].clone());
    }
    let first_tool = tool["toolUseId"].clone();
    assert!(Path::new("/tmp/patchroom-live-p2/p1.txt").exists());
    let i = settle_models_turn(&l, i);

    // 3. Answer in the terminal: Cmd+J then `1`. The chat widget flips to "terminal".
    l.send("Use the Bash tool to run exactly this command and nothing else: echo p2 > p2.txt");
    let (i, p2) = l.wait_prompt(i, "permission");
    let pid2 = p2["promptId"].as_str().unwrap().to_owned();
    std::thread::sleep(Duration::from_millis(600));
    l.keys(b"1");
    let t0 = Instant::now();
    let (i, by) = l.wait_resolved(i, &pid2);
    assert_eq!(by, "terminal");
    l.no_hook_processes();
    println!(
        "terminal answer -> resolved + no hook in {:?}",
        t0.elapsed()
    );
    let (i, _) = l.wait_item(i, "tool ok", |x| {
        x["kind"] == "tool"
            && x["name"] == "Bash"
            && x["state"] == "ok"
            && x["toolUseId"] != first_tool
    });
    assert!(Path::new("/tmp/patchroom-live-p2/p2.txt").exists());
    let i = settle_models_turn(&l, i);

    // 4. Always: applies the CLI's own suggestion (no further prompt for the same rule).
    l.send("Use the Bash tool to run exactly this command and nothing else: echo p3 > p3.txt");
    let (i, p3) = l.wait_prompt(i, "permission");
    assert_eq!(p3["canAlways"], true, "{p3}");
    let pid3 = p3["promptId"].as_str().unwrap().to_owned();
    l.m.prompt_answer(&l.id, &pid3, PromptAnswer::AllowAlways)
        .unwrap();
    let (i, by) = l.wait_resolved(i, &pid3);
    assert_eq!(by, "chat");
    l.no_hook_processes();
    let (i, _) = l.wait_item(i, "tool ok", |x| {
        x["kind"] == "tool"
            && x["state"] == "ok"
            && x["name"] == "Bash"
            && x["input"]["command"] == "echo p3 > p3.txt"
    });
    assert!(Path::new("/tmp/patchroom-live-p2/p3.txt").exists());
    let _ = settle_models_turn(&l, i);
}

fn ask_prompt(fruits: &str, multi: bool) -> String {
    format!(
        "Use the AskUserQuestion tool to ask me which fruit I prefer, with exactly these options: {fruits}. \
         multiSelect must be {multi}. After my answer, reply with just my answer."
    )
}

#[test]
#[ignore = "needs the claude CLI and a login"]
fn questions_from_chat_other_text_and_terminal() {
    let l = start(BASE);
    l.ready();

    // 1. Single select, answered from chat with free text ("Other").
    let mark = l.sink.len();
    l.send(&ask_prompt("Apple, Pear", false));
    let (i, q) = l.wait_prompt(mark, "question");
    println!("question prompt: {q}");
    let text = q["questions"][0]["question"].as_str().unwrap().to_owned();
    assert_eq!(q["questions"][0]["multiSelect"], false);
    assert!(q["questions"][0]["options"].as_array().unwrap().len() >= 2);
    assert!(q["toolUseId"].as_str().is_some());
    let pid = q["promptId"].as_str().unwrap().to_owned();
    let mut answers = BTreeMap::new();
    answers.insert(text.clone(), "Mango".to_owned());
    l.m.prompt_answer(&l.id, &pid, PromptAnswer::Questions { answers })
        .unwrap();
    let (i, by) = l.wait_resolved(i, &pid);
    assert_eq!(by, "chat");
    let (i, item) = l.wait_item(i, "answered question", |x| {
        x["kind"] == "question" && x["state"] == "answered"
    });
    assert_eq!(item["answers"][&text], "Mango");
    l.no_hook_processes();
    let (i, a) = l.wait_item(i, "assistant reply", |x| x["kind"] == "assistant");
    assert!(a["text"].as_str().unwrap().contains("Mango"), "{a}");
    let i = settle_models_turn(&l, i);

    // 2. Answered from the terminal: the first keystroke hands the hidden picker to the TUI.
    l.send(&ask_prompt("Apple, Pear", false));
    let (i, q2) = l.wait_prompt(i, "question");
    let pid2 = q2["promptId"].as_str().unwrap().to_owned();
    let label2 = q2["questions"][0]["options"][1]["label"]
        .as_str()
        .unwrap()
        .to_owned();
    std::thread::sleep(Duration::from_millis(500));
    l.keys(b"2");
    let (i, by) = l.wait_resolved(i, &pid2);
    assert_eq!(by, "terminal");
    let (i, item) = l.wait_item(i, "answered question", |x| {
        x["kind"] == "question" && x["state"] == "answered" && x["toolUseId"] == q2["toolUseId"]
    });
    let q2text = q2["questions"][0]["question"].as_str().unwrap();
    assert_eq!(item["answers"][q2text], label2.as_str());
    l.no_hook_processes();
    let i = settle_models_turn(&l, i);

    // 3. Multi-select joins labels with ", ".
    l.send(&ask_prompt("Apple, Pear, Plum", true));
    let (i, q3) = l.wait_prompt(i, "question");
    assert_eq!(q3["questions"][0]["multiSelect"], true);
    let pid3 = q3["promptId"].as_str().unwrap().to_owned();
    let q3text = q3["questions"][0]["question"].as_str().unwrap().to_owned();
    let labels: Vec<String> = q3["questions"][0]["options"]
        .as_array()
        .unwrap()
        .iter()
        .take(2)
        .map(|o| o["label"].as_str().unwrap().to_owned())
        .collect();
    let joined = labels.join(", ");
    let mut answers = BTreeMap::new();
    answers.insert(q3text.clone(), joined.clone());
    l.m.prompt_answer(&l.id, &pid3, PromptAnswer::Questions { answers })
        .unwrap();
    let (i, _) = l.wait_resolved(i, &pid3);
    let (i, item) = l.wait_item(i, "answered question", |x| {
        x["kind"] == "question" && x["state"] == "answered" && x["toolUseId"] == q3["toolUseId"]
    });
    assert_eq!(item["answers"][&q3text], joined.as_str());
    let (_, a) = l.wait_item(i, "assistant reply", |x| x["kind"] == "assistant");
    println!("multi-select reply: {}", a["text"]);
    for label in &labels {
        assert!(a["text"].as_str().unwrap().contains(label.as_str()), "{a}");
    }
}

#[test]
#[ignore = "needs the claude CLI and a login"]
fn plan_revise_then_approve_from_chat() {
    let l = start(&[
        "--setting-sources",
        "project,local",
        "--permission-mode",
        "plan",
    ]);
    l.ready();
    let mark = l.sink.len();
    l.send(
        "Plan how to create a file plan.txt containing the single word hi. \
         When the plan is ready, call ExitPlanMode with it.",
    );
    // 1. Ask for changes from chat: the dialog's "Tell Claude what to change" option.
    let (i, p) = l.wait_prompt(mark, "plan");
    println!("plan prompt: {p}");
    assert_eq!(p["toolName"], "ExitPlanMode");
    assert_eq!(p["canAlways"], true);
    assert!(p["toolInput"]["plan"].as_str().unwrap().len() > 3);
    assert!(p["toolUseId"].as_str().is_some());
    let pid = p["promptId"].as_str().unwrap().to_owned();
    l.m.prompt_answer(
        &l.id,
        &pid,
        PromptAnswer::Deny {
            message: Some("Also mention the word banana in the plan.".into()),
        },
    )
    .unwrap();
    let (i, by) = l.wait_resolved(i, &pid);
    assert_eq!(by, "chat");
    let (i, rejected) = l.wait_item(i.saturating_sub(1), "rejected plan", |x| {
        x["kind"] == "plan" && x["state"] == "rejected" && x["toolUseId"] == p["toolUseId"]
    });
    println!("rejected plan item: {rejected}");

    // 2. The model revises; approve the new plan from chat.
    let (i, p2) = l.wait_prompt(i, "plan");
    assert!(
        p2["toolInput"]["plan"]
            .as_str()
            .unwrap()
            .to_lowercase()
            .contains("banana"),
        "revision follows the feedback: {p2}"
    );
    let pid2 = p2["promptId"].as_str().unwrap().to_owned();
    l.m.prompt_answer(&l.id, &pid2, PromptAnswer::Allow)
        .unwrap();
    let (i, by) = l.wait_resolved(i, &pid2);
    assert_eq!(by, "chat");
    let (i, approved) = l.wait_item(i.saturating_sub(1), "approved plan", |x| {
        x["kind"] == "plan" && x["state"] == "approved" && x["toolUseId"] == p2["toolUseId"]
    });
    println!("approved plan item: {approved}");
    l.no_hook_processes();
    let _ = i;
}

#[test]
#[ignore = "needs the claude CLI and a login"]
fn plan_from_terminal() {
    let l = start(&[
        "--setting-sources",
        "project,local",
        "--permission-mode",
        "plan",
    ]);
    l.ready();
    let mark = l.sink.len();
    l.send(
        "Plan how to create a file plan.txt containing the single word hi. \
         When the plan is ready, call ExitPlanMode with it.",
    );
    let (i, p) = l.wait_prompt(mark, "plan");
    let pid = p["promptId"].as_str().unwrap().to_owned();
    // Typing in the terminal hands the hidden dialog to the TUI; `2` is the manual-approve option.
    std::thread::sleep(Duration::from_millis(500));
    l.keys(b"2");
    let (i, by) = l.wait_resolved(i, &pid);
    assert_eq!(by, "terminal");
    let (_, approved) = l.wait_item(i.saturating_sub(1), "approved plan", |x| {
        x["kind"] == "plan" && x["state"] == "approved" && x["toolUseId"] == p["toolUseId"]
    });
    println!("approved in terminal: {approved}");
    l.no_hook_processes();
}

/// For every item, the gap between its transcript line landing in the file and the first
/// `chat:items` event that carried it. `landed` maps a line uuid to the time it landed.
fn item_latencies(landed: &BTreeMap<String, Instant>, sink: &Sink) -> Vec<Duration> {
    let g = sink.events.lock().unwrap();
    let mut seen: BTreeMap<String, ()> = BTreeMap::new();
    let mut out = Vec::new();
    for s in g.iter() {
        if let UiEvent::ChatItems { items, .. } = &s.event {
            for it in items.as_array().into_iter().flatten() {
                let key = it["key"].as_str().unwrap_or("");
                let uuid = key.split(':').next().unwrap_or("");
                if seen.insert(key.to_owned(), ()).is_none() {
                    if let Some(at) = landed.get(uuid) {
                        out.push(s.at.saturating_duration_since(*at));
                    }
                }
            }
        }
    }
    out
}

#[test]
#[ignore = "needs the claude CLI and a login"]
fn latency_badges_statusline_history_and_restart() {
    let l = start(BASE);
    // Watch the bridge for the raw statusLine JSON claude sends.
    let payloads: Arc<Mutex<Vec<Value>>> = Arc::default();
    {
        let rx = l.m.bridge().subscribe();
        let payloads = Arc::clone(&payloads);
        std::thread::spawn(move || {
            while let Ok(ev) = rx.recv() {
                if let patchroom_bridge::BridgeEvent::Statusline(r) = ev {
                    payloads.lock().unwrap().push(r.payload);
                }
            }
        });
    }
    l.ready();

    // The status strip: the user's own statusLine output, verbatim, plus chips.
    let (_, _, su) = l.sink.wait(
        0,
        Duration::from_secs(30),
        "statusline:update",
        |e| match e {
            UiEvent::Statusline { text, chips, .. } if !text.is_empty() => {
                Some((text.clone(), chips.clone()))
            }
            _ => None,
        },
    );
    println!("statusline text: {:?}", su.0);
    println!("statusline chips: {}", su.1);
    let squash = |s: &str| -> String {
        strip_ansi(s)
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect()
    };
    let screen = squash(&l.sink.screen_text());
    // The user's script prints the model name; the TUI shows the same text.
    assert!(
        screen.contains(&squash(su.0.lines().next().unwrap_or(""))),
        "the TUI shows the statusLine text the strip got"
    );
    assert!(su.1["model"].as_str().is_some(), "model chip: {}", su.1);
    println!(
        "raw statusLine JSON keys: {:?}",
        payloads
            .lock()
            .unwrap()
            .last()
            .map(|v| { v.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>()) })
    );
    println!(
        "raw statusLine JSON: {}",
        payloads.lock().unwrap().last().cloned().unwrap_or_default()
    );

    // Transcript landing -> chat:items latency over a live turn. An independent 2 ms poller
    // notes when each line's bytes reach the file.
    let sid = l.m.list().unwrap()[0].claude_session_id.clone().unwrap();
    let landed: Arc<Mutex<BTreeMap<String, Instant>>> = Arc::default();
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let poller = {
        let landed = Arc::clone(&landed);
        let stop = Arc::clone(&stop);
        std::thread::spawn(move || {
            use std::io::{Read, Seek, SeekFrom};
            let root = PathBuf::from(std::env::var("HOME").unwrap()).join(".claude/projects");
            let mut offset = 0u64;
            let mut carry = String::new();
            let mut path: Option<PathBuf> = None;
            while !stop.load(std::sync::atomic::Ordering::SeqCst) {
                if path.is_none() {
                    path = std::fs::read_dir(&root)
                        .unwrap()
                        .flatten()
                        .map(|d| d.path().join(format!("{sid}.jsonl")))
                        .find(|p| p.exists());
                }
                if let Some(p) = &path {
                    let len = std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
                    if len > offset {
                        let at = Instant::now();
                        let mut f = std::fs::File::open(p).unwrap();
                        f.seek(SeekFrom::Start(offset)).unwrap();
                        let mut buf = String::new();
                        f.take(len - offset).read_to_string(&mut buf).unwrap_or(0);
                        offset = len;
                        carry.push_str(&buf);
                        while let Some(nl) = carry.find('\n') {
                            let line: String = carry.drain(..=nl).collect();
                            if let Ok(v) = serde_json::from_str::<Value>(line.trim()) {
                                if let Some(u) = v["uuid"].as_str() {
                                    landed.lock().unwrap().entry(u.to_owned()).or_insert(at);
                                }
                            }
                        }
                    }
                }
                std::thread::sleep(Duration::from_millis(2));
            }
        })
    };
    let mark = l.sink.len();
    l.send("Reply with exactly one short sentence about the number seven.");
    let (i, _) = l.wait_item(mark, "assistant reply", |x| x["kind"] == "assistant");
    let _ = settle_models_turn(&l, i);
    stop.store(true, std::sync::atomic::Ordering::SeqCst);
    poller.join().unwrap();
    let mut lat = item_latencies(&landed.lock().unwrap(), &l.sink);
    lat.sort();
    println!("landing -> chat:items latencies: {lat:?}");
    assert!(lat.len() >= 3, "too few items measured: {lat:?}");
    let median = lat[lat.len() / 2];
    println!("median {median:?}, max {:?}", lat.last().unwrap());
    assert!(median < Duration::from_millis(500), "median {median:?}");

    // The mode chip follows the transcript's permission-mode lines.
    let (_, _, mode) = l
        .sink
        .wait(0, Duration::from_secs(10), "mode chip", |e| match e {
            UiEvent::Statusline { chips, .. } => chips["mode"].as_str().map(str::to_owned),
            _ => None,
        });
    println!("mode chip: {mode}");

    // Shift+Tab from the strip cycles the mode in the TUI; the chip follows.
    let before = l.sink.len();
    l.m.cycle_mode(&l.id).unwrap();
    let (_, _, mode2) = l.sink.wait(
        before,
        Duration::from_secs(10),
        "mode chip after cycle",
        |e| match e {
            UiEvent::Statusline { chips, .. } => chips["mode"]
                .as_str()
                .filter(|m| *m != mode)
                .map(str::to_owned),
            _ => None,
        },
    );
    println!("mode chip after Shift+Tab: {mode2}");
    // Cycle back to the default mode so Bash asks for permission below.
    let mut current = mode2;
    for _ in 0..6 {
        if current == "default" {
            break;
        }
        let before = l.sink.len();
        l.m.cycle_mode(&l.id).unwrap();
        let (_, _, next) = l
            .sink
            .wait(before, Duration::from_secs(10), "mode chip", |e| match e {
                UiEvent::Statusline { chips, .. } => chips["mode"]
                    .as_str()
                    .filter(|m| *m != current)
                    .map(str::to_owned),
                _ => None,
            });
        current = next;
    }
    assert_eq!(current, "default");

    // The unread badge is for output the user has not looked at; the user "views" with
    // session_mark_read.
    let badges = l.sink.all_named("session:badges");
    println!("badge events: {badges:?}");
    let unread_now = l.m.list().unwrap()[0].unread;
    assert!(unread_now >= 1, "an assistant reply is unread until viewed");
    l.m.mark_read(&l.id).unwrap();
    assert_eq!(l.m.list().unwrap()[0].unread, 0);

    // History pages: newest page first.
    let page = l.m.chat_history(&l.id, None, Some(2)).unwrap();
    assert_eq!(page.items.len(), 2);
    assert!(page.has_more);
    let older =
        l.m.chat_history(
            &l.id,
            Some(patchroom_claude::Cursor::Index(page.cursor)),
            Some(50),
        )
        .unwrap();
    assert!(!older.has_more);
    assert!(older
        .items
        .iter()
        .any(|i| serde_json::to_value(i).unwrap()["kind"] == "user"));

    // Needs-you: set by a pending prompt, never cleared by viewing, cleared on resolution.
    let from = l.sink.len();
    l.send("Use the Bash tool to run exactly this command and nothing else: echo n1 > n1.txt");
    let (_, p) = l.wait_prompt(from, "permission");
    let pid = p["promptId"].as_str().unwrap().to_owned();
    let end = Instant::now() + Duration::from_secs(10);
    while !l.m.list().unwrap()[0].needs_you {
        assert!(Instant::now() < end, "needs-you never set");
        std::thread::sleep(Duration::from_millis(50));
    }
    l.m.mark_read(&l.id).unwrap();
    assert!(
        l.m.list().unwrap()[0].needs_you,
        "viewing must not clear needs-you"
    );

    // It survives a restart of the app (new manager over the same data dir).
    l.m.shutdown();
    let l2 = l.reopen();
    let listed = l2.m.list().unwrap();
    assert_eq!(listed.len(), 1);
    assert!(listed[0].needs_you, "needs-you persists across restart");
    // The exited DM still shows its history, without launching anything.
    let h = l2.m.chat_history(&l2.id, None, Some(500)).unwrap();
    assert!(
        h.items.len() >= 3,
        "history of an exited DM: {}",
        h.items.len()
    );
    let old_len = h.items.len();

    // Resuming starts a fresh process: whatever waited before is gone, history carries on.
    l2.m.resume(&l2.id, None, None).unwrap();
    l2.ready();
    let end = Instant::now() + Duration::from_secs(10);
    while l2.m.list().unwrap()[0].needs_you {
        assert!(Instant::now() < end, "a new process has no open prompt");
        std::thread::sleep(Duration::from_millis(50));
    }
    let mark = l2.sink.len();
    l2.send("Reply with exactly the single word: back");
    let (i, a) = l2.wait_item(mark, "assistant reply after resume", |x| {
        x["kind"] == "assistant"
    });
    println!("after resume: {a}");
    let _ = settle_models_turn(&l2, i);
    let h2 = l2.m.chat_history(&l2.id, None, Some(500)).unwrap();
    assert!(
        h2.items.len() > old_len,
        "history grows after resume: {} > {old_len}",
        h2.items.len()
    );
    let _ = pid;
}

#[test]
#[ignore = "needs the claude CLI and a login"]
fn quit_leaves_no_claude_or_hook_process() {
    let l = start(BASE);
    l.ready();
    let sid = l.m.list().unwrap()[0].claude_session_id.clone().unwrap();
    let mark = l.sink.len();
    l.send("Use the Bash tool to run exactly this command and nothing else: echo q1 > q1.txt");
    // A permission hook is in flight when the app quits.
    let _ = l.wait_prompt(mark, "permission");
    assert!(
        !pgrep(&l.hook_pattern()).is_empty(),
        "the held hook process is running"
    );
    assert!(!pgrep(&sid).is_empty(), "claude is running");
    l.m.shutdown();
    let end = Instant::now() + Duration::from_secs(3);
    while !(pgrep(&l.hook_pattern()).is_empty() && pgrep(&sid).is_empty()) {
        assert!(
            Instant::now() < end,
            "left after quit: hooks {:?}, claude {:?}",
            pgrep(&l.hook_pattern()),
            pgrep(&sid)
        );
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[test]
#[ignore = "needs the claude CLI and a login"]
fn no_user_statusline_shows_chips_only() {
    // A wrapper script that runs the real one with a HOME that has no settings: the same as
    // a user with no statusLine anywhere.
    let empty_home = tempfile::Builder::new()
        .prefix("prl-home")
        .tempdir_in("/tmp")
        .unwrap();
    let script_dir = tempfile::Builder::new()
        .prefix("prl-sl")
        .tempdir_in("/tmp")
        .unwrap();
    let script = script_dir.path().join("patchroom-statusline");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\nexec env HOME={} {} \"$@\"\n",
            empty_home.path().display(),
            staged("patchroom-statusline").display()
        ),
    )
    .unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let l = start_with(BASE, script);
    l.ready();
    // Chips arrive from the statusLine JSON, with an empty text.
    let (_, _, (text, chips)) =
        l.sink.wait(
            0,
            Duration::from_secs(30),
            "statusline:update",
            |e| match e {
                UiEvent::Statusline { text, chips, .. } if chips["model"].is_string() => {
                    Some((text.clone(), chips.clone()))
                }
                _ => None,
            },
        );
    println!("text {text:?} chips {chips}");
    assert_eq!(text, "");
    assert_eq!(chips["model"], "Haiku 5.5");
    // The TUI shows no extra line: the status text the user script would print is absent.
    std::thread::sleep(Duration::from_secs(1));
    let screen = l.sink.screen_text();
    assert!(
        !screen.contains("OAUTH") && !screen.contains("CI20%"),
        "{screen}"
    );
}
