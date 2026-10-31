//! Search latency over a synthetic corpus: 40 transcripts of realistic size must index in
//! under 10 s, and a query must answer in under 200 ms. The transcripts are generated here
//! from a fixed word list; no real transcript content is used.

use std::fmt::Write as _;
use std::time::Instant;

use patchroom_search::{index_file, needs_reindex, Scope, SearchIndex};

const WORDS: &[&str] = &[
    "build",
    "deploy",
    "refactor",
    "module",
    "parser",
    "session",
    "socket",
    "bridge",
    "render",
    "prompt",
    "schema",
    "migration",
    "cursor",
    "buffer",
    "thread",
    "channel",
    "closure",
    "lifetime",
    "iterator",
    "compile",
    "linker",
    "profile",
    "release",
    "branch",
    "commit",
    "review",
    "token",
    "stream",
    "window",
    "theme",
    "sidebar",
    "section",
    "archive",
    "notify",
    "native",
    "latency",
    "index",
    "query",
    "snippet",
    "ranking",
    "payload",
    "cache",
    "retry",
    "timeout",
    "backoff",
    "config",
    "feature",
    "flag",
    "panic",
    "result",
    "option",
    "trait",
    "struct",
    "enum",
    "macro",
];

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn words(&mut self, n: usize) -> String {
        let mut s = String::new();
        for i in 0..n {
            if i > 0 {
                s.push(' ');
            }
            s.push_str(WORDS[(self.next() % WORDS.len() as u64) as usize]);
        }
        s
    }
}

/// One transcript: a user turn, assistant text, a Bash call and its result, repeated.
fn transcript(seed: u64, turns: usize, needle: &str) -> String {
    let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
    let mut out = String::new();
    for t in 0..turns {
        let ts = format!("2026-01-01T{:02}:{:02}:00.000Z", (t / 60) % 24, t % 60);
        let user_text = if t == turns / 2 {
            format!("please look at {needle} {}", rng.words(20))
        } else {
            rng.words(25)
        };
        let lines = [
            serde_json::json!({"type":"user","uuid":format!("u{t}"),"timestamp":ts,
                "message":{"role":"user","content":user_text}}),
            serde_json::json!({"type":"assistant","uuid":format!("a{t}"),"timestamp":ts,
                "message":{"role":"assistant","model":"m","content":[{"type":"text","text":rng.words(180)}]}}),
            serde_json::json!({"type":"assistant","uuid":format!("c{t}"),"timestamp":ts,
                "message":{"role":"assistant","model":"m","content":[{"type":"tool_use","id":format!("t{t}"),
                "name":"Bash","input":{"command":rng.words(8),"description":rng.words(5)}}]}}),
            serde_json::json!({"type":"user","uuid":format!("r{t}"),"timestamp":ts,
                "message":{"role":"user","content":[{"type":"tool_result","tool_use_id":format!("t{t}"),
                "content":rng.words(120)}]}}),
        ];
        for l in lines {
            writeln!(out, "{l}").unwrap();
        }
    }
    out
}

#[test]
fn forty_transcripts_index_under_ten_seconds_and_queries_under_200ms() {
    let dir = tempfile::tempdir().unwrap();
    let mut bytes = 0u64;
    let mut files = Vec::new();
    for n in 0..40u64 {
        let p = dir.path().join(format!("s{n}.jsonl"));
        let text = transcript(n + 1, 250, &format!("needlexyz{n}"));
        bytes += text.len() as u64;
        std::fs::write(&p, text).unwrap();
        files.push(p);
    }
    assert!(
        bytes > 20_000_000,
        "corpus is realistic in size: {bytes} bytes"
    );

    let mut ix = SearchIndex::open(dir.path().join("idx")).unwrap();
    let started = Instant::now();
    let mut docs = 0;
    for (n, p) in files.iter().enumerate() {
        docs += index_file(&mut ix, &format!("dm{n}"), p).unwrap();
    }
    let took = started.elapsed();
    eprintln!("indexed {docs} items from {bytes} bytes in {took:?}");
    assert!(took.as_secs_f64() < 10.0, "indexing took {took:?}");
    assert!(docs >= 40 * 250 * 3);

    for (query, want_at_least) in [
        ("needlexyz17", 1),
        ("refactor parser", 100),
        ("deploy", 100),
        ("cursor lifetime iter", 10),
    ] {
        // Warm-up (first touch of the index pages), then the best of five timed runs, so a
        // scheduling stall on a loaded machine cannot fail the test. The limit stays 200 ms.
        let mut r = ix.search(query, &Scope::default(), 50).unwrap();
        let mut took = std::time::Duration::MAX;
        for _ in 0..5 {
            let started = Instant::now();
            r = ix.search(query, &Scope::default(), 50).unwrap();
            took = took.min(started.elapsed());
        }
        eprintln!(
            "{query:?}: {} hits in {took:?} (reported {} ms)",
            r.hits.len(),
            r.took_ms
        );
        assert!(took.as_millis() < 200, "{query:?} took {took:?}");
        assert!(
            r.hits.len() >= want_at_least.min(50),
            "{query:?}: {}",
            r.hits.len()
        );
    }
    // The needle lives in exactly one transcript.
    let r = ix.search("needlexyz17", &Scope::default(), 50).unwrap();
    assert_eq!((r.hits.len(), r.hits[0].id.as_str()), (1, "dm17"));
    assert!(!r.hits[0].ranges.is_empty());

    // Unchanged files need no reindex; a changed one does.
    assert!(!needs_reindex(&ix, "dm3", &files[3]).unwrap());
    std::fs::write(&files[3], transcript(99, 3, "other")).unwrap();
    assert!(needs_reindex(&ix, "dm3", &files[3]).unwrap());
}
