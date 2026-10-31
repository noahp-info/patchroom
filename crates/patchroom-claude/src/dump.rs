//! The corpus tool behind `patchroom-claude dump <transcript.jsonl>`.
//!
//! Prints one JSON object to stdout: `{"items": [...], "accounting": {...}}` and the
//! accounting as one line on stderr:
//!
//! ```text
//! lines=N items=I hidden=H fallback=F errors=E
//! ```
//!
//! `N = mapped + hidden + fallback`. `errors` counts lines that were not valid JSON
//! objects or hit an internal failure; each of those also counts as a fallback.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Serialize;

use crate::adapter::Adapter;
use crate::item::ChatItem;
use crate::map::Accounting;

/// Everything `dump` knows about one transcript.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dump {
    /// All items in order.
    pub items: Vec<ChatItem>,
    /// Line accounting.
    pub accounting: Accounting,
    /// Hidden line counts by reason (stderr detail only, not part of the contract).
    #[serde(skip)]
    pub hidden_reasons: BTreeMap<String, u64>,
    /// Fallback line counts by line type (stderr detail only).
    #[serde(skip)]
    pub fallback_types: BTreeMap<String, u64>,
}

impl Dump {
    /// The one-line accounting form.
    #[must_use]
    pub fn accounting_line(&self) -> String {
        let a = &self.accounting;
        format!(
            "lines={} items={} hidden={} fallback={} errors={}",
            a.lines, a.items, a.hidden, a.fallback, a.errors
        )
    }
}

/// Run a whole transcript through the mapper.
///
/// # Errors
/// The file cannot be read.
pub fn dump_file(path: &Path) -> std::io::Result<Dump> {
    std::fs::metadata(path)?;
    let mut adapter = Adapter::for_file(path);
    adapter.poll();
    adapter.finish();
    let m = adapter.mapper();
    Ok(Dump {
        items: m.items().to_vec(),
        accounting: m.accounting(),
        hidden_reasons: m.hidden_reasons().clone(),
        fallback_types: m.fallback_types().clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn dump_counts_every_line_once() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("t.jsonl");
        let mut f = std::fs::File::create(&p).unwrap();
        writeln!(
            f,
            r#"{{"type":"user","uuid":"u","message":{{"content":"hi"}}}}"#
        )
        .unwrap();
        writeln!(f, r#"{{"type":"last-prompt"}}"#).unwrap();
        writeln!(f, r#"{{"type":"mystery"}}"#).unwrap();
        write!(f, r#"{{"type":"assistant","uuid":"a","message":{{"content":[{{"type":"text","text":"x"}}]}}}}"#).unwrap();
        drop(f);
        let d = dump_file(&p).unwrap();
        assert_eq!(
            d.accounting_line(),
            "lines=4 items=3 hidden=1 fallback=1 errors=0"
        );
        let v = serde_json::to_value(&d).unwrap();
        assert!(v["items"].is_array());
        assert_eq!(v["accounting"]["lines"], 4);
    }

    #[test]
    fn missing_file_is_an_error() {
        assert!(dump_file(Path::new("/nonexistent/x.jsonl")).is_err());
    }
}
