//! Warp: custom themes in `~/.warp/themes` (YAML).
//!
//! A theme file holds `accent`, `background`, `foreground` and `terminal_colors` with `normal`
//! and `bright` maps of the eight color names. Only that flat subset of YAML is read, by a small
//! indentation parser, so no YAML library is needed.

use std::path::PathBuf;

use crate::{norm_hex, read_text, slug, Env, Imported, Palette, Skipped, Source, XTERM_ANSI};

const THEMES: &str = ".warp/themes";
const NAMES: [&str; 8] = [
    "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
];

/// `a.b.c` keys to scalar values. Lists, anchors and multi-line values are ignored.
fn flatten(text: &str) -> Vec<(String, String)> {
    let mut stack: Vec<(usize, String)> = Vec::new();
    let mut out = Vec::new();
    for raw in text.lines() {
        let line = raw.split(" #").next().unwrap_or(raw);
        let body = line.trim_start();
        if body.is_empty() || body.starts_with('#') || body.starts_with('-') {
            continue;
        }
        let indent = line.len() - body.len();
        let Some((k, v)) = body.split_once(':') else {
            continue;
        };
        let k = k.trim().trim_matches(|c| c == '"' || c == '\'').to_owned();
        while stack.last().is_some_and(|(i, _)| *i >= indent) {
            stack.pop();
        }
        let v = v.trim();
        if v.is_empty() {
            stack.push((indent, k));
        } else {
            let mut key: Vec<&str> = stack.iter().map(|(_, s)| s.as_str()).collect();
            key.push(&k);
            out.push((
                key.join("."),
                v.trim_matches(|c| c == '"' || c == '\'').to_owned(),
            ));
        }
    }
    out
}

fn theme(id: String, name: &str, text: &str) -> Result<Imported, String> {
    let kv = flatten(text);
    let get = |k: &str| {
        kv.iter()
            .rev()
            .find(|(a, _)| a == k)
            .and_then(|(_, v)| norm_hex(v))
    };
    let background = get("background").ok_or("no background color")?;
    let foreground = get("foreground").ok_or("no foreground color")?;
    let mut ansi = Vec::with_capacity(16);
    for (off, group) in [(0, "normal"), (8, "bright")] {
        for (i, n) in NAMES.iter().enumerate() {
            ansi.push(
                get(&format!("terminal_colors.{group}.{n}"))
                    .unwrap_or_else(|| XTERM_ANSI[off + i].to_owned()),
            );
        }
    }
    Ok(Imported {
        id,
        name: name.to_owned(),
        source: "warp".into(),
        palette: Palette {
            background,
            foreground,
            cursor: get("cursor"),
            selection: None,
            ansi,
        },
        font: None,
        font_size: None,
        accent: get("accent"),
    })
}

pub(crate) fn detect(env: &Env) -> Option<Source> {
    let dir = env.home.join(THEMES);
    let app = env.applications.join("Warp.app");
    if !dir.is_dir() && !app.exists() {
        return None;
    }
    let mut src = Source {
        id: "warp".into(),
        name: "Warp".into(),
        entries: Vec::new(),
        skipped: Vec::new(),
    };
    let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.extension().and_then(|e| e.to_str()).is_some_and(|e| {
                    e.eq_ignore_ascii_case("yaml") || e.eq_ignore_ascii_case("yml")
                })
        })
        .collect();
    files.sort();
    for p in files {
        let stem = p
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("theme")
            .to_owned();
        let res = read_text(&p)
            .ok_or_else(|| "the file could not be read".to_owned())
            .and_then(|t| {
                // A `name:` key wins over the file name.
                let name = flatten(&t)
                    .into_iter()
                    .find(|(k, _)| k == "name")
                    .map_or_else(|| stem.clone(), |(_, v)| v);
                theme(format!("warp:{}", slug(&stem)), &name, &t)
            });
        match res {
            Ok(imp) => src.entries.push(imp),
            Err(reason) => src.skipped.push(Skipped { name: stem, reason }),
        }
    }
    Some(src)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{env, write};

    const SOLAR: &str = "# Solarized\naccent: '#268bd2'\nbackground: \"#002b36\"\nforeground: '#839496'\ndetails: darker\nterminal_colors:\n  normal:\n    black: '#073642'\n    red: '#dc322f'\n  bright:\n    black: '#002b36' # base03\n    white: '#fdf6e3'\n";

    #[test]
    fn theme_files_parse() {
        let tmp = tempfile::tempdir().unwrap();
        write(tmp.path(), "home/.warp/themes/solarized_dark.yaml", SOLAR);
        write(
            tmp.path(),
            "home/.warp/themes/broken.yml",
            "accent: '#ffffff'\n",
        );
        write(
            tmp.path(),
            "home/.warp/themes/notes.txt",
            "background: '#000000'\n",
        );
        let src = detect(&env(tmp.path())).unwrap();
        assert_eq!(src.entries.len(), 1);
        let e = &src.entries[0];
        assert_eq!(e.id, "warp:solarized-dark");
        assert_eq!(e.palette.background, "#002b36");
        assert_eq!(e.palette.ansi[0], "#073642");
        assert_eq!(e.palette.ansi[1], "#dc322f");
        assert_eq!(e.palette.ansi[2], XTERM_ANSI[2]);
        assert_eq!(e.palette.ansi[8], "#002b36");
        assert_eq!(e.palette.ansi[15], "#fdf6e3");
        assert_eq!(e.accent.as_deref(), Some("#268bd2"));
        assert_eq!(src.skipped.len(), 1);
        assert_eq!(src.skipped[0].name, "broken");
    }

    #[test]
    fn not_installed_is_not_listed() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(detect(&env(tmp.path())).is_none());
        std::fs::create_dir_all(tmp.path().join("Applications/Warp.app")).unwrap();
        assert!(detect(&env(tmp.path())).unwrap().entries.is_empty());
    }
}
