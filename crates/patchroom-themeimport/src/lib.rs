//! Read-only import of terminal looks from the tools a user already has.
//!
//! Each importer reads one tool's own files and returns a terminal palette (16 ANSI colors,
//! background, foreground, cursor, selection), a font and a size. Nothing here writes, renames
//! or locks a file: every read goes through [`read_capped`], which opens the file read-only and
//! refuses anything larger than a cap.
//!
//! Every function takes an [`Env`] (the home folder and the Applications folder), so tests run
//! against fixture trees under a temporary folder and never touch the real user's files.

use std::path::{Path, PathBuf};

use serde::Serialize;

mod ghostty;
mod iterm;
mod terminal_app;
mod vscode;
mod warp;

pub use iterm::read_itermcolors;

/// Largest preference plist read (iTerm2's can hold many profiles).
const MAX_PLIST: u64 = 16 * 1024 * 1024;
/// Largest text config read.
const MAX_TEXT: u64 = 2 * 1024 * 1024;

/// Where to look: the user's home and the Applications folder.
#[derive(Debug, Clone)]
pub struct Env {
    pub home: PathBuf,
    pub applications: PathBuf,
}

impl Env {
    /// The real user: `$HOME` and `/Applications`.
    #[must_use]
    pub fn real() -> Option<Self> {
        let home = std::env::var_os("HOME").filter(|h| !h.is_empty())?;
        Some(Self {
            home: PathBuf::from(home),
            applications: PathBuf::from("/Applications"),
        })
    }
}

/// A terminal palette. Colors are `#rrggbb`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Palette {
    pub background: String,
    pub foreground: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection: Option<String>,
    /// Black, red, green, yellow, blue, magenta, cyan, white, then the eight bright ones.
    pub ansi: Vec<String>,
}

/// One importable look: a profile, a theme file or a config.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Imported {
    /// Stable within one detection: `<tool>:<name>`.
    pub id: String,
    pub name: String,
    /// The tool id (`iterm2`, `ghostty`, `warp`, `vscode`, `cursor`, `terminal`, `file`).
    pub source: String,
    pub palette: Palette,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_size: Option<f64>,
    /// The tool's own accent color, when it has one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accent: Option<String>,
}

/// A profile that was found but could not be read, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Skipped {
    pub name: String,
    pub reason: String,
}

/// One installed tool and what it offers.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Source {
    pub id: String,
    pub name: String,
    pub entries: Vec<Imported>,
    pub skipped: Vec<Skipped>,
}

/// Every installed tool, in a fixed order. A tool that is not installed is left out.
#[must_use]
pub fn detect(env: &Env) -> Vec<Source> {
    [
        iterm::detect(env),
        ghostty::detect(env),
        warp::detect(env),
        vscode::detect(env, vscode::Flavor::Code),
        vscode::detect(env, vscode::Flavor::Cursor),
        terminal_app::detect(env),
    ]
    .into_iter()
    .flatten()
    .collect()
}

/// Read a file, read-only, if it exists and is at most `max` bytes.
pub(crate) fn read_capped(path: &Path, max: u64) -> Option<Vec<u8>> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > max {
        return None;
    }
    std::fs::read(path).ok()
}

pub(crate) fn read_text(path: &Path) -> Option<String> {
    read_capped(path, MAX_TEXT).map(|b| String::from_utf8_lossy(&b).into_owned())
}

/// `#rrggbb` from 0..1 components.
pub(crate) fn hex(r: f64, g: f64, b: f64) -> String {
    let c = |v: f64| {
        let v = if v.is_finite() {
            v.clamp(0.0, 1.0)
        } else {
            0.0
        };
        // In range 0..=255 after the clamp.
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let n = (v * 255.0).round() as u8;
        n
    };
    format!("#{:02x}{:02x}{:02x}", c(r), c(g), c(b))
}

/// A hex color in any common spelling (`#rgb`, `#rrggbb`, `#rrggbbaa`, with or without `#`),
/// as `#rrggbb`. Alpha is dropped.
#[must_use]
pub fn norm_hex(s: &str) -> Option<String> {
    let t = s.trim().trim_matches(|c| c == '"' || c == '\'');
    let t = t.strip_prefix('#').unwrap_or(t);
    if !t.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let full = match t.len() {
        3 | 4 => t.chars().take(3).flat_map(|c| [c, c]).collect::<String>(),
        6 | 8 => t[..6].to_owned(),
        _ => return None,
    };
    Some(format!("#{}", full.to_ascii_lowercase()))
}

/// The standard xterm palette, for slots a tool leaves to its defaults.
pub(crate) const XTERM_ANSI: [&str; 16] = [
    "#000000", "#cd0000", "#00cd00", "#cdcd00", "#0000ee", "#cd00cd", "#00cdcd", "#e5e5e5",
    "#7f7f7f", "#ff0000", "#00ff00", "#ffff00", "#5c5cff", "#ff00ff", "#00ffff", "#ffffff",
];

/// A filesystem-safe, readable id part.
pub(crate) fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    out.trim_end_matches('-').to_owned()
}

/// A font family from a PostScript name such as `JetBrainsMono-Regular`.
pub(crate) fn family_from_postscript(ps: &str) -> String {
    let base = ps.split('-').next().unwrap_or(ps).trim();
    let known = [
        ("SFMono", "SF Mono"),
        ("JetBrainsMono", "JetBrains Mono"),
        ("FiraCode", "Fira Code"),
        ("FiraMono", "Fira Mono"),
        ("SourceCodePro", "Source Code Pro"),
        ("IBMPlexMono", "IBM Plex Mono"),
        ("CascadiaCode", "Cascadia Code"),
        ("CascadiaMono", "Cascadia Mono"),
        ("CourierNewPSMT", "Courier New"),
        ("RobotoMono", "Roboto Mono"),
        ("UbuntuMono", "Ubuntu Mono"),
    ];
    if let Some((_, f)) = known.iter().find(|(k, _)| *k == base) {
        return (*f).to_owned();
    }
    // Space at each lower-to-upper step: "HackNerdFont" -> "Hack Nerd Font".
    let mut out = String::new();
    let mut prev_lower = false;
    for c in base.chars() {
        if c.is_ascii_uppercase() && prev_lower {
            out.push(' ');
        }
        prev_lower = c.is_ascii_lowercase() || c.is_ascii_digit();
        out.push(c);
    }
    out
}

/// The first family of a CSS font list: `"'Fira Code', Menlo, monospace"` -> `Fira Code`.
pub(crate) fn first_family(list: &str) -> Option<String> {
    let f = list
        .split(',')
        .next()?
        .trim()
        .trim_matches(|c| c == '"' || c == '\'')
        .trim();
    (!f.is_empty()).then(|| f.to_owned())
}

/// Relative luminance of a `#rrggbb` color, 0 (black) to 1 (white).
#[must_use]
pub fn luminance(hex: &str) -> f64 {
    let Some(h) = norm_hex(hex) else { return 0.0 };
    let ch = |i: usize| {
        let v = f64::from(u8::from_str_radix(&h[i..i + 2], 16).unwrap_or(0)) / 255.0;
        if v <= 0.03928 {
            v / 12.92
        } else {
            ((v + 0.055) / 1.055).powf(2.4)
        }
    };
    0.2126 * ch(1) + 0.7152 * ch(3) + 0.0722 * ch(5)
}

#[cfg(test)]
pub(crate) mod testutil {
    use std::path::Path;

    pub fn write(root: &Path, rel: &str, body: impl AsRef<[u8]>) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }

    pub fn env(root: &Path) -> crate::Env {
        crate::Env {
            home: root.join("home"),
            applications: root.join("Applications"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_spellings_normalize() {
        assert_eq!(norm_hex("#ABC").as_deref(), Some("#aabbcc"));
        assert_eq!(norm_hex("'#112233'").as_deref(), Some("#112233"));
        assert_eq!(norm_hex("11223344").as_deref(), Some("#112233"));
        assert_eq!(norm_hex("#12345"), None);
        assert_eq!(norm_hex("red"), None);
        assert_eq!(hex(1.0, 0.0, 0.5), "#ff0080");
        assert_eq!(hex(2.0, f64::NAN, -1.0), "#ff0000");
    }

    #[test]
    fn font_names_read_as_families() {
        assert_eq!(
            family_from_postscript("JetBrainsMono-Regular"),
            "JetBrains Mono"
        );
        assert_eq!(family_from_postscript("Menlo-Regular"), "Menlo");
        assert_eq!(
            family_from_postscript("HackNerdFont-Bold"),
            "Hack Nerd Font"
        );
        assert_eq!(
            first_family("'Fira Code', Menlo, monospace").as_deref(),
            Some("Fira Code")
        );
        assert_eq!(first_family("  "), None);
    }

    #[test]
    fn nothing_installed_detects_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(detect(&testutil::env(tmp.path())).is_empty());
    }

    #[test]
    fn luminance_orders_light_and_dark() {
        assert!(luminance("#ffffff") > 0.99);
        assert!(luminance("#000000") < 0.01);
        assert!(luminance("#002b36") < luminance("#fdf6e3"));
    }
}
