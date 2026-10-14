//! A read-only look at the machine's real Claude sessions: `cargo test -p patchroom-folders
//! --test real -- --ignored --nocapture`. Lists a folder section for `PATCHROOM_REAL_FOLDER`
//! (default `$HOME/temp/gamerNetworking`) from `$HOME/.claude/projects` and prints one summary
//! line. It opens nothing and writes nothing; the live e2e checks the config files' checksums
//! around it.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::Instant;

use patchroom_folders::{Discovery, Query};

#[test]
#[ignore = "reads the real ~/.claude/projects"]
fn real_folder_lists_read_only() {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return;
    };
    let folder = std::env::var("PATCHROOM_REAL_FOLDER").unwrap_or_else(|_| {
        home.join("temp/gamerNetworking")
            .to_string_lossy()
            .into_owned()
    });
    if !std::path::Path::new(&folder).is_dir() {
        println!("REAL skipped: {folder} is not a folder");
        return;
    }
    let projects = [home.join(".claude").join("projects")];
    let registry = home.join(".claude/.state/session-names.jsonl");
    let (dms, hidden, live) = (HashMap::new(), HashSet::new(), HashSet::new());
    let d = Discovery::new();
    let q = Query {
        home: &folder,
        projects_dirs: &projects,
        registry_path: Some(&registry),
        dms: &dms,
        hidden: &hidden,
        live: &live,
    };
    let t0 = Instant::now();
    let l = d.list(&q);
    let cold = t0.elapsed();
    let t1 = Instant::now();
    let again = d.list(&q);
    let warm = t1.elapsed();
    assert_eq!(l, again);
    let worktree = l.sessions.iter().filter(|s| !s.rel_path.is_empty()).count();
    let by_source = |n: &str| {
        l.sessions
            .iter()
            .filter(|s| serde_json::to_value(s.name_source).unwrap() == n)
            .count()
    };
    println!(
        "REAL folder={folder} sessions={} hidden={} nested_or_worktree={worktree} roots={} \
         names(user={},registry={},custom-title={},ai-title={},prompt={}) cold_ms={} warm_ms={}",
        l.sessions.len(),
        l.hidden_count,
        d.roots(&folder).len(),
        by_source("user"),
        by_source("registry"),
        by_source("custom-title"),
        by_source("ai-title"),
        by_source("prompt"),
        cold.as_millis(),
        warm.as_millis(),
    );
    assert!(l
        .sessions
        .windows(2)
        .all(|w| w[0].last_activity >= w[1].last_activity));
}
