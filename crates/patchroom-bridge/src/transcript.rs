//! Minimal transcript tail reader.
//!
//! Used to notice that the user answered a permission dialog in the TUI: the transcript
//! gains a `tool_result` for the pending `tool_use`. The format is internal to the CLI and
//! unstable, so everything here is lenient and returns `None`/`false` on surprise.

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

use serde_json::Value;

/// How much of the file end to read per poll.
pub const TAIL_BYTES: u64 = 512 * 1024;

/// Read the last [`TAIL_BYTES`] of `path` as complete lines.
pub fn read_tail(path: &Path) -> io::Result<String> {
    let mut f = File::open(path)?;
    let len = f.metadata()?.len();
    let start = len.saturating_sub(TAIL_BYTES);
    f.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::new();
    f.take(TAIL_BYTES).read_to_end(&mut buf)?;
    let text = String::from_utf8_lossy(&buf).into_owned();
    if start > 0 {
        // Drop the partial first line.
        Ok(text.split_once('\n').map(|x| x.1).unwrap_or("").to_owned())
    } else {
        Ok(text)
    }
}

fn content_items(line: &Value) -> impl Iterator<Item = &Value> {
    line.get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

/// Find the id of the latest `tool_use` with this name and input, skipping `exclude`.
pub fn find_tool_use(tail: &str, name: &str, input: &Value, exclude: &[String]) -> Option<String> {
    let mut found = None;
    for line in tail.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        for item in content_items(&v) {
            if item.get("type").and_then(Value::as_str) == Some("tool_use")
                && item.get("name").and_then(Value::as_str) == Some(name)
                && item.get("input") == Some(input)
            {
                if let Some(id) = item.get("id").and_then(Value::as_str) {
                    if !exclude.iter().any(|e| e == id) {
                        found = Some(id.to_owned());
                    }
                }
            }
        }
    }
    found
}

/// True when the tail holds a `tool_result` for `tool_use_id`.
pub fn has_tool_result(tail: &str, tool_use_id: &str) -> bool {
    tail.lines().any(|line| {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            return false;
        };
        let found = content_items(&v).any(|item| {
            item.get("type").and_then(Value::as_str) == Some("tool_result")
                && item.get("tool_use_id").and_then(Value::as_str) == Some(tool_use_id)
        });
        found
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn line(v: Value) -> String {
        format!("{v}\n")
    }

    #[test]
    fn finds_tool_use_and_result() {
        let input = json!({"command": "echo hi"});
        let mut t = String::new();
        t.push_str(&line(json!({"type":"user","message":{"content":"hello"}})));
        t.push_str(&line(json!({"type":"assistant","message":{"content":[
            {"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"echo hi"}}]}})));
        assert_eq!(
            find_tool_use(&t, "Bash", &input, &[]).as_deref(),
            Some("toolu_1")
        );
        assert!(find_tool_use(&t, "Bash", &input, &["toolu_1".into()]).is_none());
        assert!(find_tool_use(&t, "Read", &input, &[]).is_none());
        assert!(!has_tool_result(&t, "toolu_1"));
        t.push_str(&line(json!({"type":"user","message":{"content":[
            {"type":"tool_result","tool_use_id":"toolu_1","content":"hi"}]}})));
        assert!(has_tool_result(&t, "toolu_1"));
        assert!(!has_tool_result(&t, "toolu_2"));
    }

    #[test]
    fn tolerates_garbage_lines() {
        assert!(find_tool_use("not json\n{}\n", "Bash", &json!({}), &[]).is_none());
        assert!(!has_tool_result("###\n", "x"));
    }

    #[test]
    fn tail_drops_partial_first_line() {
        let dir = std::env::temp_dir().join(format!("pr-tail-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("t.jsonl");
        let big = "x".repeat(TAIL_BYTES as usize + 10);
        std::fs::write(&p, format!("{big}\n{{\"a\":1}}\n")).unwrap();
        assert_eq!(read_tail(&p).unwrap(), "{\"a\":1}\n");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
