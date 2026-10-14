//! Small text helpers: tag extraction, ANSI stripping, truncation, timestamps.

use serde_json::Value;

/// The inner text of the first `<tag ...>...</tag>`, if both ends exist.
pub(crate) fn tag_inner<'a>(s: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}");
    let start = s.find(&open)?;
    let after_open = &s[start + open.len()..];
    // The opening tag must end here: `<tag>` or `<tag attr="x">`, not `<tagger>`.
    let first = after_open.chars().next()?;
    if first != '>' && !first.is_whitespace() {
        return None;
    }
    let gt = after_open.find('>')?;
    let body = &after_open[gt + 1..];
    let close = format!("</{tag}");
    let end = body.find(&close)?;
    Some(&body[..end])
}

/// Remove every `<tag ...>...</tag>` block (and an unterminated trailing one).
pub(crate) fn strip_blocks(s: &str, tag: &str) -> String {
    let open = format!("<{tag}");
    let close = format!("</{tag}");
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find(&open) {
        let after = &rest[start + open.len()..];
        let ok = after
            .chars()
            .next()
            .is_some_and(|c| c == '>' || c.is_whitespace());
        if !ok {
            out.push_str(&rest[..start + open.len()]);
            rest = after;
            continue;
        }
        out.push_str(&rest[..start]);
        match after.find(&close) {
            Some(c) => {
                let tail = &after[c + close.len()..];
                rest = tail.find('>').map_or("", |g| &tail[g + 1..]);
            }
            None => {
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

/// Replace `<pasted_content id="x">body</pasted_content id="x">` with `body`.
pub(crate) fn unwrap_pasted(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find("<pasted_content") {
        out.push_str(&rest[..start]);
        let after = &rest[start..];
        let Some(gt) = after.find('>') else {
            out.push_str(after);
            return out;
        };
        let body_and_rest = &after[gt + 1..];
        match body_and_rest.find("</pasted_content") {
            Some(end) => {
                out.push_str(body_and_rest[..end].trim_matches('\n'));
                let tail = &body_and_rest[end..];
                rest = tail.find('>').map_or("", |g| &tail[g + 1..]);
            }
            None => {
                out.push_str(body_and_rest.trim_matches('\n'));
                return out;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Strip ANSI escape sequences (CSI and OSC) from `s`.
pub(crate) fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match it.peek() {
            Some('[') => {
                it.next();
                for n in it.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&n) {
                        break;
                    }
                }
            }
            Some(']') => {
                it.next();
                while let Some(n) = it.next() {
                    if n == '\u{7}' {
                        break;
                    }
                    if n == '\u{1b}' {
                        it.next();
                        break;
                    }
                }
            }
            Some(_) => {
                it.next();
            }
            None => {}
        }
    }
    out
}

/// Cut `s` to at most `limit` bytes on a char boundary. Returns the text and whether it was cut.
pub(crate) fn truncate_utf8(s: &str, limit: usize) -> (String, bool) {
    if s.len() <= limit {
        return (s.to_owned(), false);
    }
    let mut end = limit;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    (s[..end].to_owned(), true)
}

/// Cut every string inside `v` to `limit` bytes. Returns true when anything was cut.
pub(crate) fn truncate_strings(v: &mut Value, limit: usize) -> bool {
    match v {
        Value::String(s) => {
            if s.len() > limit {
                let (cut, _) = truncate_utf8(s, limit);
                let dropped = s.len() - cut.len();
                *s = format!("{cut}\n... [{dropped} more bytes not shown]");
                true
            } else {
                false
            }
        }
        Value::Array(a) => a
            .iter_mut()
            .fold(false, |acc, x| truncate_strings(x, limit) | acc),
        Value::Object(o) => o
            .values_mut()
            .fold(false, |acc, x| truncate_strings(x, limit) | acc),
        _ => false,
    }
}

/// Parse `2026-10-13T20:11:20.363Z` into epoch milliseconds. Returns 0 on any surprise.
pub(crate) fn parse_ts(s: &str) -> i64 {
    parse_ts_opt(s).unwrap_or(0)
}

fn parse_ts_opt(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || (b[10] != b'T' && b[10] != b' ') {
        return None;
    }
    let num = |a: usize, z: usize| -> Option<i64> { s.get(a..z)?.parse::<i64>().ok() };
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, sec) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    let mut ms = 0;
    let mut rest = s.get(19..)?;
    if let Some(frac) = rest.strip_prefix('.') {
        let digits: String = frac.chars().take_while(char::is_ascii_digit).collect();
        let padded = format!("{digits:0<3}");
        ms = padded.get(..3)?.parse::<i64>().ok()?;
        rest = &frac[digits.len()..];
    }
    let mut offset_min = 0;
    if let Some(sign @ ('+' | '-')) = rest.chars().next() {
        let h2: i64 = rest.get(1..3)?.parse().ok()?;
        let m2: i64 = rest.get(4..6).and_then(|x| x.parse().ok()).unwrap_or(0);
        offset_min = (h2 * 60 + m2) * if sign == '+' { 1 } else { -1 };
    }
    // Days from civil (Howard Hinnant).
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 24 + h) * 60 + mi - offset_min) * 60_000 + sec * 1000 + ms)
}

/// "1m 12s" style duration.
pub(crate) fn fmt_duration(ms: u64) -> String {
    let total = ms / 1000;
    let (h, m, s) = (total / 3600, (total % 3600) / 60, total % 60);
    if h > 0 {
        format!("{h}h {m}m {s}s")
    } else if m > 0 {
        format!("{m}m {s}s")
    } else if total > 0 {
        format!("{s}s")
    } else {
        format!("{ms}ms")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tags_are_extracted_and_stripped() {
        assert_eq!(tag_inner("a<x id=\"1\">b</x id=\"1\">c", "x"), Some("b"));
        assert_eq!(tag_inner("<xy>b</xy>", "x"), None);
        assert_eq!(
            strip_blocks(
                "hi <system-reminder>secret</system-reminder> there",
                "system-reminder"
            ),
            "hi  there"
        );
        assert_eq!(strip_blocks("a <b>x", "b"), "a ");
        assert_eq!(strip_blocks("no tags", "b"), "no tags");
    }

    #[test]
    fn pasted_content_is_unwrapped() {
        let s = "\n\n<pasted_content id=\"47b5\">\nline A\nline B\n</pasted_content id=\"47b5\">\n";
        assert_eq!(unwrap_pasted(s).trim(), "line A\nline B");
        assert_eq!(unwrap_pasted("plain"), "plain");
    }

    #[test]
    fn ansi_is_stripped() {
        assert_eq!(
            strip_ansi("\u{1b}[2mCompacted\u{1b}[22m ok"),
            "Compacted ok"
        );
        assert_eq!(strip_ansi("a\u{1b}]0;title\u{7}b"), "ab");
    }

    #[test]
    fn truncation_respects_char_boundaries() {
        let (t, cut) = truncate_utf8("héllo", 2);
        assert!(cut);
        assert_eq!(t, "h");
        assert_eq!(truncate_utf8("abc", 10), ("abc".to_owned(), false));
    }

    #[test]
    fn timestamps_parse() {
        assert_eq!(parse_ts("1970-01-01T00:00:00.000Z"), 0);
        assert_eq!(parse_ts("2026-10-13T20:11:20.363Z"), 1_791_922_280_363);
        assert_eq!(parse_ts("garbage"), 0);
        assert_eq!(parse_ts("1970-01-01T01:00:00+01:00"), 0);
    }

    #[test]
    fn durations_format() {
        assert_eq!(fmt_duration(72_000), "1m 12s");
        assert_eq!(fmt_duration(3_725_000), "1h 2m 5s");
        assert_eq!(fmt_duration(400), "400ms");
    }
}
