//! The session-naming registry (`<config dir>/.state/session-names.jsonl`), read only.
//!
//! One JSON object per line: `{"session_id", "name", "named_at"}`. A session can have several
//! entries; the newest one (by `named_at`, later line on a tie) names it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::SystemTime;

use serde_json::Value;

type Names = Arc<HashMap<String, String>>;

/// Cached reader of the registry file.
#[derive(Default)]
pub struct Registry {
    cache: Mutex<Option<(PathBuf, u64, SystemTime, Names)>>,
}

impl Registry {
    /// A new, empty cache.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Newest registry name per session id. Empty when the file is missing or unreadable.
    #[must_use]
    pub fn names(&self, path: &Path) -> Names {
        let Ok(meta) = std::fs::metadata(path) else {
            return Names::default();
        };
        let (size, mtime) = (
            meta.len(),
            meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
        );
        let mut cache = self.cache.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some((p, s, m, n)) = cache.as_ref() {
            if p == path && *s == size && *m == mtime {
                return Arc::clone(n);
            }
        }
        let names: Names = Arc::new(
            std::fs::read_to_string(path)
                .map(|t| parse(&t))
                .unwrap_or_default(),
        );
        *cache = Some((path.to_owned(), size, mtime, Arc::clone(&names)));
        names
    }
}

/// Parse registry text: the newest entry per session id.
#[must_use]
pub fn parse(text: &str) -> HashMap<String, String> {
    let mut best: HashMap<String, (String, String)> = HashMap::new();
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let (Some(id), Some(name)) = (
            v.get("session_id").and_then(Value::as_str),
            v.get("name").and_then(Value::as_str),
        ) else {
            continue;
        };
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        let at = v
            .get("named_at")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        match best.get(id) {
            Some((prev_at, _)) if at < *prev_at => {}
            _ => {
                best.insert(id.to_owned(), (at, name.to_owned()));
            }
        }
    }
    best.into_iter().map(|(k, (_, n))| (k, n)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_newest_entry_wins_and_junk_is_skipped() {
        let text = "{\"session_id\":\"a\",\"name\":\"Old\",\"named_at\":\"2026-01-01T00:00:00Z\"}\n\
                    not json\n\
                    {\"session_id\":\"a\",\"name\":\"New\",\"named_at\":\"2026-02-01T00:00:00Z\"}\n\
                    {\"session_id\":\"a\",\"name\":\"Stale\",\"named_at\":\"2025-12-01T00:00:00Z\"}\n\
                    {\"session_id\":\"b\",\"name\":\"  \",\"named_at\":\"2026-01-01T00:00:00Z\"}\n\
                    {\"session_id\":\"c\",\"name\":\"Tie1\"}\n\
                    {\"session_id\":\"c\",\"name\":\"Tie2\"}\n";
        let m = parse(text);
        assert_eq!(m.get("a").map(String::as_str), Some("New"));
        assert!(!m.contains_key("b"));
        assert_eq!(m.get("c").map(String::as_str), Some("Tie2"));
    }

    #[test]
    fn a_missing_file_gives_no_names() {
        assert!(Registry::new()
            .names(Path::new("/nonexistent/x.jsonl"))
            .is_empty());
    }
}
