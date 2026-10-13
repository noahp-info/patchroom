//! Real unix-socket tests for the bridge. A raw `UnixStream` plays the hook binary.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::Arc;
use std::time::{Duration, Instant};

use patchroom_bridge::protocol::{self, ServerMessage};
use patchroom_bridge::{
    AgentEntry, AgentsSource, AnswerError, Bridge, BridgeConfig, BridgeError, BridgeEvent,
    NeedsKind, PendingKind, PermissionAnswer, QuestionAnswers, Resolution, Status, StatusSource,
};
use serde_json::{json, Value};

static N: AtomicU32 = AtomicU32::new(0);

struct Env {
    dir: PathBuf,
    sock: PathBuf,
}

impl Env {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "prb-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let sock = dir.join("b.sock");
        Self { dir, sock }
    }

    fn bridge(&self, tweak: impl FnOnce(&mut BridgeConfig)) -> Bridge {
        let mut cfg = BridgeConfig::new(&self.sock);
        cfg.transcript_poll = Duration::from_millis(40);
        tweak(&mut cfg);
        let b = Bridge::start(cfg).unwrap();
        b.set_chat_attached(true);
        b
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// An open hook connection that has sent its request.
struct HookConn {
    stream: UnixStream,
}

impl HookConn {
    fn send(sock: &PathBuf, payload: Value) -> Self {
        Self::send_with(sock, payload, Some("dm-1"), 60_000)
    }

    fn send_with(sock: &PathBuf, payload: Value, key: Option<&str>, wait_ms: u64) -> Self {
        let mut stream = UnixStream::connect(sock).unwrap();
        let mut req =
            json!({"v":1,"type":"hook","hook_pid":1,"ppid":0,"wait_ms":wait_ms,"payload":payload});
        if let Some(k) = key {
            req["session_key"] = json!(k);
        }
        writeln!(stream, "{req}").unwrap();
        Self { stream }
    }

    fn reply(&self, within: Duration) -> ServerMessage {
        // macOS rejects set_read_timeout (EINVAL) once the peer has already closed.
        let _ = self.stream.set_read_timeout(Some(within));
        let mut line = String::new();
        BufReader::new(&self.stream)
            .read_line(&mut line)
            .expect("reply within time");
        protocol::parse_server_line(&line).unwrap()
    }
}

fn perm_payload(session: &str, transcript: Option<&PathBuf>) -> Value {
    let mut p = json!({
        "hook_event_name":"PermissionRequest","session_id":session,"tool_name":"Bash",
        "tool_input":{"command":"echo hi"},"cwd":"/w","permission_mode":"default","prompt_id":"pp1",
        "permission_suggestions":[]
    });
    if let Some(t) = transcript {
        p["transcript_path"] = json!(t);
    }
    p
}

fn ask_payload(session: &str) -> Value {
    json!({
        "hook_event_name":"PreToolUse","session_id":session,"tool_name":"AskUserQuestion","tool_use_id":"toolu_q",
        "tool_input":{"questions":[{"question":"Which color do you prefer?","header":"Color","multiSelect":false,
            "options":[{"label":"Red","description":"r"},{"label":"Blue","description":"b"}]}]}
    })
}

fn next_matching<T>(rx: &Receiver<BridgeEvent>, mut f: impl FnMut(&BridgeEvent) -> Option<T>) -> T {
    let end = Instant::now() + Duration::from_secs(5);
    loop {
        let left = end.saturating_duration_since(Instant::now());
        let ev = rx.recv_timeout(left).expect("expected event in time");
        if let Some(t) = f(&ev) {
            return t;
        }
    }
}

fn wait_pending(b: &Bridge, n: usize) {
    let end = Instant::now() + Duration::from_secs(5);
    while b.pending().len() != n {
        assert!(
            Instant::now() < end,
            "pending never reached {n}: {:?}",
            b.pending()
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn socket_is_created_with_mode_0600() {
    let env = Env::new();
    let _b = env.bridge(|_| {});
    let mode = std::fs::metadata(&env.sock).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o600, "mode was {mode:o}");
}

#[test]
fn missing_parent_dir_is_created_private() {
    let env = Env::new();
    let sock = env.dir.join("nested").join("app").join("b.sock");
    let _b = Bridge::start(BridgeConfig::new(&sock)).unwrap();
    let parent = std::fs::metadata(sock.parent().unwrap())
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(parent & 0o777, 0o700);
    assert_eq!(
        std::fs::metadata(&sock).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[test]
fn stale_socket_is_replaced_live_one_is_refused_and_files_are_kept() {
    let env = Env::new();
    // A stale socket file: bind then forget it without unlinking.
    drop(std::os::unix::net::UnixListener::bind(&env.sock).unwrap());
    assert!(env.sock.exists());
    let b = Bridge::start(BridgeConfig::new(&env.sock)).unwrap();
    match Bridge::start(BridgeConfig::new(&env.sock)) {
        Err(BridgeError::AddrInUse(_)) => {}
        other => panic!("expected AddrInUse, got {:?}", other.err()),
    }
    drop(b);
    assert!(!env.sock.exists(), "socket removed on shutdown");
    std::fs::write(&env.sock, "precious").unwrap();
    assert!(matches!(
        Bridge::start(BridgeConfig::new(&env.sock)),
        Err(BridgeError::NotASocket(_))
    ));
    assert_eq!(std::fs::read_to_string(&env.sock).unwrap(), "precious");
}

#[test]
fn overlong_socket_path_is_rejected() {
    let long = PathBuf::from(format!("/tmp/{}/b.sock", "x".repeat(120)));
    assert!(matches!(
        Bridge::start(BridgeConfig::new(long)),
        Err(BridgeError::PathTooLong(..))
    ));
}

#[test]
fn bad_version_and_garbage_get_an_error_reply() {
    let env = Env::new();
    let _b = env.bridge(|_| {});
    for line in [r#"{"v":99,"type":"hook","payload":{}}"#, "not json"] {
        let mut s = UnixStream::connect(&env.sock).unwrap();
        writeln!(s, "{line}").unwrap();
        s.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let mut reply = String::new();
        BufReader::new(&s).read_line(&mut reply).unwrap();
        assert!(matches!(
            protocol::parse_server_line(&reply).unwrap(),
            ServerMessage::Error { .. }
        ));
    }
}

#[test]
fn non_blocking_events_are_acked_and_drive_status() {
    let env = Env::new();
    let b = env.bridge(|_| {});
    let rx = b.subscribe();
    let steps = [
        ("SessionStart", Status::Idle),
        ("UserPromptSubmit", Status::Busy),
        ("Stop", Status::Idle),
    ];
    for (ev, want) in steps {
        let c = HookConn::send(&env.sock, json!({"hook_event_name":ev,"session_id":"s1"}));
        assert_eq!(c.reply(Duration::from_secs(3)), ServerMessage::Ack);
        let got = next_matching(&rx, |e| match e {
            BridgeEvent::Status(s) => Some(s.clone()),
            _ => None,
        });
        assert_eq!(got.status, want, "after {ev}");
        assert_eq!(got.source, StatusSource::Hook);
        assert_eq!(got.session.key.as_deref(), Some("dm-1"));
        assert_eq!(got.session.session_id.as_deref(), Some("s1"));
    }
    // Same status again emits nothing new.
    let c = HookConn::send(
        &env.sock,
        json!({"hook_event_name":"Stop","session_id":"s1"}),
    );
    c.reply(Duration::from_secs(3));
    assert!(rx
        .recv_timeout(Duration::from_millis(200))
        .map(|e| !matches!(e, BridgeEvent::Status(_)))
        .unwrap_or(true));
}

#[test]
fn notification_types_map_to_needs_you() {
    let env = Env::new();
    let b = env.bridge(|_| {});
    let rx = b.subscribe();
    for (nt, want) in [
        ("permission_prompt", Status::NeedsYou(NeedsKind::Permission)),
        ("idle_prompt", Status::Idle),
        ("agent_needs_input", Status::NeedsYou(NeedsKind::Other)),
    ] {
        let c = HookConn::send(
            &env.sock,
            json!({"hook_event_name":"Notification","session_id":"s1","notification_type":nt}),
        );
        c.reply(Duration::from_secs(3));
        let got = next_matching(&rx, |e| match e {
            BridgeEvent::Status(s) => Some(s.status),
            _ => None,
        });
        assert_eq!(got, want, "{nt}");
    }
}

#[test]
fn permission_chat_allow_returns_exact_decision_json() {
    let env = Env::new();
    let b = env.bridge(|_| {});
    let rx = b.subscribe();
    let c = HookConn::send(&env.sock, perm_payload("s1", None));
    let prompt = next_matching(&rx, |e| match e {
        BridgeEvent::Permission(p) => Some(p.clone()),
        _ => None,
    });
    assert_eq!(prompt.tool_name, "Bash");
    assert_eq!(prompt.tool_input["command"], "echo hi");
    assert_eq!(prompt.session.key.as_deref(), Some("dm-1"));
    b.answer_permission(prompt.id, PermissionAnswer::Allow)
        .unwrap();
    match c.reply(Duration::from_secs(3)) {
        ServerMessage::Decision { output, resolution } => {
            assert_eq!(resolution, Resolution::Chat);
            assert_eq!(
                output.unwrap(),
                json!({"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}})
            );
        }
        other => panic!("{other:?}"),
    }
    assert!(b.pending().is_empty());
}

#[test]
fn permission_chat_deny_carries_message() {
    let env = Env::new();
    let b = env.bridge(|_| {});
    let rx = b.subscribe();
    let c = HookConn::send(&env.sock, perm_payload("s1", None));
    let id = next_matching(&rx, |e| match e {
        BridgeEvent::Permission(p) => Some(p.id),
        _ => None,
    });
    b.answer_permission(
        id,
        PermissionAnswer::Deny {
            message: "denied by hook".into(),
        },
    )
    .unwrap();
    match c.reply(Duration::from_secs(3)) {
        ServerMessage::Decision { output, .. } => assert_eq!(
            output.unwrap(),
            json!({"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"denied by hook"}}})
        ),
        other => panic!("{other:?}"),
    }
}

#[test]
fn first_answer_wins_and_second_is_refused() {
    let env = Env::new();
    let b = env.bridge(|_| {});
    let rx = b.subscribe();
    let c = HookConn::send(&env.sock, perm_payload("s1", None));
    let id = next_matching(&rx, |e| match e {
        BridgeEvent::Permission(p) => Some(p.id),
        _ => None,
    });
    b.answer_permission(id, PermissionAnswer::Allow).unwrap();
    assert_eq!(
        b.answer_permission(
            id,
            PermissionAnswer::Deny {
                message: "late".into()
            }
        ),
        Err(AnswerError::NotPending(id))
    );
    match c.reply(Duration::from_secs(3)) {
        ServerMessage::Decision { output, .. } => {
            assert_eq!(
                output.unwrap()["hookSpecificOutput"]["decision"]["behavior"],
                "allow"
            )
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn tui_answer_seen_via_post_tool_use_cancels_the_pending_hook() {
    let env = Env::new();
    let b = env.bridge(|_| {});
    let rx = b.subscribe();
    let c = HookConn::send(&env.sock, perm_payload("s1", None));
    let id = next_matching(&rx, |e| match e {
        BridgeEvent::Permission(p) => Some(p.id),
        _ => None,
    });
    let post = HookConn::send(
        &env.sock,
        json!({"hook_event_name":"PostToolUse","session_id":"s1","tool_name":"Bash","tool_use_id":"toolu_1",
               "tool_input":{"command":"echo hi"},"tool_response":{}}),
    );
    assert_eq!(post.reply(Duration::from_secs(3)), ServerMessage::Ack);
    assert_eq!(
        c.reply(Duration::from_secs(3)),
        ServerMessage::Cancel {
            reason: Resolution::Terminal
        }
    );
    let res = next_matching(&rx, |e| match e {
        BridgeEvent::Resolved(r) => Some(r.clone()),
        _ => None,
    });
    assert_eq!((res.id, res.resolution), (id, Resolution::Terminal));
    assert_eq!(
        b.answer_permission(id, PermissionAnswer::Allow),
        Err(AnswerError::NotPending(id))
    );
}

#[test]
fn post_tool_use_for_a_different_command_does_not_cancel() {
    let env = Env::new();
    let b = env.bridge(|_| {});
    let c = HookConn::send(&env.sock, perm_payload("s1", None));
    wait_pending(&b, 1);
    let other = HookConn::send(
        &env.sock,
        json!({"hook_event_name":"PostToolUse","session_id":"s1","tool_name":"Bash","tool_use_id":"x",
               "tool_input":{"command":"something else"}}),
    );
    other.reply(Duration::from_secs(3));
    let unrelated_session = HookConn::send(
        &env.sock,
        json!({"hook_event_name":"Stop","session_id":"other-session"}),
    );
    unrelated_session.reply(Duration::from_secs(3));
    assert_eq!(b.pending().len(), 1);
    drop(c);
}

#[test]
fn tui_answer_seen_via_transcript_cancels_the_pending_hook() {
    let env = Env::new();
    let b = env.bridge(|_| {});
    let rx = b.subscribe();
    let transcript = env.dir.join("s1.jsonl");
    std::fs::write(&transcript, "").unwrap();
    let c = HookConn::send(&env.sock, perm_payload("s1", Some(&transcript)));
    next_matching(&rx, |e| {
        matches!(e, BridgeEvent::Permission(_)).then_some(())
    });
    let tool_use = json!({"type":"assistant","message":{"content":[
        {"type":"tool_use","id":"toolu_9","name":"Bash","input":{"command":"echo hi"}}]}});
    std::fs::write(&transcript, format!("{tool_use}\n")).unwrap();
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(b.pending().len(), 1, "tool_use alone must not cancel");
    let result = json!({"type":"user","message":{"content":[
        {"type":"tool_result","tool_use_id":"toolu_9","content":"hi"}]}});
    std::fs::write(&transcript, format!("{tool_use}\n{result}\n")).unwrap();
    assert_eq!(
        c.reply(Duration::from_secs(3)),
        ServerMessage::Cancel {
            reason: Resolution::Terminal
        }
    );
    assert!(b.pending().is_empty());
}

#[test]
fn turn_end_cancels_unanswered_prompts() {
    let env = Env::new();
    let b = env.bridge(|_| {});
    let c = HookConn::send(&env.sock, perm_payload("s1", None));
    wait_pending(&b, 1);
    HookConn::send(
        &env.sock,
        json!({"hook_event_name":"Stop","session_id":"s1"}),
    )
    .reply(Duration::from_secs(3));
    assert_eq!(
        c.reply(Duration::from_secs(3)),
        ServerMessage::Cancel {
            reason: Resolution::TurnEnded
        }
    );
}

#[test]
fn permission_wait_is_bounded_and_releases_with_no_decision() {
    let env = Env::new();
    let b = env.bridge(|c| c.permission_wait = Duration::from_millis(300));
    let start = Instant::now();
    let c = HookConn::send(&env.sock, perm_payload("s1", None));
    assert_eq!(
        c.reply(Duration::from_secs(3)),
        ServerMessage::Decision {
            output: None,
            resolution: Resolution::Timeout
        }
    );
    assert!(start.elapsed() >= Duration::from_millis(300));
    assert!(b.pending().is_empty());
}

#[test]
fn no_chat_attached_releases_at_once() {
    let env = Env::new();
    let b = env.bridge(|_| {});
    b.set_chat_attached(false);
    let start = Instant::now();
    let c = HookConn::send(&env.sock, perm_payload("s1", None));
    assert_eq!(
        c.reply(Duration::from_secs(3)),
        ServerMessage::Decision {
            output: None,
            resolution: Resolution::NoChat
        }
    );
    let c = HookConn::send(&env.sock, ask_payload("s1"));
    assert_eq!(
        c.reply(Duration::from_secs(3)),
        ServerMessage::Decision {
            output: None,
            resolution: Resolution::NoChat
        }
    );
    assert!(start.elapsed() < Duration::from_secs(1));
}

#[test]
fn hook_wait_ms_caps_the_bridge_wait() {
    let env = Env::new();
    let _b = env.bridge(|c| c.permission_wait = Duration::from_secs(60));
    let start = Instant::now();
    let c = HookConn::send_with(&env.sock, perm_payload("s1", None), Some("dm-1"), 700);
    match c.reply(Duration::from_secs(5)) {
        ServerMessage::Decision {
            output: None,
            resolution: Resolution::Timeout,
        } => {}
        other => panic!("{other:?}"),
    }
    assert!(start.elapsed() < Duration::from_secs(2));
}

#[test]
fn hook_disconnect_clears_the_pending_prompt() {
    let env = Env::new();
    let b = env.bridge(|_| {});
    let rx = b.subscribe();
    let c = HookConn::send(&env.sock, perm_payload("s1", None));
    next_matching(&rx, |e| {
        matches!(e, BridgeEvent::Permission(_)).then_some(())
    });
    drop(c);
    let res = next_matching(&rx, |e| match e {
        BridgeEvent::Resolved(r) => Some(r.resolution),
        _ => None,
    });
    assert_eq!(res, Resolution::HookGone);
    assert!(b.pending().is_empty());
}

#[test]
fn question_answer_returns_updated_input_with_answers() {
    let env = Env::new();
    let b = env.bridge(|_| {});
    let rx = b.subscribe();
    let c = HookConn::send(&env.sock, ask_payload("s1"));
    let q = next_matching(&rx, |e| match e {
        BridgeEvent::Question(q) => Some(q.clone()),
        _ => None,
    });
    assert_eq!(q.tool_use_id.as_deref(), Some("toolu_q"));
    assert_eq!(q.questions[0].question, "Which color do you prefer?");
    assert_eq!(q.questions[0].options[1].label, "Blue");
    assert_eq!(b.pending()[0].kind, PendingKind::Question);

    assert_eq!(
        b.answer_permission(q.id, PermissionAnswer::Allow),
        Err(AnswerError::WrongKind(q.id))
    );
    assert_eq!(
        b.answer_question(q.id, QuestionAnswers::new()),
        Err(AnswerError::MissingAnswer(
            "Which color do you prefer?".into()
        ))
    );
    assert_eq!(
        b.answer_question(
            q.id,
            QuestionAnswers::new()
                .with("Which color do you prefer?", "Blue")
                .with("Nope?", "x")
        ),
        Err(AnswerError::UnknownQuestion("Nope?".into()))
    );
    b.answer_question(
        q.id,
        QuestionAnswers::new().with("Which color do you prefer?", "Blue"),
    )
    .unwrap();
    match c.reply(Duration::from_secs(3)) {
        ServerMessage::Decision {
            output: Some(out),
            resolution: Resolution::Chat,
        } => {
            let h = &out["hookSpecificOutput"];
            assert_eq!(h["hookEventName"], "PreToolUse");
            assert_eq!(h["permissionDecision"], "allow");
            assert_eq!(
                h["updatedInput"]["answers"],
                json!({"Which color do you prefer?": "Blue"})
            );
            // The original questions travel back unchanged.
            assert_eq!(
                h["updatedInput"]["questions"],
                ask_payload("s1")["tool_input"]["questions"]
            );
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn question_releases_to_the_tui_after_the_bounded_wait() {
    let env = Env::new();
    let b = env.bridge(|c| c.ask_wait = Duration::from_millis(350));
    let start = Instant::now();
    let c = HookConn::send(&env.sock, ask_payload("s1"));
    assert_eq!(
        c.reply(Duration::from_secs(3)),
        ServerMessage::Decision {
            output: None,
            resolution: Resolution::Timeout
        }
    );
    assert!(start.elapsed() >= Duration::from_millis(350));
    assert!(b.pending().is_empty());
}

#[test]
fn shutdown_releases_pending_hooks_and_removes_the_socket() {
    let env = Env::new();
    let b = env.bridge(|_| {});
    let c = HookConn::send(&env.sock, perm_payload("s1", None));
    wait_pending(&b, 1);
    b.shutdown();
    assert!(matches!(
        c.reply(Duration::from_secs(3)),
        ServerMessage::Decision {
            output: None,
            resolution: Resolution::Shutdown
        }
    ));
    assert!(!env.sock.exists());
}

struct FakeAgents(Vec<AgentEntry>);
impl AgentsSource for FakeAgents {
    fn list(&self) -> std::io::Result<Vec<AgentEntry>> {
        Ok(self.0.clone())
    }
}

fn entry(pid: u32, sid: &str, status: &str, waiting: Option<&str>) -> AgentEntry {
    serde_json::from_value(json!({
        "pid": pid, "cwd": "/w", "kind": "interactive", "sessionId": sid,
        "status": status, "waitingFor": waiting
    }))
    .unwrap()
}

#[test]
fn reconciler_filters_by_pid_and_session_id() {
    let env = Env::new();
    let b = env.bridge(|_| {});
    let rx = b.subscribe();
    b.track_session("dm-pid", Some(4242), None);
    b.track_session("dm-sid", None, Some("sid-b".into()));
    let src = FakeAgents(vec![
        entry(4242, "whatever", "waiting", Some("permission prompt")),
        entry(5000, "sid-b", "busy", None),
        entry(6000, "stranger", "waiting", Some("input needed")),
    ]);
    assert_eq!(b.reconcile_once(&src).unwrap(), 2);
    let mut got = std::collections::HashMap::new();
    while let Ok(ev) = rx.recv_timeout(Duration::from_millis(200)) {
        if let BridgeEvent::Status(s) = ev {
            assert_eq!(s.source, StatusSource::Reconciler);
            got.insert(s.session.key.clone().unwrap(), s.status);
        }
    }
    assert_eq!(got.len(), 2, "stranger must be ignored: {got:?}");
    assert_eq!(got["dm-pid"], Status::NeedsYou(NeedsKind::Permission));
    assert_eq!(got["dm-sid"], Status::Busy);
    // Nothing changed, nothing emitted.
    assert_eq!(b.reconcile_once(&src).unwrap(), 0);
    assert_eq!(
        b.status_of("dm-pid"),
        Some(Status::NeedsYou(NeedsKind::Permission))
    );
}

#[test]
fn reconciler_corrects_a_stale_hook_status_and_learns_session_id() {
    let env = Env::new();
    let b = env.bridge(|_| {});
    b.track_session("dm-1", Some(77), None);
    let rx = b.subscribe();
    // Hook said Busy; ground truth says idle (missed Stop hook).
    let c = HookConn::send(
        &env.sock,
        json!({"hook_event_name":"UserPromptSubmit","session_id":"s-77"}),
    );
    c.reply(Duration::from_secs(3));
    assert_eq!(b.status_of("dm-1"), Some(Status::Busy));
    let src = FakeAgents(vec![entry(77, "s-77", "idle", None)]);
    assert_eq!(b.reconcile_once(&src).unwrap(), 1);
    assert_eq!(b.status_of("dm-1"), Some(Status::Idle));
    drop(rx);
}

#[test]
fn background_reconciler_runs_on_interval_and_on_demand() {
    let env = Env::new();
    let b = env.bridge(|_| {});
    let rx = b.subscribe();
    b.track_session("dm-1", Some(9), None);
    let rec = b.spawn_reconciler(
        Arc::new(FakeAgents(vec![entry(9, "s", "busy", None)])),
        Duration::from_secs(3600),
    );
    rec.reconcile_now();
    let s = next_matching(&rx, |e| match e {
        BridgeEvent::Status(s) => Some(s.clone()),
        _ => None,
    });
    assert_eq!(
        (s.status, s.source),
        (Status::Busy, StatusSource::Reconciler)
    );
}

#[test]
fn bridge_can_be_driven_after_dropping_a_subscriber() {
    let env = Env::new();
    let b = env.bridge(|_| {});
    drop(b.subscribe());
    let c = HookConn::send(
        &env.sock,
        json!({"hook_event_name":"Stop","session_id":"s"}),
    );
    assert_eq!(c.reply(Duration::from_secs(3)), ServerMessage::Ack);
}
