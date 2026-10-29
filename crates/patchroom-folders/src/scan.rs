//! Cheap, cached reading of one session transcript (`<session id>.jsonl`).
//!
//! Most transcript lines are huge tool results nobody needs here. A line is parsed as JSON only
//! when a substring check says it is a `user`, `custom-title`, `ai-title` or `last-prompt`
//! record. A file up to [`FULL_SCAN_MAX`] bytes is read once, in full, and later growth is read
//! from where the last pass stopped. A bigger file is read as a head plus a tail, so a 200 MB
//! transcript costs two 256 KB reads. The newest timestamp always comes from a 64 KB tail read.
//! Results are cached by size and mtime.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::SystemTime;

use serde_json::Value;

/// Files up to this size are read in full (and extended incrementally when they grow).
pub const FULL_SCAN_MAX: u64 = 8 * 1024 * 1024;
/// Head and tail window of a larger file.
const WINDOW: u64 = 256 * 1024;
/// Window read for the newest timestamp.
const TS_WINDOW: u64 = 64 * 1024;
/// Light mode (the History panel, thousands of files): files up to this size are read in full.
const LIGHT_FULL_MAX: u64 = 256 * 1024;
/// Light mode head window: the launch folder and the first prompt live near the top.
const LIGHT_HEAD: u64 = 128 * 1024;
/// Light mode tail window: titles, the newest branch and model live near the end.
const LIGHT_TAIL: u64 = 64 * 1024;
/// Longest model id kept.
const MODEL_CHARS: usize = 80;
/// Longest stored prompt, in characters.
const PROMPT_CHARS: usize = 200;

/// Text starts that mark a user line as machine-made, not typed by the user.
const NOT_A_PROMPT: [&str; 11] = [
    "<task-notification",
    "<local-command",
    "<command-name>",
    "<command-message>",
    "<command-args>",
    "<bash-input>",
    "<bash-stdout",
    "<system-reminder>",
    "<user-prompt-submit-hook>",
    "Caveat:",
    "[Request interrupted",
];

/// What one transcript says about its session.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FileScan {
    /// The folder the session was launched from (`cwd` of its first user line).
    pub launch_cwd: Option<String>,
    /// Newest git branch seen.
    pub branch: Option<String>,
    /// First real user prompt, one line, cut to 200 characters.
    pub first_prompt: String,
    /// Newest `last-prompt` record, else the newest real prompt seen.
    pub last_prompt: String,
    /// Real user prompts (exact for files up to [`FULL_SCAN_MAX`], head plus tail above).
    pub user_turns: u32,
    /// Newest `custom-title` (from `/rename`).
    pub custom_title: Option<String>,
    /// Newest `ai-title`.
    pub ai_title: Option<String>,
    /// Newest record timestamp, epoch milliseconds.
    pub last_ts_ms: Option<i64>,
    /// Newest model id an assistant line reports (`message.model`).
    pub model: Option<String>,
    /// A subagent transcript (`isSidechain`).
    pub sidechain: bool,
    /// Started by `-p` or as a background run: not a session someone sat in.
    pub non_interactive: bool,
    /// File modification time, epoch milliseconds (fallback activity time).
    pub mtime_ms: i64,
}

#[derive(Debug, Clone, Default)]
struct Acc {
    scan: FileScan,
    last_prompt_record: Option<String>,
    last_real_prompt: String,
}

impl Acc {
    fn feed(&mut self, line: &str) {
        let line = line.trim();
        if line.is_empty() {
            return;
        }
        if line.contains("\"type\":\"user\"") {
            if let Ok(v) = serde_json::from_str::<Value>(line) {
                self.user(&v);
            }
        } else if line.contains("\"type\":\"custom-title\"") {
            if let Some(t) = field(line, "customTitle").or_else(|| field(line, "title")) {
                self.scan.custom_title = Some(t);
            }
        } else if line.contains("\"type\":\"ai-title\"") {
            if let Some(t) = field(line, "aiTitle") {
                self.scan.ai_title = Some(t);
            }
        } else if line.contains("\"type\":\"assistant\"") {
            if let Some(m) = quick_model(line) {
                self.scan.model = Some(m);
            }
        } else if line.contains("\"type\":\"last-prompt\"") {
            if let Some(t) = field(line, "lastPrompt") {
                self.last_prompt_record = Some(one_line(&t, PROMPT_CHARS));
            }
        }
    }

    fn user(&mut self, v: &Value) {
        if v.get("type").and_then(Value::as_str) != Some("user") {
            return;
        }
        if v.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            self.scan.sidechain = true;
        }
        if self.scan.launch_cwd.is_none() {
            self.scan.launch_cwd = v.get("cwd").and_then(Value::as_str).map(str::to_owned);
        }
        if let Some(b) = v.get("gitBranch").and_then(Value::as_str) {
            if !b.is_empty() && b != "HEAD" {
                self.scan.branch = Some(b.to_owned());
            }
        }
        if v.get("entrypoint").and_then(Value::as_str) == Some("sdk-cli")
            || v.get("sessionKind").and_then(Value::as_str) == Some("bg")
        {
            self.scan.non_interactive = true;
        }
        if let Some(text) = real_prompt(v) {
            self.scan.user_turns += 1;
            let text = one_line(&text, PROMPT_CHARS);
            if self.scan.first_prompt.is_empty() {
                self.scan.first_prompt.clone_from(&text);
            }
            self.last_real_prompt = text;
        }
    }

    fn finish(&self) -> FileScan {
        let mut s = self.scan.clone();
        s.last_prompt = self
            .last_prompt_record
            .clone()
            .filter(|p| !p.is_empty())
            .unwrap_or_else(|| self.last_real_prompt.clone());
        s
    }
}

/// A string field of a small JSON record line.
fn field(line: &str, key: &str) -> Option<String> {
    let v: Value = serde_json::from_str(line).ok()?;
    let s = v.get(key)?.as_str()?.trim();
    (!s.is_empty()).then(|| s.to_owned())
}

/// Collapse whitespace and cut to `n` characters.
fn one_line(s: &str, n: usize) -> String {
    let joined = s.split_whitespace().collect::<Vec<_>>().join(" ");
    joined.chars().take(n).collect()
}

/// The text of a real user prompt, or `None` for tool results, hook feedback, task
/// notifications, slash-command echoes, compaction summaries and the like.
fn real_prompt(v: &Value) -> Option<String> {
    let flag = |k: &str| v.get(k).and_then(Value::as_bool) == Some(true);
    if flag("isSidechain") || flag("isMeta") || flag("isCompactSummary") {
        return None;
    }
    if v.get("toolUseResult").is_some() {
        return None;
    }
    if let Some(kind) = v.pointer("/origin/kind").and_then(Value::as_str) {
        if kind != "human" {
            return None;
        }
    }
    if let Some(src) = v.get("promptSource").and_then(Value::as_str) {
        if !matches!(src, "typed" | "queued") {
            return None;
        }
    }
    let content = v.pointer("/message/content")?;
    let text = match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => {
            if blocks
                .iter()
                .any(|b| b.get("type").and_then(Value::as_str) == Some("tool_result"))
            {
                return None;
            }
            blocks
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join(" ")
        }
        _ => return None,
    };
    let t = text.trim();
    if t.is_empty() || NOT_A_PROMPT.iter().any(|p| t.starts_with(p)) {
        return None;
    }
    Some(t.to_owned())
}

/// The first `"model":"..."` value of an assistant line, without parsing the line. The message
/// object names its model before its content, so the first hit is `message.model`. Claude's
/// placeholder `<synthetic>` is not a model.
fn quick_model(line: &str) -> Option<String> {
    let key = "\"model\":\"";
    let i = line.find(key)? + key.len();
    let rest = &line[i..];
    let m = &rest[..rest.find('"')?];
    let ok = !m.is_empty()
        && m.len() <= MODEL_CHARS
        && m.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | '[' | ']' | ':' | '/')
        });
    ok.then(|| m.to_owned())
}

/// RFC 3339 timestamp to epoch milliseconds.
fn parse_ts(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|d| d.timestamp_millis())
}

/// The `"timestamp":"..."` value of a line, without parsing the line.
fn quick_ts(line: &str) -> Option<i64> {
    let i = line.find("\"timestamp\":\"")? + "\"timestamp\":\"".len();
    let rest = &line[i..];
    parse_ts(&rest[..rest.find('"')?])
}

/// Newest timestamp in the last [`TS_WINDOW`] bytes of the file.
fn tail_ts(f: &mut File, size: u64) -> Option<i64> {
    let start = size.saturating_sub(TS_WINDOW);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::new();
    f.take(TS_WINDOW).read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    text.lines().rev().find_map(quick_ts)
}

fn mtime_ms(t: SystemTime) -> i64 {
    t.duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

#[derive(Debug, Clone)]
struct Entry {
    size: u64,
    mtime: SystemTime,
    /// Bytes consumed so far (full mode); everything before this offset is in `acc`.
    offset: u64,
    full: bool,
    acc: Acc,
    scan: Arc<FileScan>,
}

/// Cache of transcript scans, keyed by path. Cheap to call again: an unchanged file costs one
/// `stat`.
pub struct Scanner {
    cache: Mutex<HashMap<PathBuf, Entry>>,
    /// Files up to this size are read in full.
    full_max: u64,
    /// Head window of a larger file.
    head: u64,
    /// Tail window of a larger file.
    tail: u64,
}

impl Default for Scanner {
    fn default() -> Self {
        Self {
            cache: Mutex::default(),
            full_max: FULL_SCAN_MAX,
            head: WINDOW,
            tail: WINDOW,
        }
    }
}

impl Scanner {
    /// A new, empty cache.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// A cache that reads every file above 256 KB as a 128 KB head plus a 64 KB tail. For
    /// listings of thousands of sessions, where the prompt count may be approximate.
    #[must_use]
    pub fn light() -> Self {
        Self {
            full_max: LIGHT_FULL_MAX,
            head: LIGHT_HEAD,
            tail: LIGHT_TAIL,
            ..Self::default()
        }
    }

    /// Scan `path`, reusing and extending the cached result when the file is unchanged or only
    /// grew.
    ///
    /// # Errors
    /// The file cannot be opened or read.
    pub fn scan(&self, path: &Path) -> std::io::Result<Arc<FileScan>> {
        let meta = std::fs::metadata(path)?;
        let (size, mtime) = (meta.len(), meta.modified()?);
        let prev = self
            .cache
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(path)
            .cloned();
        if let Some(p) = &prev {
            if p.size == size && p.mtime == mtime {
                return Ok(Arc::clone(&p.scan));
            }
        }
        let mut f = File::open(path)?;
        let entry = if size <= self.full_max {
            let (mut acc, mut offset) = match prev {
                Some(p) if p.full && size >= p.offset => (p.acc, p.offset),
                _ => (Acc::default(), 0),
            };
            f.seek(SeekFrom::Start(offset))?;
            let mut reader = BufReader::with_capacity(256 * 1024, f.try_clone()?);
            let mut line = Vec::new();
            loop {
                line.clear();
                let n = reader.read_until(b'\n', &mut line)?;
                if n == 0 {
                    break;
                }
                let complete = line.ends_with(b"\n");
                let text = String::from_utf8_lossy(&line);
                // A half-written last line waits for the next pass, unless it already parses.
                if !complete && serde_json::from_str::<Value>(text.trim()).is_err() {
                    break;
                }
                acc.feed(&text);
                offset += n as u64;
            }
            Entry {
                size,
                mtime,
                offset,
                full: true,
                acc,
                scan: Arc::default(),
            }
        } else {
            let mut acc = Acc::default();
            feed_window(&mut f, 0, self.head.min(size), true, &mut acc)?;
            let tail = self.tail.min(size);
            feed_window(&mut f, size - tail, tail, false, &mut acc)?;
            Entry {
                size,
                mtime,
                offset: size,
                full: false,
                acc,
                scan: Arc::default(),
            }
        };
        let mut scan = entry.acc.finish();
        scan.last_ts_ms = tail_ts(&mut f, size);
        scan.mtime_ms = mtime_ms(mtime);
        let scan = Arc::new(scan);
        let entry = Entry {
            scan: Arc::clone(&scan),
            ..entry
        };
        self.cache
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(path.to_owned(), entry);
        Ok(scan)
    }

    /// Forget cached files that are no longer listed.
    pub fn retain(&self, keep: impl Fn(&Path) -> bool) {
        self.cache
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .retain(|p, _| keep(p));
    }
}

/// Feed the complete lines of `[start, start + len)` into `acc`. A window that does not begin
/// at byte 0 drops its first (partial) line; a window that does not end the file drops its last.
fn feed_window(
    f: &mut File,
    start: u64,
    len: u64,
    head: bool,
    acc: &mut Acc,
) -> std::io::Result<()> {
    f.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::new();
    f.take(len).read_to_end(&mut buf)?;
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<&str> = text.split('\n').collect();
    if start > 0 && !lines.is_empty() {
        lines.remove(0);
    }
    // The tail window ends at the end of the file; a head window ends mid-file.
    if head && !lines.is_empty() {
        lines.pop();
    }
    for l in lines {
        acc.feed(l);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    fn user(text: &str, cwd: &str, ts: &str) -> String {
        format!(
            "{{\"parentUuid\":null,\"isSidechain\":false,\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":{}}},\"timestamp\":\"{ts}\",\"cwd\":\"{cwd}\",\"gitBranch\":\"main\",\"entrypoint\":\"cli\",\"origin\":{{\"kind\":\"human\"}}}}\n",
            serde_json::to_string(text).unwrap()
        )
    }

    fn write(dir: &Path, name: &str, body: &str) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, body).unwrap();
        p
    }

    #[test]
    fn reads_prompts_titles_cwd_and_the_newest_timestamp() {
        let d = tempfile::tempdir().unwrap();
        let body =
            format!(
            "{}{}{}{}{}{}",
            user("  first   prompt\nacross lines ", "/w/p", "2026-01-01T00:00:00.000Z"),
            "{\"type\":\"assistant\",\"timestamp\":\"2026-01-01T00:00:05.000Z\",\"message\":{}}\n",
            "{\"type\":\"ai-title\",\"aiTitle\":\"Old AI\",\"sessionId\":\"s\"}\n",
            "{\"type\":\"custom-title\",\"customTitle\":\"Renamed\",\"sessionId\":\"s\"}\n",
            user("second", "/w/p/sub", "2026-01-02T03:04:05.250Z"),
            "{\"type\":\"ai-title\",\"aiTitle\":\"New AI\",\"sessionId\":\"s\"}\n",
        );
        let p = write(d.path(), "s.jsonl", &body);
        let s = Scanner::new().scan(&p).unwrap();
        assert_eq!(s.launch_cwd.as_deref(), Some("/w/p"));
        assert_eq!(s.first_prompt, "first prompt across lines");
        assert_eq!(s.last_prompt, "second");
        assert_eq!(s.user_turns, 2);
        assert_eq!(s.custom_title.as_deref(), Some("Renamed"));
        assert_eq!(s.ai_title.as_deref(), Some("New AI"));
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!(s.last_ts_ms, parse_ts("2026-01-02T03:04:05.250Z"));
        assert!(!s.sidechain && !s.non_interactive);
    }

    #[test]
    fn machine_made_user_lines_are_not_prompts() {
        let d = tempfile::tempdir().unwrap();
        let mut body = String::new();
        for t in [
            "<task-notification>done</task-notification>",
            "<command-name>/rename</command-name>",
            "Caveat: The messages below were generated by the user while running local commands",
            "[Request interrupted by user]",
        ] {
            body += &user(t, "/w", "2026-01-01T00:00:00Z");
        }
        body += "{\"type\":\"user\",\"isMeta\":true,\"message\":{\"content\":\"meta\"},\"cwd\":\"/w\"}\n";
        body += "{\"type\":\"user\",\"toolUseResult\":{},\"message\":{\"content\":[{\"type\":\"tool_result\",\"content\":\"x\"}]},\"cwd\":\"/w\"}\n";
        body += "{\"type\":\"user\",\"origin\":{\"kind\":\"peer\"},\"message\":{\"content\":\"hi from a peer\"},\"cwd\":\"/w\"}\n";
        body += "{\"type\":\"user\",\"promptSource\":\"system\",\"message\":{\"content\":\"Stop hook feedback: x\"},\"cwd\":\"/w\"}\n";
        let p = write(d.path(), "n.jsonl", &body);
        let s = Scanner::new().scan(&p).unwrap();
        assert_eq!(s.user_turns, 0);
        assert!(s.first_prompt.is_empty());
        assert_eq!(s.launch_cwd.as_deref(), Some("/w"));
    }

    #[test]
    fn flags_sidechains_and_non_interactive_runs() {
        let d = tempfile::tempdir().unwrap();
        let side = "{\"type\":\"user\",\"isSidechain\":true,\"message\":{\"content\":\"do the thing\"},\"cwd\":\"/w\"}\n";
        let p = write(d.path(), "a.jsonl", side);
        assert!(Scanner::new().scan(&p).unwrap().sidechain);
        let sdk = "{\"type\":\"user\",\"entrypoint\":\"sdk-cli\",\"message\":{\"content\":\"-p run\"},\"cwd\":\"/w\"}\n";
        let p = write(d.path(), "b.jsonl", sdk);
        assert!(Scanner::new().scan(&p).unwrap().non_interactive);
    }

    #[test]
    fn an_unchanged_file_is_cached_and_a_grown_file_is_read_incrementally() {
        let d = tempfile::tempdir().unwrap();
        let p = write(
            d.path(),
            "g.jsonl",
            &user("one", "/w", "2026-01-01T00:00:00Z"),
        );
        let sc = Scanner::new();
        let a = sc.scan(&p).unwrap();
        let b = sc.scan(&p).unwrap();
        assert!(Arc::ptr_eq(&a, &b), "unchanged file: same cached result");
        let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        f.write_all(user("two", "/w", "2026-01-03T00:00:00Z").as_bytes())
            .unwrap();
        // A half-written line is not counted yet.
        f.write_all(b"{\"type\":\"user\",\"message\":{\"content\":\"thr")
            .unwrap();
        drop(f);
        // Force a different mtime on coarse filesystems.
        let later = SystemTime::now() + std::time::Duration::from_secs(5);
        std::fs::File::open(&p)
            .unwrap()
            .set_modified(later)
            .unwrap();
        let c = sc.scan(&p).unwrap();
        assert_eq!(c.user_turns, 2);
        assert_eq!(c.first_prompt, "one");
        assert_eq!(c.last_prompt, "two");
        assert_eq!(c.last_ts_ms, parse_ts("2026-01-03T00:00:00Z"));
    }

    #[test]
    fn a_huge_file_is_read_as_head_plus_tail() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("big.jsonl");
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(user("the first prompt", "/w/p", "2026-02-01T00:00:00Z").as_bytes())
            .unwrap();
        let filler = format!(
            "{{\"type\":\"assistant\",\"timestamp\":\"2026-02-01T00:00:01Z\",\"x\":\"{}\"}}\n",
            "z".repeat(60_000)
        );
        for _ in 0..(FULL_SCAN_MAX / 60_000 + 10) {
            f.write_all(filler.as_bytes()).unwrap();
        }
        f.write_all(b"{\"type\":\"custom-title\",\"customTitle\":\"Late name\"}\n")
            .unwrap();
        f.write_all(user("the last prompt", "/w/p", "2026-02-09T00:00:00Z").as_bytes())
            .unwrap();
        drop(f);
        assert!(std::fs::metadata(&p).unwrap().len() > FULL_SCAN_MAX);
        let s = Scanner::new().scan(&p).unwrap();
        assert_eq!(s.first_prompt, "the first prompt");
        assert_eq!(s.last_prompt, "the last prompt");
        assert_eq!(s.custom_title.as_deref(), Some("Late name"));
        assert_eq!(s.user_turns, 2);
        assert_eq!(s.last_ts_ms, parse_ts("2026-02-09T00:00:00Z"));
    }

    #[test]
    fn the_newest_assistant_model_is_kept_and_placeholders_are_not() {
        let d = tempfile::tempdir().unwrap();
        let body = format!(
            "{}{}{}{}",
            user("hi", "/w", "2026-01-01T00:00:00Z"),
            "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-sonnet-4-6\",\"content\":[]}}\n",
            "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-opus-5-5\",\"content\":[{\"type\":\"tool_use\",\"input\":{\"model\":\"x\"}}]}}\n",
            "{\"type\":\"assistant\",\"message\":{\"model\":\"<synthetic>\",\"content\":[]}}\n",
        );
        let p = write(d.path(), "m.jsonl", &body);
        assert_eq!(
            Scanner::new().scan(&p).unwrap().model.as_deref(),
            Some("claude-opus-5-5")
        );
    }

    #[test]
    fn light_mode_reads_a_big_file_as_a_small_head_and_tail() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("big.jsonl");
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(user("first", "/w/p", "2026-02-01T00:00:00Z").as_bytes())
            .unwrap();
        let filler = format!(
            "{{\"type\":\"assistant\",\"timestamp\":\"2026-02-01T00:00:01Z\",\"x\":\"{}\"}}\n",
            "z".repeat(10_000)
        );
        for _ in 0..80 {
            f.write_all(filler.as_bytes()).unwrap();
        }
        f.write_all(b"{\"type\":\"ai-title\",\"aiTitle\":\"Late title\"}\n")
            .unwrap();
        f.write_all(b"{\"type\":\"assistant\",\"message\":{\"model\":\"claude-haiku-5-5\"}}\n")
            .unwrap();
        drop(f);
        assert!(std::fs::metadata(&p).unwrap().len() > LIGHT_FULL_MAX);
        let s = Scanner::light().scan(&p).unwrap();
        assert_eq!(s.first_prompt, "first");
        assert_eq!(s.launch_cwd.as_deref(), Some("/w/p"));
        assert_eq!(s.ai_title.as_deref(), Some("Late title"));
        assert_eq!(s.model.as_deref(), Some("claude-haiku-5-5"));
    }

    #[test]
    fn last_prompt_record_wins_over_the_last_typed_prompt() {
        let d = tempfile::tempdir().unwrap();
        let body = format!(
            "{}{}",
            user("typed", "/w", "2026-01-01T00:00:00Z"),
            "{\"type\":\"last-prompt\",\"lastPrompt\":\"recorded last\",\"sessionId\":\"s\"}\n"
        );
        let p = write(d.path(), "l.jsonl", &body);
        assert_eq!(
            Scanner::new().scan(&p).unwrap().last_prompt,
            "recorded last"
        );
    }
}
