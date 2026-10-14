//! Folder sections: migration 0004, archive days, per-section hidden sessions.

use patchroom_store::{migrate, Author, ConversationKind, NewConversation, Store, DB_FILE};
use rusqlite::Connection;

fn me() -> Author {
    Author::me()
}

#[test]
fn migration_4_applies_to_a_v3_database_and_keeps_sections() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(DB_FILE);
    {
        let conn = Connection::open(&path).unwrap();
        for (v, sql) in migrate::all_sql().take(3).enumerate() {
            conn.execute_batch(sql).unwrap();
            conn.pragma_update(None, "user_version", v as u32 + 1)
                .unwrap();
        }
        conn.execute_batch(
            "INSERT INTO workspace VALUES ('01J00000000000000000000001','human:me',1,1,'W');
             INSERT INTO section (id, author, created_at, updated_at, workspace_id, name, position)
                 VALUES ('01J00000000000000000000003','human:me',1,1,
                         '01J00000000000000000000001','Old',0);",
        )
        .unwrap();
    }
    let store = Store::open(dir.path()).unwrap();
    assert_eq!(store.schema_version().unwrap(), migrate::LATEST_VERSION);
    let ws = store.list_workspaces().unwrap().remove(0);
    let s = store.list_sections(ws.id).unwrap().remove(0);
    assert_eq!(
        (s.name.as_str(), s.folder, s.archive_days),
        ("Old", None, 14)
    );
}

#[test]
fn folder_sections_keep_their_folder_and_archive_days() {
    let store = Store::open_in_memory().unwrap();
    let ws = store.create_workspace(&me(), "W").unwrap();
    let plain = store.create_section(&me(), ws.id, "Plain").unwrap();
    assert_eq!(plain.folder, None);
    let s = store
        .create_folder_section(&me(), ws.id, "proj", "/work/proj")
        .unwrap();
    assert_eq!(s.folder.as_deref(), Some("/work/proj"));
    assert_eq!(s.archive_days, 14);
    assert_eq!(
        store
            .set_section_archive_days(s.id, 30)
            .unwrap()
            .archive_days,
        30
    );
    assert!(store.set_section_archive_days(s.id, 0).is_err());
    assert!(store.set_section_archive_days(s.id, 4000).is_err());
    let listed = store.list_sections(ws.id).unwrap();
    assert_eq!(listed[1].folder.as_deref(), Some("/work/proj"));
    assert!(store.create_folder_section(&me(), ws.id, "x", " ").is_err());
}

#[test]
fn hidden_sessions_are_per_section_idempotent_and_cascade() {
    let store = Store::open_in_memory().unwrap();
    let ws = store.create_workspace(&me(), "W").unwrap();
    let a = store
        .create_folder_section(&me(), ws.id, "a", "/a")
        .unwrap();
    let b = store
        .create_folder_section(&me(), ws.id, "b", "/b")
        .unwrap();
    store.set_folder_hidden(&me(), a.id, "s1", true).unwrap();
    store.set_folder_hidden(&me(), a.id, "s1", true).unwrap();
    store.set_folder_hidden(&me(), a.id, "s2", true).unwrap();
    assert_eq!(store.folder_hidden(a.id).unwrap().len(), 2);
    assert!(store.folder_hidden(b.id).unwrap().is_empty());
    store.set_folder_hidden(&me(), a.id, "s1", false).unwrap();
    assert!(!store.folder_hidden(a.id).unwrap().contains("s1"));
    store.delete_section(a.id).unwrap();
    assert!(store.folder_hidden(a.id).unwrap().is_empty());
}

#[test]
fn a_dm_is_found_by_its_claude_session_id() {
    let store = Store::open_in_memory().unwrap();
    let ws = store.create_workspace(&me(), "W").unwrap();
    let mk = |sid: Option<&str>| NewConversation {
        workspace_id: ws.id,
        section_id: None,
        kind: ConversationKind::Dm,
        name: "dm".into(),
        provider: Some("claude".into()),
        cwd: Some("/x".into()),
        worktree: None,
        session_id: sid.map(str::to_owned),
        assign_mode: None,
    };
    let c = store
        .create_conversation(&me(), &mk(Some("sid-1")))
        .unwrap();
    store.create_conversation(&me(), &mk(None)).unwrap();
    assert_eq!(
        store
            .conversation_by_session(ws.id, "sid-1")
            .unwrap()
            .map(|c| c.id),
        Some(c.id)
    );
    assert!(store
        .conversation_by_session(ws.id, "nope")
        .unwrap()
        .is_none());
}
