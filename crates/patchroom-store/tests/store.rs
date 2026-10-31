//! Integration tests against a real SQLite file.

use patchroom_store::*;
use proptest::prelude::*;
use rusqlite::Connection;

fn me() -> Author {
    Author::me()
}

fn agent(n: &str) -> Author {
    Author::Agent(n.into())
}

struct Fixture {
    _dir: tempfile::TempDir,
    store: Store,
    ws: Workspace,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let ws = store.create_workspace(&me(), "Home").unwrap();
    Fixture {
        _dir: dir,
        store,
        ws,
    }
}

fn new_conv(ws: &Workspace, kind: ConversationKind, name: &str) -> NewConversation {
    NewConversation {
        workspace_id: ws.id,
        section_id: None,
        kind,
        name: name.into(),
        provider: None,
        cwd: None,
        worktree: None,
        session_id: None,
        assign_mode: None,
    }
}

fn dm(f: &Fixture, name: &str) -> Conversation {
    f.store
        .create_conversation(&me(), &new_conv(&f.ws, ConversationKind::Dm, name))
        .unwrap()
}

fn channel(f: &Fixture, name: &str) -> Conversation {
    f.store
        .create_conversation(&me(), &new_conv(&f.ws, ConversationKind::Channel, name))
        .unwrap()
}

fn say(f: &Fixture, conv: &Conversation, body: &str) -> Message {
    f.store
        .append_message(&NewMessage {
            conversation_id: conv.id,
            author: me(),
            kind: MessageKind::User,
            body: body.into(),
            source_ref: None,
        })
        .unwrap()
}

// ---- migrations and pragmas ----

#[test]
fn migrates_from_empty_file_with_wal_and_foreign_keys() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(DB_FILE);
    assert!(!path.exists());
    let store = Store::open(dir.path()).unwrap();
    assert!(path.exists());
    assert_eq!(store.schema_version().unwrap(), migrate::LATEST_VERSION);
    assert_eq!(store.journal_mode().unwrap(), "wal");
    assert!(store.foreign_keys_enabled().unwrap());
    assert_eq!(store.path(), Some(path.as_path()));
}

#[test]
fn creates_missing_data_dir() {
    let dir = tempfile::tempdir().unwrap();
    let nested = dir.path().join("a").join("b");
    Store::open(&nested).unwrap();
    assert!(nested.join(DB_FILE).exists());
}

#[test]
fn reopen_is_idempotent_and_keeps_data() {
    let dir = tempfile::tempdir().unwrap();
    let id = {
        let s = Store::open(dir.path()).unwrap();
        s.create_workspace(&me(), "Keep").unwrap().id
    };
    let s = Store::open(dir.path()).unwrap();
    assert_eq!(s.schema_version().unwrap(), migrate::LATEST_VERSION);
    assert_eq!(s.workspace(id).unwrap().name, "Keep");
}

#[test]
fn refuses_database_from_newer_build() {
    let dir = tempfile::tempdir().unwrap();
    drop(Store::open(dir.path()).unwrap());
    let conn = Connection::open(dir.path().join(DB_FILE)).unwrap();
    conn.pragma_update(None, "user_version", migrate::LATEST_VERSION + 1)
        .unwrap();
    drop(conn);
    let err = Store::open(dir.path()).unwrap_err();
    assert!(matches!(err, Error::SchemaTooNew { .. }), "{err}");
}

#[test]
fn every_table_has_id_author_and_timestamps() {
    let dir = tempfile::tempdir().unwrap();
    drop(Store::open(dir.path()).unwrap());
    let conn = Connection::open(dir.path().join(DB_FILE)).unwrap();
    let tables: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    for expected in [
        "workspace",
        "section",
        "conversation",
        "membership",
        "message",
        "comment",
        "attachment",
        "task",
        "claim",
        "reaction",
        "pin",
        "draft",
        "plugin",
        "setting",
    ] {
        assert!(
            tables.iter().any(|t| t == expected),
            "missing table {expected}"
        );
    }
    for t in &tables {
        let cols: Vec<String> = conn
            .prepare(&format!("SELECT name FROM pragma_table_info('{t}')"))
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        for need in ["id", "author", "created_at", "updated_at"] {
            assert!(cols.iter().any(|c| c == need), "{t} lacks {need}");
        }
    }
}

#[test]
fn schema_declares_no_secret_columns() {
    for sql in migrate::all_sql() {
        for line in sql.lines().map(str::trim).filter(|l| !l.starts_with("--")) {
            let col = line.split_whitespace().next().unwrap_or("");
            assert!(
                !is_secret_like_key(col),
                "schema column looks like a secret: {line}"
            );
        }
    }
}

#[test]
fn foreign_keys_are_enforced() {
    let f = fixture();
    let ghost = Conversation {
        id: ulid::Ulid::generate(),
        ..dm(&f, "x")
    };
    let err = f
        .store
        .append_message(&NewMessage {
            conversation_id: ghost.id,
            author: me(),
            kind: MessageKind::User,
            body: "hi".into(),
            source_ref: None,
        })
        .unwrap_err();
    assert!(matches!(err, Error::Sqlite(_)), "{err}");
}

#[test]
fn ids_are_unique_and_increasing() {
    let f = fixture();
    let a = dm(&f, "a");
    let b = dm(&f, "b");
    assert!(b.id > a.id);
    assert!(a.created_at > 0 && a.updated_at >= a.created_at);
}

// ---- workspaces, sections, conversations ----

#[test]
fn workspace_round_trip_rename_delete() {
    let f = fixture();
    assert_eq!(f.store.workspace(f.ws.id).unwrap(), f.ws);
    let r = f.store.rename_workspace(f.ws.id, "Renamed").unwrap();
    assert_eq!(r.name, "Renamed");
    assert!(r.updated_at >= f.ws.updated_at);
    assert_eq!(f.store.list_workspaces().unwrap().len(), 1);
    assert!(f.store.create_workspace(&me(), "  ").is_err());
    f.store.delete_workspace(f.ws.id).unwrap();
    assert!(matches!(
        f.store.workspace(f.ws.id),
        Err(Error::NotFound { .. })
    ));
}

#[test]
fn sections_order_rename_collapse() {
    let f = fixture();
    let names = ["Starred", "Channels", "DMs", "Archived"];
    let secs: Vec<Section> = names
        .iter()
        .map(|n| f.store.create_section(&me(), f.ws.id, n).unwrap())
        .collect();
    assert_eq!(
        secs.iter().map(|s| s.position).collect::<Vec<_>>(),
        [0, 1, 2, 3]
    );

    let order = [secs[3].id, secs[0].id, secs[2].id, secs[1].id];
    f.store.reorder_sections(f.ws.id, &order).unwrap();
    let listed: Vec<Id> = f
        .store
        .list_sections(f.ws.id)
        .unwrap()
        .iter()
        .map(|s| s.id)
        .collect();
    assert_eq!(listed, order);

    assert!(f.store.reorder_sections(f.ws.id, &order[..3]).is_err());
    assert!(f.store.reorder_sections(f.ws.id, &[order[0]; 4]).is_err());

    let c = f.store.set_section_collapsed(secs[0].id, true).unwrap();
    assert!(c.collapsed);
    assert_eq!(
        f.store.rename_section(secs[0].id, "Pinned").unwrap().name,
        "Pinned"
    );
    f.store.delete_section(secs[1].id).unwrap();
    assert_eq!(f.store.list_sections(f.ws.id).unwrap().len(), 3);
}

#[test]
fn sections_survive_restart() {
    let dir = tempfile::tempdir().unwrap();
    let (ws, a, b);
    {
        let s = Store::open(dir.path()).unwrap();
        ws = s.create_workspace(&me(), "W").unwrap();
        a = s.create_section(&me(), ws.id, "A").unwrap();
        b = s.create_section(&me(), ws.id, "B").unwrap();
        s.reorder_sections(ws.id, &[b.id, a.id]).unwrap();
        s.set_section_collapsed(a.id, true).unwrap();
    }
    let s = Store::open(dir.path()).unwrap();
    let got = s.list_sections(ws.id).unwrap();
    assert_eq!(got.iter().map(|x| x.id).collect::<Vec<_>>(), [b.id, a.id]);
    assert!(got[1].collapsed);
}

#[test]
fn conversation_round_trip_and_updates() {
    let f = fixture();
    let sec = f.store.create_section(&me(), f.ws.id, "DMs").unwrap();
    let mut n = new_conv(&f.ws, ConversationKind::Dm, "claude-1");
    n.section_id = Some(sec.id);
    n.provider = Some("claude".into());
    n.cwd = Some("/tmp/proj".into());
    n.worktree = Some("/tmp/wt".into());
    n.session_id = Some("sess-1".into());
    let c = f.store.create_conversation(&agent("claude"), &n).unwrap();
    assert_eq!(f.store.conversation(c.id).unwrap(), c);
    assert_eq!(c.author, agent("claude"));
    assert_eq!(c.adapter_state, "{}");
    assert_eq!(c.provider.as_deref(), Some("claude"));

    let c = f.store.rename_conversation(c.id, "claude-2").unwrap();
    assert_eq!(c.name, "claude-2");
    let c = f
        .store
        .set_conversation_session(c.id, Some("sess-2"))
        .unwrap();
    assert_eq!(c.session_id.as_deref(), Some("sess-2"));
    let c = f.store.set_conversation_worktree(c.id, None).unwrap();
    assert_eq!(c.worktree, None);
    let c = f.store.set_adapter_state(c.id, r#"{"pid":42}"#).unwrap();
    assert_eq!(c.adapter_state, r#"{"pid":42}"#);
    assert!(f.store.set_adapter_state(c.id, "not json").is_err());

    f.store.delete_section(sec.id).unwrap();
    assert_eq!(f.store.conversation(c.id).unwrap().section_id, None);
    f.store.delete_conversation(c.id).unwrap();
    assert!(f.store.conversation(c.id).is_err());
}

#[test]
fn dm_rejects_assign_mode_and_blank_name() {
    let f = fixture();
    let mut n = new_conv(&f.ws, ConversationKind::Dm, "x");
    n.assign_mode = Some(AssignMode::Lead);
    assert!(f.store.create_conversation(&me(), &n).is_err());
    let blank = new_conv(&f.ws, ConversationKind::Dm, " ");
    assert!(f.store.create_conversation(&me(), &blank).is_err());
}

#[test]
fn move_conversation_between_sections() {
    let f = fixture();
    let s1 = f.store.create_section(&me(), f.ws.id, "S1").unwrap();
    let s2 = f.store.create_section(&me(), f.ws.id, "S2").unwrap();
    let mk = |n: &str, s: Id| {
        let mut c = new_conv(&f.ws, ConversationKind::Dm, n);
        c.section_id = Some(s);
        f.store.create_conversation(&me(), &c).unwrap()
    };
    let a = mk("a", s1.id);
    let b = mk("b", s1.id);
    let c = mk("c", s1.id);
    let x = mk("x", s2.id);
    let ids = |s: Id| -> Vec<Id> {
        f.store
            .list_section_conversations(s)
            .unwrap()
            .iter()
            .map(|c| c.id)
            .collect()
    };
    assert_eq!(ids(s1.id), [a.id, b.id, c.id]);

    f.store.move_conversation(c.id, Some(s1.id), 0).unwrap();
    assert_eq!(ids(s1.id), [c.id, a.id, b.id]);
    f.store.move_conversation(a.id, Some(s2.id), 0).unwrap();
    assert_eq!(ids(s2.id), [a.id, x.id]);
    assert_eq!(ids(s1.id), [c.id, b.id]);
    f.store.move_conversation(b.id, Some(s2.id), 99).unwrap();
    assert_eq!(ids(s2.id), [a.id, x.id, b.id]);
    f.store.move_conversation(b.id, None, 0).unwrap();
    assert_eq!(f.store.conversation(b.id).unwrap().section_id, None);

    let other = f.store.create_workspace(&me(), "Other").unwrap();
    let foreign = f.store.create_section(&me(), other.id, "F").unwrap();
    assert!(f
        .store
        .move_conversation(c.id, Some(foreign.id), 0)
        .is_err());

    // Workspace listing: sectioned conversations first by section order, unplaced last.
    let all: Vec<Id> = f
        .store
        .list_conversations(f.ws.id)
        .unwrap()
        .iter()
        .map(|c| c.id)
        .collect();
    assert_eq!(all, [c.id, a.id, x.id, b.id]);
}

#[test]
fn memberships_link_dms_to_channels() {
    let f = fixture();
    let ch = channel(&f, "room");
    let d1 = dm(&f, "d1");
    let d2 = dm(&f, "d2");
    let m1 = f.store.add_member(&me(), ch.id, d1.id).unwrap();
    assert_eq!(f.store.add_member(&me(), ch.id, d1.id).unwrap(), m1);
    f.store.add_member(&me(), ch.id, d2.id).unwrap();
    assert_eq!(f.store.list_members(ch.id).unwrap().len(), 2);
    assert_eq!(f.store.list_channels_of(d1.id).unwrap(), vec![m1]);
    assert!(f.store.add_member(&me(), d1.id, ch.id).is_err());
    assert!(f.store.add_member(&me(), d1.id, d2.id).is_err());
    f.store.remove_member(ch.id, d1.id).unwrap();
    assert!(f.store.remove_member(ch.id, d1.id).is_err());
    f.store.delete_conversation(d2.id).unwrap();
    assert!(f.store.list_members(ch.id).unwrap().is_empty());
}

#[test]
fn channel_assign_mode_and_lead() {
    let f = fixture();
    let ch = channel(&f, "room");
    let lead = dm(&f, "lead");
    let c = f
        .store
        .set_assign_mode(ch.id, AssignMode::Lead, Some(lead.id))
        .unwrap();
    assert_eq!(
        (c.assign_mode, c.lead_id),
        (Some(AssignMode::Lead), Some(lead.id))
    );
    assert!(f
        .store
        .set_assign_mode(lead.id, AssignMode::Mention, None)
        .is_err());
}

// ---- messages and comments ----

#[test]
fn message_round_trip_paging_and_cascade() {
    let f = fixture();
    let c = dm(&f, "d");
    let msgs: Vec<Message> = (0..5).map(|i| say(&f, &c, &format!("m{i}"))).collect();
    assert_eq!(f.store.message(msgs[2].id).unwrap(), msgs[2]);
    let page = f.store.list_messages(c.id, 2, 1).unwrap();
    assert_eq!(
        page.iter().map(|m| m.body.as_str()).collect::<Vec<_>>(),
        ["m1", "m2"]
    );
    assert_eq!(f.store.count_messages(c.id).unwrap(), 5);
    f.store.delete_message(msgs[0].id).unwrap();
    f.store.delete_conversation(c.id).unwrap();
    assert!(f.store.message(msgs[1].id).is_err());
}

#[test]
fn source_ref_mirroring_is_idempotent() {
    let f = fixture();
    let c = dm(&f, "d");
    let n = |body: &str| NewMessage {
        conversation_id: c.id,
        author: agent("claude"),
        kind: MessageKind::Assistant,
        body: body.into(),
        source_ref: Some("uuid-1".into()),
    };
    let a = f.store.append_message(&n("partial")).unwrap();
    let b = f.store.append_message(&n("partial answer")).unwrap();
    assert_eq!(a.id, b.id);
    assert_eq!(b.body, "partial answer");
    assert_eq!(f.store.count_messages(c.id).unwrap(), 1);
}

#[test]
fn comment_anchors_to_text_range() {
    let f = fixture();
    let c = dm(&f, "d");
    let m = say(&f, &c, "Use the bridge socket, not TCP.");
    let cm = f
        .store
        .create_comment(&me(), m.id, 8, 21, "why a socket?")
        .unwrap();
    assert_eq!(cm.quote, "bridge socket");
    assert_eq!((cm.range_start, cm.range_end), (8, 21));
    assert!(!cm.resolved && !cm.stale);
    assert_eq!(f.store.comment(cm.id).unwrap(), cm);

    assert!(f.store.create_comment(&me(), m.id, 5, 5, "").is_err());
    assert!(f.store.create_comment(&me(), m.id, 9, 5, "").is_err());
    assert!(f.store.create_comment(&me(), m.id, 0, 999, "").is_err());

    let e = f.store.edit_comment(cm.id, "edited").unwrap();
    assert_eq!(e.body, "edited");
    assert!(f.store.set_comment_resolved(cm.id, true).unwrap().resolved);
    assert_eq!(f.store.list_comments(m.id).unwrap().len(), 1);

    f.store.delete_comment(cm.id).unwrap();
    assert!(f.store.comment(cm.id).is_err());
}

#[test]
fn comment_range_respects_utf8_boundaries() {
    let f = fixture();
    let c = dm(&f, "d");
    let m = say(&f, &c, "caf\u{e9} ok");
    assert!(f
        .store
        .create_comment(&me(), m.id, 0, 4, "mid-char")
        .is_err());
    let ok = f.store.create_comment(&me(), m.id, 0, 5, "whole").unwrap();
    assert_eq!(ok.quote, "caf\u{e9}");
}

#[test]
fn editing_message_marks_moved_anchors_stale() {
    let f = fixture();
    let c = dm(&f, "d");
    let m = say(&f, &c, "alpha beta gamma");
    let kept = f.store.create_comment(&me(), m.id, 0, 5, "a").unwrap();
    let moved = f.store.create_comment(&me(), m.id, 6, 10, "b").unwrap();
    f.store.edit_message(m.id, "alpha BETA gamma").unwrap();
    assert!(!f.store.comment(kept.id).unwrap().stale);
    assert!(f.store.comment(moved.id).unwrap().stale);
    f.store.edit_message(m.id, "alpha beta gamma").unwrap();
    assert!(!f.store.comment(moved.id).unwrap().stale);
    f.store.delete_message(m.id).unwrap();
    assert!(f.store.comment(kept.id).is_err());
}

#[test]
fn attachments_reactions_pins_drafts() {
    let f = fixture();
    let c = dm(&f, "d");
    let m = say(&f, &c, "hello");

    let a = f
        .store
        .add_attachment(
            &me(),
            m.id,
            "screenshot",
            "shot.png",
            "/tmp/shot.png",
            Some("image/png"),
        )
        .unwrap();
    assert_eq!(f.store.list_attachments(m.id).unwrap(), vec![a]);

    let r = f.store.add_reaction(&me(), m.id, "\u{1f44d}").unwrap();
    assert_eq!(
        f.store.add_reaction(&me(), m.id, "\u{1f44d}").unwrap().id,
        r.id
    );
    f.store
        .add_reaction(&agent("x"), m.id, "\u{1f44d}")
        .unwrap();
    assert_eq!(f.store.list_reactions(m.id).unwrap().len(), 2);
    assert_eq!(
        f.store
            .messages_with_reaction(c.id, "\u{1f44d}")
            .unwrap()
            .len(),
        1
    );
    assert!(f.store.remove_reaction(&me(), m.id, "\u{1f44d}").unwrap());
    assert!(!f.store.remove_reaction(&me(), m.id, "\u{1f44d}").unwrap());
    assert!(f.store.add_reaction(&me(), m.id, " ").is_err());

    let p = f.store.add_pin(&me(), m.id, PinKind::Pin).unwrap();
    assert_eq!(f.store.add_pin(&me(), m.id, PinKind::Pin).unwrap().id, p.id);
    f.store.add_pin(&me(), m.id, PinKind::Saved).unwrap();
    assert_eq!(f.store.list_pins(c.id, PinKind::Pin).unwrap(), vec![p]);
    assert_eq!(f.store.list_pins(c.id, PinKind::Saved).unwrap().len(), 1);
    assert!(f.store.remove_pin(m.id, PinKind::Pin).unwrap());
    assert!(f.store.list_pins(c.id, PinKind::Pin).unwrap().is_empty());

    assert!(f.store.draft(c.id).unwrap().is_none());
    let d1 = f.store.set_draft(&me(), c.id, "wip").unwrap().unwrap();
    let d2 = f.store.set_draft(&me(), c.id, "wip 2").unwrap().unwrap();
    assert_eq!(d1.id, d2.id);
    assert_eq!(f.store.draft(c.id).unwrap().unwrap().body, "wip 2");
    assert!(f.store.set_draft(&me(), c.id, "").unwrap().is_none());
    assert!(f.store.draft(c.id).unwrap().is_none());
}

// ---- tasks and claims ----

#[test]
fn task_board_lifecycle() {
    let f = fixture();
    let ch = channel(&f, "room");
    let t1 = f
        .store
        .create_task(
            &me(),
            &NewTask {
                channel_id: ch.id,
                title: "one".into(),
                description: "d".into(),
            },
        )
        .unwrap();
    let t2 = f
        .store
        .create_task(
            &me(),
            &NewTask {
                channel_id: ch.id,
                title: "two".into(),
                description: String::new(),
            },
        )
        .unwrap();
    assert_eq!(
        (t1.status, t1.position, t2.position),
        (TaskStatus::Todo, 0, 1)
    );
    assert_eq!(f.store.task(t1.id).unwrap(), t1);

    let a = agent("a");
    let claimed = f.store.claim_task(t1.id, &a).unwrap();
    assert_eq!(
        (claimed.status, claimed.owner.clone()),
        (TaskStatus::Claimed, Some(a.clone()))
    );
    assert!(matches!(
        f.store.claim_task(t1.id, &agent("b")),
        Err(Error::Conflict(_))
    ));

    let w = f.store.set_task_status(t1.id, TaskStatus::Working).unwrap();
    assert_eq!(w.status, TaskStatus::Working);
    let g = f
        .store
        .set_task_git(
            t1.id,
            &TaskGit {
                worktree: Some("/wt".into()),
                branch: Some("feat/x".into()),
                pr_url: Some("https://example.com/pr/1".into()),
            },
        )
        .unwrap();
    assert_eq!(g.branch.as_deref(), Some("feat/x"));

    let assigned = f.store.assign_task(t2.id, Some(&agent("b"))).unwrap();
    assert_eq!(assigned.status, TaskStatus::Claimed);
    let cleared = f.store.assign_task(t2.id, None).unwrap();
    assert_eq!((cleared.status, cleared.owner), (TaskStatus::Todo, None));

    assert_eq!(
        f.store.edit_task(t2.id, "two!", "more").unwrap().title,
        "two!"
    );
    f.store.reorder_tasks(ch.id, &[t2.id, t1.id]).unwrap();
    let order: Vec<Id> = f
        .store
        .list_tasks(ch.id)
        .unwrap()
        .iter()
        .map(|t| t.id)
        .collect();
    assert_eq!(order, [t2.id, t1.id]);

    let dm = dm(&f, "d");
    assert!(f
        .store
        .create_task(
            &me(),
            &NewTask {
                channel_id: dm.id,
                title: "no".into(),
                description: String::new()
            }
        )
        .is_err());
    f.store.delete_task(t2.id).unwrap();
    assert_eq!(f.store.list_tasks(ch.id).unwrap().len(), 1);
}

#[test]
fn claims_detect_overlap_between_tasks() {
    let f = fixture();
    let ch = channel(&f, "room");
    let mk = |t: &str| {
        f.store
            .create_task(
                &me(),
                &NewTask {
                    channel_id: ch.id,
                    title: t.into(),
                    description: String::new(),
                },
            )
            .unwrap()
    };
    let (t1, t2) = (mk("one"), mk("two"));
    let c1 = f
        .store
        .claim_path(&agent("a"), t1.id, "./src//ui/")
        .unwrap();
    assert_eq!(c1.path, "src/ui");
    f.store.claim_path(&agent("a"), t1.id, "docs").unwrap();
    assert!(f.store.find_claim_conflicts(ch.id).unwrap().is_empty());

    let c2 = f
        .store
        .claim_path(&agent("b"), t2.id, "src/ui/button.rs")
        .unwrap();
    f.store.claim_path(&agent("b"), t2.id, "src/uix").unwrap();
    let conflicts = f.store.find_claim_conflicts(ch.id).unwrap();
    assert_eq!(conflicts.len(), 1);
    assert_eq!((conflicts[0].a.id, conflicts[0].b.id), (c1.id, c2.id));

    let rel = f.store.release_claim(c1.id).unwrap();
    assert!(rel.released_at.is_some());
    assert!(f.store.find_claim_conflicts(ch.id).unwrap().is_empty());
    assert_eq!(f.store.list_active_claims(ch.id).unwrap().len(), 3);
    assert_eq!(f.store.list_task_claims(t1.id).unwrap().len(), 2);

    assert!(f.store.claim_path(&agent("a"), t1.id, "../etc").is_err());
    assert!(f.store.claim_path(&agent("a"), t1.id, "/").is_err());
    f.store.delete_task(t1.id).unwrap();
    assert!(f.store.claim(c1.id).is_err());
}

// ---- plugins and settings ----

#[test]
fn plugins_install_update_toggle_remove() {
    let f = fixture();
    let p = f
        .store
        .upsert_plugin(
            &me(),
            &NewPlugin {
                name: "theme-x".into(),
                version: "1.0.0".into(),
                manifest: "{}".into(),
            },
        )
        .unwrap();
    assert!(p.enabled);
    let off = f.store.set_plugin_enabled("theme-x", false).unwrap();
    assert!(!off.enabled);
    let up = f
        .store
        .upsert_plugin(
            &me(),
            &NewPlugin {
                name: "theme-x".into(),
                version: "1.1.0".into(),
                manifest: r#"{"a":1}"#.into(),
            },
        )
        .unwrap();
    assert_eq!(
        (up.id, up.created_at, up.enabled),
        (p.id, p.created_at, false)
    );
    assert_eq!(up.version, "1.1.0");
    assert_eq!(f.store.list_plugins().unwrap().len(), 1);
    f.store.remove_plugin("theme-x").unwrap();
    assert!(f.store.plugin_by_name("theme-x").unwrap().is_none());
    assert!(f.store.remove_plugin("theme-x").is_err());
}

#[test]
fn settings_round_trip_and_refuse_secrets() {
    let f = fixture();
    let s = f
        .store
        .set_setting(&me(), "theme.base", "homeroom")
        .unwrap();
    assert_eq!(s.value, "homeroom");
    let s2 = f
        .store
        .set_setting(&me(), "theme.base", "patchbay")
        .unwrap();
    assert_eq!(s2.id, s.id);
    assert_eq!(
        f.store.setting_value("theme.base").unwrap().as_deref(),
        Some("patchbay")
    );
    assert_eq!(f.store.list_settings().unwrap().len(), 1);
    assert!(f.store.setting_value("nope").unwrap().is_none());
    for bad in [
        "api_key",
        "GitHub-Token",
        "db.password",
        "client_secret",
        "aws.credentials",
    ] {
        assert!(f.store.set_setting(&me(), bad, "x").is_err(), "{bad}");
    }
    assert!(f.store.delete_setting("theme.base").unwrap());
    assert!(!f.store.delete_setting("theme.base").unwrap());
}

#[test]
fn in_memory_store_works() {
    let s = Store::open_in_memory().unwrap();
    assert!(s.path().is_none());
    s.create_workspace(&me(), "m").unwrap();
    assert_eq!(s.schema_version().unwrap(), migrate::LATEST_VERSION);
}

#[test]
fn rows_are_serde_ready_for_sync() {
    fn check<T: serde::Serialize + serde::de::DeserializeOwned>() {}
    check::<Workspace>();
    check::<Section>();
    check::<Conversation>();
    check::<Membership>();
    check::<Message>();
    check::<Comment>();
    check::<Attachment>();
    check::<Task>();
    check::<Claim>();
    check::<Reaction>();
    check::<Pin>();
    check::<Draft>();
    check::<Plugin>();
    check::<Setting>();
    check::<Author>();
}

// ---- properties ----

proptest! {
    #[test]
    fn author_text_round_trips(r in "[a-zA-Z0-9_./-]{1,24}", human in any::<bool>()) {
        let a = if human { Author::Human(r) } else { Author::Agent(r) };
        let parsed: Author = a.to_string().parse().unwrap();
        prop_assert_eq!(parsed, a);
    }

    #[test]
    fn comment_quote_matches_any_valid_range(body in "\\PC{1,40}", a in 0usize..60, b in 0usize..60) {
        let f = fixture();
        let c = dm(&f, "d");
        let m = say(&f, &c, &body);
        let (s, e) = (a.min(b), a.max(b));
        let res = f.store.create_comment(&me(), m.id, s, e, "c");
        match body.get(s..e).filter(|q| !q.is_empty()) {
            Some(q) => {
                let cm = res.unwrap();
                prop_assert_eq!(cm.quote, q);
                prop_assert_eq!(f.store.comment(cm.id).unwrap().range_start, s);
            }
            None => prop_assert!(res.is_err()),
        }
    }

    #[test]
    fn overlap_is_symmetric_and_reflexive(a in "[a-c]{1,2}(/[a-c]{1,2}){0,3}", b in "[a-c]{1,2}(/[a-c]{1,2}){0,3}") {
        prop_assert!(paths_overlap(&a, &a));
        prop_assert_eq!(paths_overlap(&a, &b), paths_overlap(&b, &a));
    }

    #[test]
    fn normalize_is_idempotent(p in "[a-c./]{1,12}") {
        if let Ok(n) = normalize_claim_path(&p) {
            prop_assert_eq!(normalize_claim_path(&n).unwrap(), n);
        }
    }

    #[test]
    fn settings_round_trip(key in "[a-z]{1,6}(\\.[a-z]{1,6}){0,2}", value in "\\PC{0,40}") {
        prop_assume!(!is_secret_like_key(&key));
        let s = Store::open_in_memory().unwrap();
        s.set_setting(&me(), &key, &value).unwrap();
        prop_assert_eq!(s.setting_value(&key).unwrap(), Some(value));
    }

    #[test]
    fn message_body_round_trips(body in "\\PC{0,200}") {
        let f = fixture();
        let c = dm(&f, "d");
        let m = say(&f, &c, &body);
        prop_assert_eq!(f.store.message(m.id).unwrap().body, body);
    }
}

// ---- badges ----

#[test]
fn badges_default_to_none_and_track_unread_and_needs_you_independently() {
    let f = fixture();
    let a = dm(&f, "a");
    let b = badges_of(&f, &a);
    assert_eq!((b.unread, b.needs_you), (0, false));
    assert_eq!(f.store.add_unread(&me(), a.id, 2).unwrap().unread, 2);
    assert_eq!(f.store.add_unread(&me(), a.id, 1).unwrap().unread, 3);
    let b = f.store.set_needs_you(&me(), a.id, true).unwrap();
    assert_eq!((b.unread, b.needs_you), (3, true));
    // Viewing clears unread only: needs-you stays until the prompt is resolved.
    let b = f.store.clear_unread(&me(), a.id).unwrap();
    assert_eq!((b.unread, b.needs_you), (0, true));
    let b = f.store.set_needs_you(&me(), a.id, false).unwrap();
    assert_eq!((b.unread, b.needs_you), (0, false));
}

fn badges_of(f: &Fixture, c: &Conversation) -> Badges {
    f.store.badges(c.id).unwrap()
}

#[test]
fn badges_first_write_can_be_any_kind() {
    let f = fixture();
    let (a, b, c) = (dm(&f, "a"), dm(&f, "b"), dm(&f, "c"));
    f.store.set_needs_you(&me(), a.id, true).unwrap();
    f.store.add_unread(&me(), b.id, 4).unwrap();
    f.store.clear_unread(&me(), c.id).unwrap();
    assert_eq!(
        (badges_of(&f, &a).needs_you, badges_of(&f, &a).unread),
        (true, 0)
    );
    assert_eq!(
        (badges_of(&f, &b).needs_you, badges_of(&f, &b).unread),
        (false, 4)
    );
    assert_eq!(f.store.list_badges().unwrap().len(), 3);
}

#[test]
fn badges_survive_reopen_and_die_with_the_conversation() {
    let dir = tempfile::tempdir().unwrap();
    let (conv, ws) = {
        let s = Store::open(dir.path()).unwrap();
        let ws = s.create_workspace(&me(), "W").unwrap();
        let conv = s
            .create_conversation(&me(), &new_conv(&ws, ConversationKind::Dm, "x"))
            .unwrap();
        s.add_unread(&me(), conv.id, 5).unwrap();
        s.set_needs_you(&me(), conv.id, true).unwrap();
        (conv, ws)
    };
    let s = Store::open(dir.path()).unwrap();
    let b = s.badges(conv.id).unwrap();
    assert_eq!((b.unread, b.needs_you), (5, true));
    s.delete_conversation(conv.id).unwrap();
    assert!(s.list_badges().unwrap().is_empty());
    let _ = ws;
}

#[test]
fn badges_for_an_unknown_conversation_are_refused() {
    let f = fixture();
    let ghost = ulid::Ulid::generate();
    assert!(f.store.add_unread(&me(), ghost, 1).is_err());
}
