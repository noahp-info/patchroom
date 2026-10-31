//! Offset-based incremental file reader for JSONL transcripts.
//!
//! [`Tail::poll`] returns the complete lines appended since the last call, each with
//! the byte offset where it starts. A trailing partial line is kept until its newline
//! arrives. If the file shrinks or is replaced (different inode), the tail starts over
//! and reports `reset`, so a rotated or rewritten (compacted) transcript is re-read
//! from the top. A missing file is not an error: the tail waits for it.

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

/// Most bytes read per poll, so one poll never stalls on a huge file.
const CHUNK: u64 = 8 * 1024 * 1024;

/// Lines read by one poll.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Poll {
    /// Complete lines as `(byte offset of line start, text without the newline)`.
    pub lines: Vec<(u64, String)>,
    /// The file was replaced or truncated. Discard everything derived from earlier polls.
    pub reset: bool,
    /// More data is waiting (the poll hit its chunk cap).
    pub more: bool,
}

/// An incremental reader for one file.
#[derive(Debug)]
pub struct Tail {
    path: PathBuf,
    /// Bytes consumed from the file (including a buffered partial line).
    offset: u64,
    /// Offset where the buffered partial line starts.
    partial_start: u64,
    partial: Vec<u8>,
    ident: Option<(u64, u64)>,
}

impl Tail {
    /// A tail that starts at the top of `path`.
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            offset: 0,
            partial_start: 0,
            partial: Vec::new(),
            ident: None,
        }
    }

    /// The file being tailed.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Read what was appended since the last call.
    ///
    /// # Errors
    /// I/O errors other than the file not existing.
    pub fn poll(&mut self) -> io::Result<Poll> {
        let mut out = Poll::default();
        let meta = match std::fs::metadata(&self.path) {
            Ok(m) => m,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                if self.ident.is_some() {
                    // The file vanished. Start over when it comes back.
                    self.restart();
                    out.reset = true;
                }
                return Ok(out);
            }
            Err(e) => return Err(e),
        };
        let ident = (meta.dev(), meta.ino());
        let len = meta.len();
        if self.ident.is_some_and(|i| i != ident) || len < self.offset {
            self.restart();
            out.reset = true;
        }
        self.ident = Some(ident);
        if len == self.offset {
            return Ok(out);
        }
        let want = (len - self.offset).min(CHUNK);
        let mut f = File::open(&self.path)?;
        f.seek(SeekFrom::Start(self.offset))?;
        let mut buf = Vec::with_capacity(usize::try_from(want).unwrap_or(0));
        f.take(want).read_to_end(&mut buf)?;
        out.more = len > self.offset + buf.len() as u64;
        self.offset += buf.len() as u64;
        self.split(buf, &mut out);
        Ok(out)
    }

    /// The buffered partial line, if it is non-empty, as a final line. Call at EOF of a
    /// file that will not grow (the `dump` tool).
    pub fn take_partial(&mut self) -> Option<(u64, String)> {
        if self.partial.is_empty() {
            return None;
        }
        let start = self.partial_start;
        let text = String::from_utf8_lossy(&self.partial).into_owned();
        self.partial.clear();
        self.partial_start = self.offset;
        Some((start, text))
    }

    fn restart(&mut self) {
        self.offset = 0;
        self.partial_start = 0;
        self.partial.clear();
        self.ident = None;
    }

    fn split(&mut self, mut buf: Vec<u8>, out: &mut Poll) {
        let base = self.offset - buf.len() as u64;
        let mut start_in_buf = 0usize;
        // Prepend the old partial line.
        let carried = std::mem::take(&mut self.partial);
        let (data_offset, data) = if carried.is_empty() {
            (base, std::mem::take(&mut buf))
        } else {
            let mut joined = carried;
            joined.extend_from_slice(&buf);
            (self.partial_start, joined)
        };
        while let Some(rel) = data[start_in_buf..].iter().position(|&b| b == b'\n') {
            let end = start_in_buf + rel;
            let mut line = &data[start_in_buf..end];
            if line.last() == Some(&b'\r') {
                line = &line[..line.len() - 1];
            }
            out.lines.push((
                data_offset + start_in_buf as u64,
                String::from_utf8_lossy(line).into_owned(),
            ));
            start_in_buf = end + 1;
        }
        self.partial = data[start_in_buf..].to_vec();
        self.partial_start = data_offset + start_in_buf as u64;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn append(p: &Path, s: &str) {
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(p)
            .unwrap();
        f.write_all(s.as_bytes()).unwrap();
    }

    #[test]
    fn reads_incrementally_and_keeps_partial_lines() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("t.jsonl");
        let mut t = Tail::new(&p);
        assert_eq!(t.poll().unwrap(), Poll::default());
        append(&p, "{\"a\":1}\n{\"b\"");
        let r = t.poll().unwrap();
        assert_eq!(r.lines, vec![(0, "{\"a\":1}".to_owned())]);
        assert!(!r.reset);
        append(&p, ":2}\n");
        let r = t.poll().unwrap();
        assert_eq!(r.lines, vec![(8, "{\"b\":2}".to_owned())]);
        assert_eq!(t.poll().unwrap(), Poll::default());
    }

    #[test]
    fn multibyte_split_across_polls_survives() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("t.jsonl");
        let bytes = "é\n".as_bytes();
        std::fs::write(&p, &bytes[..1]).unwrap();
        let mut t = Tail::new(&p);
        assert!(t.poll().unwrap().lines.is_empty());
        append(&p, "");
        let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        f.write_all(&bytes[1..]).unwrap();
        assert_eq!(t.poll().unwrap().lines, vec![(0, "é".to_owned())]);
    }

    #[test]
    fn truncation_and_replacement_reset() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("t.jsonl");
        append(&p, "one\ntwo\nthree\n");
        let mut t = Tail::new(&p);
        assert_eq!(t.poll().unwrap().lines.len(), 3);
        std::fs::write(&p, "x\n").unwrap();
        let r = t.poll().unwrap();
        assert!(r.reset);
        assert_eq!(r.lines, vec![(0, "x".to_owned())]);
        // Replace with a new file of the same or larger size (new inode).
        let q = dir.path().join("new.jsonl");
        std::fs::write(&q, "aaaa\nbbbb\n").unwrap();
        std::fs::rename(&q, &p).unwrap();
        let r = t.poll().unwrap();
        assert!(r.reset);
        assert_eq!(r.lines.len(), 2);
    }

    #[test]
    fn missing_file_is_not_an_error_and_a_vanished_one_resets() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("t.jsonl");
        let mut t = Tail::new(&p);
        assert_eq!(t.poll().unwrap(), Poll::default());
        append(&p, "a\n");
        assert_eq!(t.poll().unwrap().lines.len(), 1);
        std::fs::remove_file(&p).unwrap();
        assert!(t.poll().unwrap().reset);
        append(&p, "b\n");
        assert_eq!(t.poll().unwrap().lines, vec![(0, "b".to_owned())]);
    }

    #[test]
    fn take_partial_returns_the_unterminated_tail() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("t.jsonl");
        append(&p, "a\nlast");
        let mut t = Tail::new(&p);
        assert_eq!(t.poll().unwrap().lines.len(), 1);
        assert_eq!(t.take_partial(), Some((2, "last".to_owned())));
        assert_eq!(t.take_partial(), None);
    }

    #[test]
    fn crlf_is_trimmed() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("t.jsonl");
        append(&p, "a\r\n");
        let mut t = Tail::new(&p);
        assert_eq!(t.poll().unwrap().lines[0].1, "a");
    }
}
