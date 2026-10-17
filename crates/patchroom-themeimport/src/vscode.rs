//! VS Code and Cursor: the user `settings.json` (JSON with comments).
//!
//! The look is the active color theme (`workbench.colorTheme`) with the user's
//! `workbench.colorCustomizations` on top, both read for their `terminal.*` keys. The theme is
//! found by id or label in the user's extensions, then the app bundle's built-in ones, and its
//! `include` chain is followed inside the same extension folder only.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use crate::{
    first_family, norm_hex, read_text, Env, Imported, Palette, Skipped, Source, XTERM_ANSI,
};

#[derive(Debug, Clone, Copy)]
pub(crate) enum Flavor {
    Code,
    Cursor,
}

impl Flavor {
    fn id(self) -> &'static str {
        match self {
            Self::Code => "vscode",
            Self::Cursor => "cursor",
        }
    }
    fn name(self) -> &'static str {
        match self {
            Self::Code => "VS Code",
            Self::Cursor => "Cursor",
        }
    }
    fn settings(self) -> &'static str {
        match self {
            Self::Code => "Library/Application Support/Code/User/settings.json",
            Self::Cursor => "Library/Application Support/Cursor/User/settings.json",
        }
    }
    fn user_extensions(self) -> &'static str {
        match self {
            Self::Code => ".vscode/extensions",
            Self::Cursor => ".cursor/extensions",
        }
    }
    fn app(self) -> &'static str {
        match self {
            Self::Code => "Visual Studio Code.app",
            Self::Cursor => "Cursor.app",
        }
    }
}

/// VS Code's default theme when the setting is absent.
const DEFAULT_THEME: &str = "Default Dark Modern";

const ANSI_KEYS: [&str; 16] = [
    "Black",
    "Red",
    "Green",
    "Yellow",
    "Blue",
    "Magenta",
    "Cyan",
    "White",
    "BrightBlack",
    "BrightRed",
    "BrightGreen",
    "BrightYellow",
    "BrightBlue",
    "BrightMagenta",
    "BrightCyan",
    "BrightWhite",
];

/// JSONC to JSON: comments and trailing commas removed, strings left intact.
pub(crate) fn strip_jsonc(s: &str) -> String {
    let b: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    let mut in_str = false;
    while i < b.len() {
        let c = b[i];
        if in_str {
            out.push(c);
            if c == '\\' && i + 1 < b.len() {
                out.push(b[i + 1]);
                i += 2;
                continue;
            }
            if c == '"' {
                in_str = false;
            }
            i += 1;
            continue;
        }
        match (c, b.get(i + 1)) {
            ('"', _) => {
                in_str = true;
                out.push(c);
                i += 1;
            }
            ('/', Some('/')) => {
                while i < b.len() && b[i] != '\n' {
                    i += 1;
                }
            }
            ('/', Some('*')) => {
                i += 2;
                while i + 1 < b.len() && !(b[i] == '*' && b[i + 1] == '/') {
                    i += 1;
                }
                i += 2;
            }
            (',', _) => {
                let mut j = i + 1;
                while j < b.len() && b[j].is_whitespace() {
                    j += 1;
                }
                // A comma before a comment then a bracket is still trailing; good enough to
                // look past whitespace only, since comments were not yet removed there.
                if !matches!(b.get(j), Some('}' | ']')) {
                    out.push(c);
                }
                i += 1;
            }
            _ => {
                out.push(c);
                i += 1;
            }
        }
    }
    out
}

fn read_jsonc(path: &Path) -> Option<Value> {
    let t = read_text(path)?;
    // Strip twice: the first pass removes comments, the second the commas they hid.
    serde_json::from_str(&strip_jsonc(&strip_jsonc(&t))).ok()
}

/// Extension folders to search, user ones first.
fn extension_dirs(env: &Env, f: Flavor) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    for root in [
        env.home.join(f.user_extensions()),
        env.applications
            .join(f.app())
            .join("Contents/Resources/app/extensions"),
    ] {
        let mut sub: Vec<PathBuf> = std::fs::read_dir(&root)
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect();
        sub.sort();
        dirs.extend(sub);
    }
    dirs
}

/// The theme file for `theme`, matched by id or label.
fn find_theme(env: &Env, f: Flavor, theme: &str) -> Option<(PathBuf, PathBuf)> {
    for dir in extension_dirs(env, f) {
        let Some(pkg) = read_jsonc(&dir.join("package.json")) else {
            continue;
        };
        let themes = pkg.pointer("/contributes/themes").and_then(Value::as_array);
        for t in themes.into_iter().flatten() {
            let id = t.get("id").and_then(Value::as_str);
            let label = t.get("label").and_then(Value::as_str);
            if id == Some(theme) || label == Some(theme) {
                let rel = t.get("path").and_then(Value::as_str)?;
                let p = inside(&dir, rel)?;
                return Some((dir, p));
            }
        }
    }
    None
}

/// `rel` under `dir`, refusing anything that climbs out of it.
fn inside(dir: &Path, rel: &str) -> Option<PathBuf> {
    let rel = Path::new(rel);
    if rel.is_absolute()
        || rel
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return None;
    }
    Some(dir.join(rel))
}

/// The theme's `colors`, with its `include` chain under it (at most 4 deep).
fn theme_colors(ext: &Path, file: &Path, depth: u8) -> Map<String, Value> {
    let Some(v) = read_jsonc(file) else {
        return Map::new();
    };
    let mut colors = Map::new();
    if depth < 4 {
        if let Some(inc) = v.get("include").and_then(Value::as_str) {
            let base = file.parent().unwrap_or(ext);
            let rel = base.strip_prefix(ext).unwrap_or(Path::new(""));
            if let Some(p) = inside(ext, &rel.join(inc).to_string_lossy()) {
                colors = theme_colors(ext, &p, depth + 1);
            }
        }
    }
    if let Some(Value::Object(c)) = v.get("colors") {
        for (k, val) in c {
            colors.insert(k.clone(), val.clone());
        }
    }
    colors
}

pub(crate) fn detect(env: &Env, f: Flavor) -> Option<Source> {
    let settings_path = env.home.join(f.settings());
    let app = env.applications.join(f.app());
    if !settings_path.is_file() && !app.exists() {
        return None;
    }
    let mut src = Source {
        id: f.id().into(),
        name: f.name().into(),
        entries: Vec::new(),
        skipped: Vec::new(),
    };
    let settings = read_jsonc(&settings_path).unwrap_or(Value::Object(Map::new()));
    let get = |k: &str| settings.get(k);
    let theme = get("workbench.colorTheme")
        .and_then(Value::as_str)
        .unwrap_or(DEFAULT_THEME)
        .to_owned();

    let mut colors = match find_theme(env, f, &theme) {
        Some((ext, file)) => theme_colors(&ext, &file, 0),
        None => Map::new(),
    };
    if let Some(Value::Object(c)) = get("workbench.colorCustomizations") {
        let scoped = format!("[{theme}]");
        for (k, v) in c {
            if !k.starts_with('[') {
                colors.insert(k.clone(), v.clone());
            }
        }
        if let Some(Value::Object(s)) = c.get(&scoped) {
            for (k, v) in s {
                colors.insert(k.clone(), v.clone());
            }
        }
    }
    let col = |k: &str| colors.get(k).and_then(Value::as_str).and_then(norm_hex);
    let background = col("terminal.background").or_else(|| col("editor.background"));
    let foreground = col("terminal.foreground").or_else(|| col("editor.foreground"));
    let (Some(background), Some(foreground)) = (background, foreground) else {
        src.skipped.push(Skipped {
            name: theme,
            reason: "the theme's colors could not be found".into(),
        });
        return Some(src);
    };
    let ansi = ANSI_KEYS
        .iter()
        .enumerate()
        .map(|(i, k)| col(&format!("terminal.ansi{k}")).unwrap_or_else(|| XTERM_ANSI[i].to_owned()))
        .collect();
    let font = get("terminal.integrated.fontFamily")
        .or_else(|| get("editor.fontFamily"))
        .and_then(Value::as_str)
        .and_then(first_family);
    let font_size = get("terminal.integrated.fontSize")
        .or_else(|| get("editor.fontSize"))
        .and_then(Value::as_f64)
        .filter(|s| *s > 0.0);
    src.entries.push(Imported {
        id: format!("{}:current", f.id()),
        name: theme,
        source: f.id().into(),
        palette: Palette {
            background,
            foreground,
            cursor: col("terminalCursor.foreground"),
            selection: col("terminal.selectionBackground"),
            ansi,
        },
        font,
        font_size,
        accent: col("focusBorder").or_else(|| col("button.background")),
    });
    Some(src)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{env, write};

    #[test]
    fn jsonc_comments_and_trailing_commas_go() {
        let s = "{ // c\n \"a\": \"http://x\", /* b */ \"b\": [1,2,],\n}";
        let v: Value = serde_json::from_str(&strip_jsonc(&strip_jsonc(s))).unwrap();
        assert_eq!(v["a"], "http://x");
        assert_eq!(v["b"], serde_json::json!([1, 2]));
    }

    #[test]
    fn customizations_over_an_extension_theme_with_includes() {
        let tmp = tempfile::tempdir().unwrap();
        write(
            tmp.path(),
            "home/.vscode/extensions/acme.night-1.0/package.json",
            r#"{"contributes":{"themes":[{"label":"Night","path":"./themes/night.json"}]}}"#,
        );
        write(
            tmp.path(),
            "home/.vscode/extensions/acme.night-1.0/themes/base.json",
            r##"{"colors":{"editor.background":"#101010","editor.foreground":"#eeeeee","terminal.ansiRed":"#aa0000"}}"##,
        );
        write(
            tmp.path(),
            "home/.vscode/extensions/acme.night-1.0/themes/night.json",
            r##"{"include":"./base.json","colors":{"terminal.ansiBlue":"#0000aa","focusBorder":"#3399ff"}}"##,
        );
        write(
            tmp.path(),
            "home/Library/Application Support/Code/User/settings.json",
            r##"{
  // mine
  "workbench.colorTheme": "Night",
  "workbench.colorCustomizations": {
    "terminal.ansiRed": "#ff0000",
    "[Night]": { "terminal.background": "#000000" },
    "[Other]": { "terminal.background": "#ffffff" },
  },
  "editor.fontFamily": "'Fira Code', Menlo",
  "terminal.integrated.fontSize": 13,
}"##,
        );
        let src = detect(&env(tmp.path()), Flavor::Code).unwrap();
        let e = &src.entries[0];
        assert_eq!(e.name, "Night");
        assert_eq!(e.palette.background, "#000000");
        assert_eq!(e.palette.foreground, "#eeeeee");
        assert_eq!(e.palette.ansi[1], "#ff0000");
        assert_eq!(e.palette.ansi[4], "#0000aa");
        assert_eq!(e.accent.as_deref(), Some("#3399ff"));
        assert_eq!(e.font.as_deref(), Some("Fira Code"));
        assert_eq!(e.font_size, Some(13.0));
        assert!(detect(&env(tmp.path()), Flavor::Cursor).is_none());
    }

    #[test]
    fn unresolved_theme_is_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        write(
            tmp.path(),
            "home/Library/Application Support/Cursor/User/settings.json",
            r#"{"workbench.colorTheme":"Gone"}"#,
        );
        let src = detect(&env(tmp.path()), Flavor::Cursor).unwrap();
        assert!(src.entries.is_empty());
        assert_eq!(src.skipped[0].name, "Gone");
    }

    #[test]
    fn theme_paths_never_climb_out() {
        assert!(inside(Path::new("/x"), "../y.json").is_none());
        assert!(inside(Path::new("/x"), "/etc/passwd").is_none());
        assert!(inside(Path::new("/x"), "./t/a.json").is_some());
    }
}
