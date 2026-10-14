//! Full-text search over chat item text, on SQLite FTS5.
//!
//! The index is its own database file (`search.db` in the app data dir, see [`INDEX_FILE`]),
//! separate from the main store, so it can be deleted and rebuilt at any time. A document is
//! one chat item, keyed by `(conversation key, item key)`. A conversation key is a DM id, or
//! `claude:<session id>` for another Claude Code session ([`EXTERNAL_PREFIX`]).
//!
//! Feed it with [`SearchIndex::upsert_items`] as the transcript tail yields items, or rebuild
//! one conversation from a transcript file with [`index_file`]. Query with
//! [`SearchIndex::search`]: every word must match, the last word matches as a prefix, and
//! each hit carries a snippet with the matched ranges.

use std::path::Path;
use std::time::Instant;

use patchroom_claude::{Adapter, ChatItem};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

/// File name of the index inside the data directory.
pub const INDEX_FILE: &str = "search.db";
/// Conversation keys of other Claude Code sessions start with this.
pub const EXTERNAL_PREFIX: &str = "claude:";
/// Default number of hits.
pub const DEFAULT_LIMIT: usize = 50;
/// Most hits one query returns.
pub const MAX_LIMIT: usize = 200;

/// Search failures.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// SQLite failed.
    #[error("search index: {0}")]
    Sqlite(#[from] rusqlite::Error),
    /// Filesystem failure.
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

/// Result alias.
pub type Result<T> = std::result::Result<T, Error>;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS doc (
    rowid    INTEGER PRIMARY KEY,
    conv     TEXT NOT NULL,
    item_key TEXT NOT NULL,
    ts       INTEGER NOT NULL,
    kind     TEXT NOT NULL,
    text     TEXT NOT NULL,
    UNIQUE (conv, item_key)
);
CREATE VIRTUAL TABLE IF NOT EXISTS doc_fts USING fts5(
    text, content='doc', content_rowid='rowid',
    tokenize='unicode61 remove_diacritics 2', prefix='2 3'
);
CREATE TRIGGER IF NOT EXISTS doc_ai AFTER INSERT ON doc BEGIN
    INSERT INTO doc_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS doc_ad AFTER DELETE ON doc BEGIN
    INSERT INTO doc_fts(doc_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS doc_au AFTER UPDATE ON doc BEGIN
    INSERT INTO doc_fts(doc_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
    INSERT INTO doc_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE INDEX IF NOT EXISTS doc_conv ON doc(conv);
CREATE TABLE IF NOT EXISTS source (
    conv  TEXT PRIMARY KEY,
    path  TEXT NOT NULL,
    size  INTEGER NOT NULL,
    mtime INTEGER NOT NULL
);
";

/// Marks around matched words in a raw FTS5 snippet (control characters never occur in text).
const OPEN: char = '\u{1}';
const CLOSE: char = '\u{2}';

/// One search hit.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    /// Conversation key: the DM id, or `claude:<session id>` for another session.
    pub id: String,
    /// Key of the chat item. Open it with `chat_locate`.
    pub item_key: String,
    /// Item time in epoch milliseconds.
    pub ts: i64,
    /// Item kind (`user`, `assistant`, `tool`, ...).
    pub kind: String,
    /// A short excerpt of the item's text, on one line.
    pub snippet: String,
    /// Matched ranges in `snippet` as `[start, end)` offsets in UTF-16 code units, which is
    /// what a JavaScript string indexes by.
    pub ranges: Vec<[usize; 2]>,
}

/// The answer to a query.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    /// Hits, best first.
    pub hits: Vec<Hit>,
    /// Time the query took, in milliseconds.
    pub took_ms: f64,
}

/// What a query is limited to.
#[derive(Debug, Clone, Default)]
pub struct Scope<'a> {
    /// Only this conversation.
    pub conv: Option<&'a str>,
    /// Also search other Claude Code sessions (`claude:` keys).
    pub include_external: bool,
}

/// The index. One handle owns one connection; guard it with a mutex to share it.
pub struct SearchIndex {
    conn: Connection,
}

impl SearchIndex {
    /// Open (creating if needed) `<dir>/search.db`.
    ///
    /// # Errors
    /// Filesystem or SQLite failures.
    pub fn open(dir: impl AsRef<Path>) -> Result<Self> {
        std::fs::create_dir_all(dir.as_ref())?;
        let conn = Connection::open(dir.as_ref().join(INDEX_FILE))?;
        Self::init(conn, true)
    }

    /// A private in-memory index (tests).
    ///
    /// # Errors
    /// SQLite failures.
    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?, false)
    }

    fn init(conn: Connection, file: bool) -> Result<Self> {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        if file {
            // The index can be rebuilt from the transcripts, so trade durability for speed.
            conn.query_row("PRAGMA journal_mode = WAL", [], |_| Ok(()))?;
            conn.pragma_update(None, "synchronous", "OFF")?;
        }
        conn.execute_batch(SCHEMA)?;
        Ok(Self { conn })
    }

    /// Add or refresh items of `conv`. An item with no searchable text is removed.
    ///
    /// # Errors
    /// SQLite failures.
    pub fn upsert_items(&mut self, conv: &str, items: &[ChatItem]) -> Result<usize> {
        let tx = self.conn.transaction()?;
        let n = upsert_in(&tx, conv, items)?;
        tx.commit()?;
        Ok(n)
    }

    /// Make the index of `conv` hold exactly `items`, in one transaction, so a concurrent
    /// reader never sees the conversation half-empty.
    ///
    /// # Errors
    /// SQLite failures.
    pub fn replace_conversation(&mut self, conv: &str, items: &[ChatItem]) -> Result<usize> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM doc WHERE conv = ?1", [conv])?;
        let n = upsert_in(&tx, conv, items)?;
        tx.commit()?;
        Ok(n)
    }

    /// Drop everything indexed for `conv`, including its source state.
    ///
    /// # Errors
    /// SQLite failures.
    pub fn delete_conversation(&mut self, conv: &str) -> Result<()> {
        self.conn
            .execute("DELETE FROM doc WHERE conv = ?1", [conv])?;
        self.conn
            .execute("DELETE FROM source WHERE conv = ?1", [conv])?;
        Ok(())
    }

    /// Drop every other-session document (the `searchAllSessions` setting went off).
    ///
    /// # Errors
    /// SQLite failures.
    pub fn delete_external(&mut self) -> Result<()> {
        let like = format!("{EXTERNAL_PREFIX}%");
        self.conn
            .execute("DELETE FROM doc WHERE conv LIKE ?1", [&like])?;
        self.conn
            .execute("DELETE FROM source WHERE conv LIKE ?1", [&like])?;
        Ok(())
    }

    /// Number of documents, of one conversation or in total.
    ///
    /// # Errors
    /// SQLite failures.
    pub fn doc_count(&self, conv: Option<&str>) -> Result<u64> {
        Ok(self.conn.query_row(
            "SELECT COUNT(*) FROM doc WHERE (?1 IS NULL OR conv = ?1)",
            [conv],
            |r| r.get::<_, i64>(0).map(|n| n as u64),
        )?)
    }

    /// Conversation keys that have documents or a recorded source.
    ///
    /// # Errors
    /// SQLite failures.
    pub fn conversations(&self) -> Result<Vec<String>> {
        let mut st = self
            .conn
            .prepare("SELECT conv FROM doc UNION SELECT conv FROM source")?;
        let rows = st.query_map([], |r| r.get(0))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// The transcript file state recorded when `conv` was last indexed from a file.
    ///
    /// # Errors
    /// SQLite failures.
    pub fn source_state(&self, conv: &str) -> Result<Option<(String, u64, i64)>> {
        Ok(self
            .conn
            .query_row(
                "SELECT path, size, mtime FROM source WHERE conv = ?1",
                [conv],
                |r| Ok((r.get(0)?, r.get::<_, i64>(1)? as u64, r.get(2)?)),
            )
            .optional()?)
    }

    /// Record the transcript file state of `conv`.
    ///
    /// # Errors
    /// SQLite failures.
    pub fn set_source_state(
        &mut self,
        conv: &str,
        path: &str,
        size: u64,
        mtime: i64,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT INTO source (conv, path, size, mtime) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(conv) DO UPDATE SET path = ?2, size = ?3, mtime = ?4",
            params![conv, path, size as i64, mtime],
        )?;
        Ok(())
    }

    /// Run a query. Every word must match; the last word matches as a prefix. An empty or
    /// punctuation-only query returns no hits.
    ///
    /// # Errors
    /// SQLite failures.
    pub fn search(&self, query: &str, scope: &Scope<'_>, limit: usize) -> Result<SearchResult> {
        let started = Instant::now();
        let Some(expr) = match_expression(query) else {
            return Ok(SearchResult {
                hits: Vec::new(),
                took_ms: 0.0,
            });
        };
        let limit = limit.clamp(1, MAX_LIMIT);
        let ext_like = format!("{EXTERNAL_PREFIX}%");
        let mut st = self.conn.prepare_cached(
            "SELECT d.conv, d.item_key, d.ts, d.kind,
                    snippet(doc_fts, 0, char(1), char(2), '...', 24)
             FROM doc_fts JOIN doc d ON d.rowid = doc_fts.rowid
             WHERE doc_fts MATCH ?1
               AND (?2 IS NULL OR d.conv = ?2)
               AND (?3 = 1 OR d.conv NOT LIKE ?4)
             ORDER BY bm25(doc_fts), d.ts DESC
             LIMIT ?5",
        )?;
        let rows = st.query_map(
            params![
                expr,
                scope.conv,
                scope.include_external
                    || scope.conv.is_some_and(|c| c.starts_with(EXTERNAL_PREFIX)),
                ext_like,
                limit as i64
            ],
            |r| {
                let raw: String = r.get(4)?;
                let (snippet, ranges) = marked_ranges(&raw);
                Ok(Hit {
                    id: r.get(0)?,
                    item_key: r.get(1)?,
                    ts: r.get(2)?,
                    kind: r.get(3)?,
                    snippet,
                    ranges,
                })
            },
        )?;
        let hits = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(SearchResult {
            hits,
            took_ms: (started.elapsed().as_secs_f64() * 1000.0 * 100.0).round() / 100.0,
        })
    }
}

fn upsert_in(tx: &rusqlite::Transaction<'_>, conv: &str, items: &[ChatItem]) -> Result<usize> {
    let mut n = 0;
    let mut up = tx.prepare_cached(
        "INSERT INTO doc (conv, item_key, ts, kind, text) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(conv, item_key) DO UPDATE SET
             ts = excluded.ts, kind = excluded.kind, text = excluded.text
         WHERE doc.text IS NOT excluded.text OR doc.ts IS NOT excluded.ts",
    )?;
    let mut del = tx.prepare_cached("DELETE FROM doc WHERE conv = ?1 AND item_key = ?2")?;
    for item in items {
        match item.search_text() {
            Some(text) => {
                up.execute(params![conv, item.key, item.ts, item.kind_name(), text])?;
                n += 1;
            }
            None => {
                del.execute(params![conv, item.key])?;
            }
        }
    }
    Ok(n)
}

/// Build an FTS5 expression: every word quoted and ANDed, the last one a prefix.
/// `None` when the query has no word.
#[must_use]
pub fn match_expression(query: &str) -> Option<String> {
    let words: Vec<&str> = query
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect();
    let last = words.len().checked_sub(1)?;
    Some(
        words
            .iter()
            .enumerate()
            .map(|(i, w)| {
                if i == last {
                    format!("\"{w}\"*")
                } else {
                    format!("\"{w}\"")
                }
            })
            .collect::<Vec<_>>()
            .join(" "),
    )
}

/// Turn a raw snippet (matches wrapped in control characters) into a one-line string and the
/// UTF-16 `[start, end)` ranges of the matches.
fn marked_ranges(raw: &str) -> (String, Vec<[usize; 2]>) {
    let mut out = String::with_capacity(raw.len());
    let mut ranges = Vec::new();
    let mut units = 0usize;
    let mut open_at: Option<usize> = None;
    for c in raw.chars() {
        match c {
            OPEN => open_at = Some(units),
            CLOSE => {
                if let Some(s) = open_at.take() {
                    if units > s {
                        ranges.push([s, units]);
                    }
                }
            }
            _ => {
                let c = if c == '\n' || c == '\r' || c == '\t' {
                    ' '
                } else {
                    c
                };
                out.push(c);
                units += c.len_utf16();
            }
        }
    }
    (out, ranges)
}

/// Read every searchable item of a transcript file. Parsing is the slow part, so callers do
/// it before taking any lock on the index. An unreadable file gives no items.
#[must_use]
pub fn read_transcript(path: &Path) -> Vec<ChatItem> {
    let mut adapter = Adapter::for_file(path);
    // `poll` reads the file in chunks and loops while more is waiting; a second call finds
    // nothing new, which ends this loop.
    loop {
        let before = adapter.items().len();
        let update = adapter.poll();
        if update.items.is_empty() && adapter.items().len() == before {
            break;
        }
    }
    let _ = adapter.finish();
    adapter
        .items()
        .iter()
        .filter(|i| i.parent_tool_use_id.is_none())
        .cloned()
        .collect()
}

/// A file's size and modification time in milliseconds, the stamp [`needs_reindex`] compares.
#[must_use]
pub fn file_stamp(path: &Path) -> Option<(u64, i64)> {
    let m = std::fs::metadata(path).ok()?;
    let mtime = m
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as i64);
    Some((m.len(), mtime))
}

/// Index one transcript file as conversation `conv`, replacing what was there, and record the
/// file's stamp. Returns the number of searchable items.
///
/// # Errors
/// SQLite failures. An unreadable file indexes as empty.
pub fn index_file(index: &mut SearchIndex, conv: &str, path: &Path) -> Result<usize> {
    let stamp = file_stamp(path);
    let items = read_transcript(path);
    let n = index.replace_conversation(conv, &items)?;
    if let Some((size, mtime)) = stamp {
        index.set_source_state(conv, &path.to_string_lossy(), size, mtime)?;
    }
    Ok(n)
}

/// True when `path` differs from what was recorded for `conv` (or was never indexed).
///
/// # Errors
/// SQLite failures.
pub fn needs_reindex(index: &SearchIndex, conv: &str, path: &Path) -> Result<bool> {
    let Some((size, mtime)) = file_stamp(path) else {
        return Ok(false);
    };
    Ok(index.source_state(conv)? != Some((path.to_string_lossy().into_owned(), size, mtime)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use patchroom_claude::ItemBody;

    fn assistant(key: &str, ts: i64, text: &str) -> ChatItem {
        ChatItem::new(key, ts, ItemBody::Assistant { text: text.into() })
    }

    #[test]
    fn expression_quotes_words_and_prefixes_the_last() {
        assert_eq!(match_expression("  "), None);
        assert_eq!(match_expression("--"), None);
        assert_eq!(match_expression("login").as_deref(), Some("\"login\"*"));
        assert_eq!(
            match_expression("fix \"login\" bug-fo").as_deref(),
            Some("\"fix\" \"login\" \"bug\" \"fo\"*")
        );
        // FTS5 operators are plain words once quoted.
        assert_eq!(
            match_expression("a OR b NEAR(").as_deref(),
            Some("\"a\" \"OR\" \"b\" \"NEAR\"*")
        );
    }

    #[test]
    fn ranges_are_utf16_offsets_into_a_one_line_snippet() {
        let (s, r) = marked_ranges("a\u{1F600}\n\u{1}bc\u{2} d\u{1}e\u{2}");
        assert_eq!(s, "a\u{1F600} bc de");
        // The emoji is two UTF-16 units.
        assert_eq!(r, vec![[4, 6], [8, 9]]);
    }

    #[test]
    fn finds_prefix_diacritics_and_scopes() {
        let mut ix = SearchIndex::open_in_memory().unwrap();
        ix.upsert_items(
            "dm1",
            &[
                assistant("a", 10, "The caf\u{e9} login flow needs a retry"),
                assistant("b", 20, "unrelated words"),
            ],
        )
        .unwrap();
        ix.upsert_items("dm2", &[assistant("c", 30, "login again in dm2")])
            .unwrap();
        ix.upsert_items("claude:abc", &[assistant("d", 40, "login elsewhere")])
            .unwrap();
        let all = ix.search("logi", &Scope::default(), 10).unwrap();
        let ids: Vec<&str> = all.hits.iter().map(|h| h.id.as_str()).collect();
        assert_eq!(all.hits.len(), 2, "{ids:?}");
        assert!(
            !ids.contains(&"claude:abc"),
            "external sessions are off by default"
        );
        let ext = Scope {
            include_external: true,
            ..Scope::default()
        };
        assert_eq!(ix.search("login", &ext, 10).unwrap().hits.len(), 3);
        let one = Scope {
            conv: Some("dm1"),
            ..Scope::default()
        };
        let r = ix.search("cafe login", &one, 10).unwrap();
        assert_eq!(r.hits.len(), 1);
        assert_eq!(r.hits[0].item_key, "a");
        let h = &r.hits[0];
        let units: Vec<u16> = h.snippet.encode_utf16().collect();
        let marked: Vec<String> = h
            .ranges
            .iter()
            .map(|[s, e]| String::from_utf16_lossy(&units[*s..*e]))
            .collect();
        assert_eq!(marked, ["caf\u{e9}", "login"]);
    }

    #[test]
    fn upsert_replaces_and_empty_text_removes() {
        let mut ix = SearchIndex::open_in_memory().unwrap();
        ix.upsert_items("d", &[assistant("a", 1, "alpha beta")])
            .unwrap();
        ix.upsert_items("d", &[assistant("a", 1, "gamma delta")])
            .unwrap();
        assert!(ix
            .search("alpha", &Scope::default(), 5)
            .unwrap()
            .hits
            .is_empty());
        assert_eq!(
            ix.search("gamma", &Scope::default(), 5).unwrap().hits.len(),
            1
        );
        assert_eq!(ix.doc_count(Some("d")).unwrap(), 1);
        ix.upsert_items("d", &[assistant("a", 1, "  ")]).unwrap();
        assert_eq!(ix.doc_count(None).unwrap(), 0);
        assert!(ix
            .search("gamma", &Scope::default(), 5)
            .unwrap()
            .hits
            .is_empty());
    }

    #[test]
    fn deleting_a_conversation_removes_its_hits_and_source() {
        let mut ix = SearchIndex::open_in_memory().unwrap();
        ix.upsert_items("d1", &[assistant("a", 1, "needle one")])
            .unwrap();
        ix.upsert_items("d2", &[assistant("a", 1, "needle two")])
            .unwrap();
        ix.set_source_state("d1", "/x", 1, 2).unwrap();
        ix.delete_conversation("d1").unwrap();
        let r = ix.search("needle", &Scope::default(), 10).unwrap();
        assert_eq!(r.hits.len(), 1);
        assert_eq!(r.hits[0].id, "d2");
        assert_eq!(ix.source_state("d1").unwrap(), None);
        ix.upsert_items("claude:z", &[assistant("a", 1, "needle three")])
            .unwrap();
        ix.delete_external().unwrap();
        assert_eq!(ix.doc_count(None).unwrap(), 1);
    }

    #[test]
    fn limit_is_clamped() {
        let mut ix = SearchIndex::open_in_memory().unwrap();
        let items: Vec<ChatItem> = (0..30)
            .map(|i| assistant(&format!("k{i}"), i, "common word"))
            .collect();
        ix.upsert_items("d", &items).unwrap();
        assert_eq!(
            ix.search("common", &Scope::default(), 5)
                .unwrap()
                .hits
                .len(),
            5
        );
        assert_eq!(
            ix.search("common", &Scope::default(), 0)
                .unwrap()
                .hits
                .len(),
            1
        );
        assert_eq!(
            ix.search("common", &Scope::default(), 9999)
                .unwrap()
                .hits
                .len(),
            30
        );
    }
}
