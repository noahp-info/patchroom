//! P3 store tests: migration 0003, default sections, placement, flags, item marks, activity.

use patchroom_store::*;
use rusqlite::Connection;

fn me() -> Author {
    Author::me()
}

struct Fx {
    dir: tempfile::TempDir,
    store: Store,
    ws: Workspace,
}

fn fx() -> Fx {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let ws = store.create_workspace(&me(), "Home").unwrap();
    Fx { dir, store, ws }
}

fn dm_in(f: &Fx, name: &str, section: Option<Id>) -> Conversation {
    f.store
        .create_conversation(
            &me(),
            &NewConversation {
                workspace_id: f.ws.id,
                section_id: section,
                kind: ConversationKind::Dm,
                name: name.into(),
                provider: None,
                cwd: None,
                worktree: None,
                session_id: None,
                assign_mode: None,
            },
        )
        .unwrap()
}

fn names(f: &Fx) -> Vec<String> {
    f.store
        .list_sections(f.ws.id)
        .unwrap()
        .into_iter()
        .map(|s| s.name)
        .collect()
}

fn in_section(f: &Fx, s: Id) -> Vec<String> {
    f.store
        .list_section_conversations(s)
        .unwrap()
        .into_iter()
        .map(|c| c.name)
        .collect()
}

#[test]
fn migration_3_applies_to_a_v2_database_and_keeps_rows() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(DB_FILE);
    {
        // Build a v2 file by hand: run only 0001 and 0002.
        let conn = Connection::open(&path).unwrap();
        for (v, sql) in migrate::all_sql().take(2).enumerate() {
            conn.execute_batch(sql).unwrap();
            conn.pragma_update(None, "user_version", v as u32 + 1)
                .unwrap();
        }
        conn.execute_batch(
            "INSERT INTO workspace VALUES ('01J00000000000000000000001','human:me',1,1,'W');
             INSERT INTO conversation (id, author, created_at, updated_at, workspace_id, position,
                 kind, name) VALUES ('01J00000000000000000000002','human:me',1,1,
                 '01J00000000000000000000001',0,'dm','old');",
        )
        .unwrap();
    }
    let store = Store::open(dir.path()).unwrap();
    assert_eq!(store.schema_version().unwrap(), migrate::LATEST_VERSION);
    let ws = store.list_workspaces().unwrap().remove(0);
    let c = store.list_conversations(ws.id).unwrap().remove(0);
    assert_eq!(c.name, "old");
    assert!(!c.starred && !c.archived);
}

#[test]
fn fresh_workspace_gets_starred_dm_archived_in_order() {
    let f = fx();
    let d = f.store.ensure_default_sections(&me(), f.ws.id).unwrap();
    assert_eq!(names(&f), ["Starred", "Sessions", "Archived"]);
    let secs = f.store.list_sections(f.ws.id).unwrap();
    assert_eq!(Some(secs[0].id), d.starred);
    assert_eq!(secs[1].id, d.dm);
    assert_eq!(Some(secs[2].id), d.archived);
    // Idempotent, and stable across a reopen.
    let again = f.store.ensure_default_sections(&me(), f.ws.id).unwrap();
    assert_eq!(again, d);
    drop(f.store);
    let store = Store::open(f.dir.path()).unwrap();
    assert_eq!(store.ensure_default_sections(&me(), f.ws.id).unwrap(), d);
    assert_eq!(store.list_sections(f.ws.id).unwrap().len(), 3);
}

#[test]
fn old_workspace_keeps_its_section_and_renames_direct_messages() {
    let f = fx();
    let old = f
        .store
        .create_section(&me(), f.ws.id, "Direct messages")
        .unwrap();
    let custom = f.store.create_section(&me(), f.ws.id, "Work").unwrap();
    let d = f.store.ensure_default_sections(&me(), f.ws.id).unwrap();
    assert_eq!(d.dm, old.id);
    assert_eq!(names(&f), ["Starred", "Sessions", "Work", "Archived"]);
    let _ = custom;
}

#[test]
fn a_deleted_default_stays_deleted_but_sessions_returns() {
    let f = fx();
    let d = f.store.ensure_default_sections(&me(), f.ws.id).unwrap();
    f.store
        .delete_section_into(d.starred.unwrap(), d.dm)
        .unwrap();
    f.store.delete_section(d.dm).unwrap();
    let d2 = f.store.ensure_default_sections(&me(), f.ws.id).unwrap();
    assert_eq!(d2.starred, None);
    assert_ne!(d2.dm, d.dm);
    assert!(names(&f).contains(&"Sessions".to_string()));
    assert!(!names(&f).contains(&"Starred".to_string()));
}

#[test]
fn a_sessions_section_the_user_renamed_keeps_its_name() {
    let f = fx();
    let d = f.store.ensure_default_sections(&me(), f.ws.id).unwrap();
    f.store.rename_section(d.dm, "Agents").unwrap();
    let d2 = f.store.ensure_default_sections(&me(), f.ws.id).unwrap();
    assert_eq!(d2.dm, d.dm);
    assert!(names(&f).contains(&"Agents".to_string()));
}

#[test]
fn an_upgraded_direct_messages_section_is_renamed_sessions() {
    let f = fx();
    let d = f.store.ensure_default_sections(&me(), f.ws.id).unwrap();
    f.store.rename_section(d.dm, "Direct messages").unwrap();
    let d2 = f.store.ensure_default_sections(&me(), f.ws.id).unwrap();
    assert_eq!(d2.dm, d.dm);
    assert_eq!(names(&f), ["Starred", "Sessions", "Archived"]);
}

#[test]
fn delete_section_moves_its_dms_to_the_fallback_in_order() {
    let f = fx();
    let d = f.store.ensure_default_sections(&me(), f.ws.id).unwrap();
    let work = f.store.create_section(&me(), f.ws.id, "Work").unwrap();
    dm_in(&f, "x", Some(d.dm));
    dm_in(&f, "w1", Some(work.id));
    dm_in(&f, "w2", Some(work.id));
    f.store.delete_section_into(work.id, d.dm).unwrap();
    assert_eq!(in_section(&f, d.dm), ["x", "w1", "w2"]);
    assert!(f.store.section(work.id).is_err());
    assert!(f.store.delete_section_into(d.dm, d.dm).is_err());
}

#[test]
fn place_conversations_moves_and_orders_in_one_call() {
    let f = fx();
    let d = f.store.ensure_default_sections(&me(), f.ws.id).unwrap();
    let work = f.store.create_section(&me(), f.ws.id, "Work").unwrap();
    let a = dm_in(&f, "a", Some(d.dm));
    let b = dm_in(&f, "b", Some(d.dm));
    let c = dm_in(&f, "c", Some(work.id));
    f.store
        .place_conversations(Some(work.id), &[b.id, a.id])
        .unwrap();
    // Listed first in the given order, the one already there after.
    assert_eq!(in_section(&f, work.id), ["b", "a", "c"]);
    assert!(in_section(&f, d.dm).is_empty());
    f.store
        .place_conversations(Some(d.dm), &[c.id, b.id])
        .unwrap();
    assert_eq!(in_section(&f, d.dm), ["c", "b"]);
    assert_eq!(in_section(&f, work.id), ["a"]);
    // Unplace.
    f.store.place_conversations(None, &[a.id]).unwrap();
    assert_eq!(f.store.conversation(a.id).unwrap().section_id, None);
    // Duplicates and unknown ids are refused and change nothing.
    assert!(f
        .store
        .place_conversations(Some(d.dm), &[c.id, c.id])
        .is_err());
    let ghost = ulid::Ulid::generate();
    assert!(f
        .store
        .place_conversations(Some(d.dm), &[b.id, ghost])
        .is_err());
    assert_eq!(in_section(&f, d.dm), ["c", "b"]);
}

#[test]
fn flags_set_independently() {
    let f = fx();
    let a = dm_in(&f, "a", None);
    f.store
        .set_conversation_flags(a.id, Some(true), None)
        .unwrap();
    let c = f.store.conversation(a.id).unwrap();
    assert!(c.starred && !c.archived);
    f.store
        .set_conversation_flags(a.id, None, Some(true))
        .unwrap();
    let c = f.store.conversation(a.id).unwrap();
    assert!(c.starred && c.archived);
    f.store
        .set_conversation_flags(a.id, Some(false), Some(false))
        .unwrap();
    let c = f.store.conversation(a.id).unwrap();
    assert!(!c.starred && !c.archived);
    assert!(f
        .store
        .set_conversation_flags(ulid::Ulid::generate(), Some(true), None)
        .is_err());
}

#[test]
fn marks_are_unique_per_item_kind_and_emoji() {
    let f = fx();
    let a = dm_in(&f, "a", None);
    let m1 = f
        .store
        .add_mark(&me(), a.id, "k1", MarkKind::Pin, None, "hello")
        .unwrap();
    let m2 = f
        .store
        .add_mark(&me(), a.id, "k1", MarkKind::Pin, None, "hello again")
        .unwrap();
    assert_eq!(m1.id, m2.id, "same mark returns the same row");
    assert_eq!(m2.snapshot, "hello again");
    f.store
        .add_mark(&me(), a.id, "k1", MarkKind::Saved, None, "s")
        .unwrap();
    f.store
        .add_mark(&me(), a.id, "k1", MarkKind::Reaction, Some("\u{2705}"), "s")
        .unwrap();
    f.store
        .add_mark(&me(), a.id, "k1", MarkKind::Reaction, Some(":tada:"), "s")
        .unwrap();
    assert_eq!(f.store.list_marks(Some(a.id), None).unwrap().len(), 4);
    assert_eq!(
        f.store
            .list_marks(None, Some(MarkKind::Reaction))
            .unwrap()
            .len(),
        2
    );
    // A reaction needs an emoji; a pin ignores one.
    assert!(f
        .store
        .add_mark(&me(), a.id, "k1", MarkKind::Reaction, None, "")
        .is_err());
    assert!(f
        .store
        .add_mark(&me(), a.id, "k1", MarkKind::Reaction, Some("  "), "")
        .is_err());
    let p = f
        .store
        .add_mark(&me(), a.id, "k2", MarkKind::Pin, Some("x"), "")
        .unwrap();
    assert_eq!(p.emoji, "");
    assert!(f
        .store
        .remove_mark(a.id, "k1", MarkKind::Reaction, Some(":tada:"))
        .unwrap());
    assert!(!f
        .store
        .remove_mark(a.id, "k1", MarkKind::Reaction, Some(":tada:"))
        .unwrap());
    assert!(f
        .store
        .remove_mark(a.id, "k1", MarkKind::Pin, None)
        .unwrap());
    assert_eq!(f.store.list_marks(Some(a.id), None).unwrap().len(), 3);
}

#[test]
fn snapshots_are_cut_to_280_characters_and_marks_follow_their_dm() {
    let f = fx();
    let a = dm_in(&f, "a", None);
    let long = "\u{e9}".repeat(1000);
    let m = f
        .store
        .add_mark(&me(), a.id, "k", MarkKind::Saved, None, &long)
        .unwrap();
    assert_eq!(m.snapshot.chars().count(), SNAPSHOT_CHARS);
    f.store.delete_conversation(a.id).unwrap();
    assert!(f.store.list_marks(None, None).unwrap().is_empty());
    let ghost = ulid::Ulid::generate();
    assert!(f
        .store
        .add_mark(&me(), ghost, "k", MarkKind::Pin, None, "")
        .is_err());
}

#[test]
fn marks_list_newest_first_and_survive_reopen() {
    let f = fx();
    let a = dm_in(&f, "a", None);
    for k in ["one", "two", "three"] {
        f.store
            .add_mark(&me(), a.id, k, MarkKind::Saved, None, k)
            .unwrap();
    }
    drop(f.store);
    let store = Store::open(f.dir.path()).unwrap();
    let keys: Vec<String> = store
        .list_marks(None, Some(MarkKind::Saved))
        .unwrap()
        .into_iter()
        .map(|m| m.item_key)
        .collect();
    assert_eq!(keys, ["three", "two", "one"]);
}

#[test]
fn draft_ids_list_only_non_empty_drafts() {
    let f = fx();
    let (a, b) = (dm_in(&f, "a", None), dm_in(&f, "b", None));
    f.store.set_draft(&me(), a.id, "wip").unwrap();
    f.store.set_draft(&me(), b.id, "x").unwrap();
    f.store.set_draft(&me(), b.id, "").unwrap();
    assert_eq!(f.store.draft_conversation_ids().unwrap(), vec![a.id]);
}

#[test]
fn activity_marks_track_the_oldest_unread_and_when_needs_you_began() {
    let f = fx();
    let a = dm_in(&f, "a", None);
    f.store.add_unread(&me(), a.id, 2).unwrap();
    f.store.note_first_unread(a.id, 100, "k1", "first").unwrap();
    f.store.add_unread(&me(), a.id, 1).unwrap();
    f.store
        .note_first_unread(a.id, 200, "k2", "second")
        .unwrap();
    f.store.set_needs_you(&me(), a.id, true).unwrap();
    let m = f.store.activity_marks().unwrap().remove(0);
    assert_eq!(
        (m.unread, m.unread_since, m.unread_key.as_deref()),
        (3, Some(100), Some("k1"))
    );
    assert_eq!(m.unread_summary.as_deref(), Some("first"));
    let since = m.needs_since.expect("needs since");
    // A second needs-you write keeps the original time.
    f.store.set_needs_you(&me(), a.id, true).unwrap();
    assert_eq!(
        f.store.activity_marks().unwrap()[0].needs_since,
        Some(since)
    );
    f.store.clear_unread(&me(), a.id).unwrap();
    f.store.set_needs_you(&me(), a.id, false).unwrap();
    assert!(f.store.activity_marks().unwrap().is_empty());
    // note_first_unread is a no-op when nothing is unread.
    f.store.note_first_unread(a.id, 5, "k", "s").unwrap();
    f.store.add_unread(&me(), a.id, 1).unwrap();
    let m = f.store.activity_marks().unwrap().remove(0);
    assert_eq!(m.unread_since, None);
}
