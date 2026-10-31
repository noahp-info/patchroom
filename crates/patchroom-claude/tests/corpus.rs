//! Corpus check over real local transcripts. Nothing from the corpus is copied anywhere:
//! the test only reads the files and asserts accounting numbers.
//!
//! ```text
//! PATCHROOM_CORPUS=$HOME/.claude/projects \
//!   cargo test -p patchroom-claude --test corpus -- --ignored --nocapture
//! ```
//!
//! It takes the 40 most recently modified transcripts over 2 KB and checks that every line
//! is accounted for, `errors` is 0 and fallbacks stay under 1% of the non-hidden lines.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use patchroom_claude::dump::dump_file;
use patchroom_claude::{Adapter, ItemBody};

fn corpus_files(root: &Path, n: usize) -> Vec<PathBuf> {
    let mut all: Vec<(SystemTime, PathBuf)> = Vec::new();
    for proj in std::fs::read_dir(root).unwrap().flatten() {
        let Ok(rd) = std::fs::read_dir(proj.path()) else {
            continue;
        };
        for f in rd.flatten() {
            let p = f.path();
            if p.extension().is_some_and(|e| e == "jsonl") {
                if let Ok(m) = f.metadata() {
                    if m.len() > 2048 {
                        all.push((m.modified().unwrap_or(SystemTime::UNIX_EPOCH), p));
                    }
                }
            }
        }
    }
    all.sort_by_key(|a| std::cmp::Reverse(a.0));
    all.into_iter().take(n).map(|(_, p)| p).collect()
}

fn root() -> PathBuf {
    PathBuf::from(
        std::env::var("PATCHROOM_CORPUS")
            .expect("set PATCHROOM_CORPUS to a Claude projects dir, e.g. ~/.claude/projects"),
    )
}

#[test]
#[ignore = "reads the local Claude transcript corpus; set PATCHROOM_CORPUS"]
fn forty_recent_transcripts_have_no_errors_and_under_one_percent_fallback() {
    let files = corpus_files(&root(), 40);
    assert!(files.len() >= 10, "corpus too small: {} files", files.len());
    let (mut lines, mut hidden, mut fallback, mut errors) = (0u64, 0u64, 0u64, 0u64);
    let mut fallback_types: std::collections::BTreeMap<String, u64> = Default::default();
    for f in &files {
        let d = dump_file(f).unwrap();
        let a = &d.accounting;
        // Every line is a mapped line, a hidden line or a fallback line.
        let mapped = a.lines - a.hidden - a.fallback;
        assert_eq!(mapped + a.hidden + a.fallback, a.lines);
        lines += a.lines;
        hidden += a.hidden;
        fallback += a.fallback;
        errors += a.errors;
        for (k, v) in d.fallback_types {
            *fallback_types.entry(k).or_insert(0) += v;
        }
    }
    println!(
        "files={} lines={lines} hidden={hidden} fallback={fallback} errors={errors}",
        files.len()
    );
    for (k, v) in &fallback_types {
        println!("fallback {v:>5}  {k}");
    }
    assert_eq!(errors, 0);
    let non_hidden = lines - hidden;
    assert!(
        fallback * 100 < non_hidden,
        "fallback {fallback} is not under 1% of {non_hidden} non-hidden lines"
    );
}

#[test]
#[ignore = "reads the local Claude transcript corpus; set PATCHROOM_CORPUS"]
fn every_assistant_text_block_becomes_an_item() {
    // Skip a transcript that is still being written (a session may be running right now).
    let files: Vec<PathBuf> = corpus_files(&root(), 41)
        .into_iter()
        .filter(|f| {
            f.metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age.as_secs() > 120)
        })
        .collect();
    for f in files.iter().take(8) {
        let mut want = 0usize;
        for line in std::fs::read_to_string(f).unwrap().lines() {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
                continue;
            };
            // Synthetic assistant lines (API errors, notices) map to system items instead.
            if v["type"] != "assistant" || v["message"]["model"] == "<synthetic>" {
                continue;
            }
            if let Some(blocks) = v["message"]["content"].as_array() {
                want += blocks
                    .iter()
                    .filter(|b| {
                        b["type"] == "text"
                            && b["text"].as_str().is_some_and(|t| !t.trim().is_empty())
                    })
                    .count();
            }
        }
        let d = dump_file(f).unwrap();
        let got = d
            .items
            .iter()
            .filter(|i| matches!(i.body, ItemBody::Assistant { .. }))
            .count();
        assert_eq!(got, want, "{}", f.display());
    }
}

#[test]
#[ignore = "reads the local Claude transcript corpus; set PATCHROOM_CORPUS"]
fn subagent_threads_open_for_real_transcripts() {
    let mut checked = 0;
    for f in corpus_files(&root(), 80) {
        let sub = f.with_extension("").join("subagents");
        if !sub.is_dir() {
            continue;
        }
        let mut a = Adapter::for_file(&f);
        a.poll();
        let agents: Vec<_> = a
            .items()
            .iter()
            .filter_map(|i| match &i.body {
                ItemBody::Subagent {
                    tool_use_id,
                    item_count,
                    ..
                } if *item_count > 0 => Some((tool_use_id.clone(), *item_count)),
                _ => None,
            })
            .collect();
        for (tool_use_id, count) in agents.into_iter().take(3) {
            let items = a.thread(&tool_use_id);
            assert_eq!(items.len() as u64, count, "{tool_use_id}");
            assert!(items
                .iter()
                .all(|i| i.parent_tool_use_id.as_deref() == Some(tool_use_id.as_str())));
            checked += 1;
        }
    }
    println!("subagent threads checked: {checked}");
    assert!(checked > 0, "no subagent threads in the corpus");
}
