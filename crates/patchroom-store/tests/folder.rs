//! Folder sections: migration 0004, archive days, per-section hidden sessions.

use patchroom_store::{
    migrate, Author, ConversationKind, NewConversation, SectionKind, Store, DB_FILE,
};
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

/// Build a database at schema v4, the shape P3 shipped, with stored sections and a DM.
fn v4_database(dir: &std::path::Path) {
    let conn = Connection::open(dir.join(DB_FILE)).unwrap();
    for (v, sql) in migrate::all_sql().take(4).enumerate() {
        conn.execute_batch(sql).unwrap();
        conn.pragma_update(None, "user_version", v as u32 + 1)
            .unwrap();
    }
    conn.execute_batch(
        "INSERT INTO workspace VALUES ('01J00000000000000000000001','human:me',1,1,'W');
         INSERT INTO section (id, author, created_at, updated_at, workspace_id, name, position,
                              collapsed, folder, archive_days)
             VALUES ('01J00000000000000000000003','human:me',1,1,
                     '01J00000000000000000000001','Plain',0,1,NULL,14),
                    ('01J00000000000000000000004','human:me',1,1,
                     '01J00000000000000000000001','proj',1,0,'/work/proj',30);
         INSERT INTO conversation (id, author, created_at, updated_at, workspace_id, section_id,
             position, kind, name) VALUES ('01J00000000000000000000005','human:me',1,1,
             '01J00000000000000000000001','01J00000000000000000000003',0,'dm','old dm');",
    )
    .unwrap();
}

#[test]
fn migrations_5_and_6_apply_to_a_p3_database_and_load_old_sections_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    v4_database(dir.path());
    let store = Store::open(dir.path()).unwrap();
    assert_eq!(migrate::LATEST_VERSION, 6);
    assert_eq!(store.schema_version().unwrap(), 6);
    let ws = store.list_workspaces().unwrap().remove(0);
    let secs = store.list_sections(ws.id).unwrap();
    assert_eq!(secs.len(), 2);
    assert_eq!(
        (
            secs[0].name.as_str(),
            secs[0].collapsed,
            secs[0].kind,
            secs[0].emoji.clone()
        ),
        ("Plain", true, SectionKind::Section, None)
    );
    assert_eq!(
        (
            secs[1].folder.as_deref(),
            secs[1].archive_days,
            secs[1].kind
        ),
        (Some("/work/proj"), 30, SectionKind::Section)
    );
    // The P3-era DM is still placed in its section.
    let convs = store.list_conversations(ws.id).unwrap();
    assert_eq!(convs[0].section_id, Some(secs[0].id));
    // Reopening a migrated database is a no-op.
    drop(store);
    let again = Store::open(dir.path()).unwrap();
    assert_eq!(again.schema_version().unwrap(), 6);
    assert_eq!(convs[0].emoji, None);
    assert_eq!(secs[0].emoji_flavor, None);
    // Emoji with a flavor round-trips; a cleared emoji drops its flavor; odd flavors are refused.
    let s = again
        .set_section_emoji_flavor(secs[0].id, Some("\u{1f680}"), Some("noto"))
        .unwrap();
    assert_eq!(
        (s.emoji.as_deref(), s.emoji_flavor.as_deref()),
        (Some("\u{1f680}"), Some("noto"))
    );
    let c = again
        .set_conversation_emoji(convs[0].id, Some("\u{2728}"), Some("apple"))
        .unwrap();
    assert_eq!(c.emoji_flavor.as_deref(), Some("apple"));
    let c = again
        .set_conversation_emoji(convs[0].id, None, Some("noto"))
        .unwrap();
    assert_eq!((c.emoji, c.emoji_flavor), (None, None));
    assert!(again
        .set_conversation_emoji(convs[0].id, Some("x"), Some("twemoji"))
        .is_err());
}

#[test]
fn dividers_take_a_label_and_emoji_but_never_conversations() {
    let store = Store::open_in_memory().unwrap();
    let ws = store.create_workspace(&me(), "W").unwrap();
    let a = store.create_section(&me(), ws.id, "A").unwrap();
    assert_eq!((a.kind, a.emoji.clone()), (SectionKind::Section, None));
    let d = store
        .create_section_of(&me(), ws.id, "Later", SectionKind::Divider, Some(" 📦 "))
        .unwrap();
    assert_eq!(
        (d.kind, d.emoji.as_deref()),
        (SectionKind::Divider, Some("📦"))
    );
    let bare = store
        .create_section_of(&me(), ws.id, "  ", SectionKind::Divider, None)
        .unwrap();
    assert_eq!(bare.name, "");
    assert!(store
        .create_section_of(&me(), ws.id, "", SectionKind::Section, None)
        .is_err());
    assert!(store
        .create_section_of(
            &me(),
            ws.id,
            "x",
            SectionKind::Section,
            Some(&"e".repeat(40))
        )
        .is_err());
    // Blank emoji means none; set and clear round-trip.
    assert_eq!(
        store
            .set_section_emoji(a.id, Some("🔥"))
            .unwrap()
            .emoji
            .as_deref(),
        Some("🔥")
    );
    assert_eq!(
        store.set_section_emoji(a.id, Some("  ")).unwrap().emoji,
        None
    );
    // A divider may lose its label; a section may not.
    assert_eq!(store.rename_section(d.id, "").unwrap().name, "");
    assert!(store.rename_section(a.id, " ").is_err());
    // Dividers order with sections.
    store
        .reorder_sections(ws.id, &[d.id, a.id, bare.id])
        .unwrap();
    let names: Vec<_> = store
        .list_sections(ws.id)
        .unwrap()
        .into_iter()
        .map(|s| s.id)
        .collect();
    assert_eq!(names, [d.id, a.id, bare.id]);
    // No conversation can be placed in a divider.
    let c = store
        .create_conversation(
            &me(),
            &NewConversation {
                workspace_id: ws.id,
                section_id: Some(a.id),
                kind: ConversationKind::Dm,
                name: "dm".into(),
                provider: None,
                cwd: None,
                worktree: None,
                session_id: None,
                assign_mode: None,
            },
        )
        .unwrap();
    assert!(store.move_conversation(c.id, Some(d.id), 0).is_err());
    assert!(store.place_conversations(Some(d.id), &[c.id]).is_err());
    assert!(store.delete_section_into(a.id, d.id).is_err());
    // Deleting a divider leaves its neighbours alone.
    store.delete_section(d.id).unwrap();
    assert_eq!(store.list_sections(ws.id).unwrap().len(), 2);
}
