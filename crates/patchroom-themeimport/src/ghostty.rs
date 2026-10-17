//! Ghostty: the config file (`key = value` lines) and named theme files in the same format.
//!
//! The current look is the named `theme` (from the user's themes folder, else the app bundle)
//! with the config's own colors on top. Each file in the user's themes folder is listed too.

use std::path::{Path, PathBuf};

use crate::{
    first_family, norm_hex, read_text, slug, Env, Imported, Palette, Skipped, Source, XTERM_ANSI,
};

const CONFIGS: [&str; 3] = [
    ".config/ghostty/config",
    ".config/ghostty/config.ghostty",
    "Library/Application Support/com.mitchellh.ghostty/config",
];
const USER_THEMES: &str = ".config/ghostty/themes";
const BUNDLE_THEMES: &str = "Ghostty.app/Contents/Resources/ghostty/themes";

/// Ghostty's own defaults.
const DEFAULT_BG: &str = "#282c34";
const DEFAULT_FG: &str = "#ffffff";

/// The keys a look needs, in file order (later lines win).
#[derive(Default, Clone)]
struct Look {
    bg: Option<String>,
    fg: Option<String>,
    cursor: Option<String>,
    selection: Option<String>,
    ansi: [Option<String>; 16],
    font: Option<String>,
    size: Option<f64>,
    theme: Option<String>,
}

fn parse(text: &str, into: &mut Look) {
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        let v = v.trim().trim_matches('"');
        match k.trim() {
            "background" => into.bg = norm_hex(v).or(into.bg.take()),
            "foreground" => into.fg = norm_hex(v).or(into.fg.take()),
            "cursor-color" => into.cursor = norm_hex(v).or(into.cursor.take()),
            "selection-background" => into.selection = norm_hex(v).or(into.selection.take()),
            "palette" => {
                if let Some((i, c)) = v.split_once('=') {
                    if let (Ok(i), Some(c)) = (i.trim().parse::<usize>(), norm_hex(c)) {
                        if i < 16 {
                            into.ansi[i] = Some(c);
                        }
                    }
                }
            }
            // Ghostty allows several font-family lines as fallbacks; the first is the face.
            "font-family" if into.font.is_none() => into.font = first_family(v),
            "font-size" => into.size = v.parse().ok().filter(|s: &f64| *s > 0.0),
            "theme" => into.theme = Some(v.to_owned()),
            _ => {}
        }
    }
}

/// `theme = light:A,dark:B` names two themes; the dark one is taken, else the first.
fn theme_name(v: &str) -> Option<String> {
    let parts: Vec<&str> = v.split(',').map(str::trim).collect();
    let pick = parts
        .iter()
        .find_map(|p| p.strip_prefix("dark:"))
        .or_else(|| {
            parts
                .first()
                .map(|p| p.split_once(':').map_or(*p, |(_, n)| n))
        })?;
    let pick = pick.trim();
    // A theme name is a file name: never a path.
    (!pick.is_empty() && !pick.contains('/') && pick != "..").then(|| pick.to_owned())
}

fn theme_file(env: &Env, name: &str) -> Option<PathBuf> {
    [
        env.home.join(USER_THEMES).join(name),
        env.applications.join(BUNDLE_THEMES).join(name),
    ]
    .into_iter()
    .find(|p| p.is_file())
}

fn imported(id: String, name: &str, l: &Look) -> Imported {
    let ansi = (0..16)
        .map(|i| {
            l.ansi[i]
                .clone()
                .unwrap_or_else(|| XTERM_ANSI[i].to_owned())
        })
        .collect();
    Imported {
        id,
        name: name.to_owned(),
        source: "ghostty".into(),
        palette: Palette {
            background: l.bg.clone().unwrap_or_else(|| DEFAULT_BG.into()),
            foreground: l.fg.clone().unwrap_or_else(|| DEFAULT_FG.into()),
            cursor: l.cursor.clone(),
            selection: l.selection.clone(),
            ansi,
        },
        font: l.font.clone(),
        font_size: l.size,
        accent: None,
    }
}

fn configs(env: &Env) -> Vec<PathBuf> {
    CONFIGS
        .iter()
        .map(|c| env.home.join(c))
        .filter(|p| p.is_file())
        .collect()
}

pub(crate) fn detect(env: &Env) -> Option<Source> {
    let cfgs = configs(env);
    let app = env.applications.join("Ghostty.app");
    let user_themes = env.home.join(USER_THEMES);
    if cfgs.is_empty() && !app.exists() && !user_themes.is_dir() {
        return None;
    }
    let mut src = Source {
        id: "ghostty".into(),
        name: "Ghostty".into(),
        entries: Vec::new(),
        skipped: Vec::new(),
    };

    // The current look: config files in load order, the named theme under them.
    let mut cfg = Look::default();
    for p in &cfgs {
        if let Some(t) = read_text(p) {
            parse(&t, &mut cfg);
        }
    }
    let mut look = Look::default();
    if let Some(name) = cfg.theme.as_deref().and_then(theme_name) {
        match theme_file(env, &name).and_then(|p| read_text(&p)) {
            Some(t) => parse(&t, &mut look),
            None => src.skipped.push(Skipped {
                name: format!("Theme {name}"),
                reason: "the theme file was not found".into(),
            }),
        }
    }
    for p in &cfgs {
        if let Some(t) = read_text(p) {
            parse(&t, &mut look);
        }
    }
    src.entries
        .push(imported("ghostty:config".into(), "Current config", &look));

    // Each user theme file. Font and size follow the config, since themes carry colors only.
    let mut names: Vec<PathBuf> = std::fs::read_dir(&user_themes)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .collect();
    names.sort();
    for p in names {
        let name = file_name(&p);
        let mut l = Look {
            font: cfg.font.clone(),
            size: cfg.size,
            ..Look::default()
        };
        match read_text(&p) {
            Some(t) => {
                parse(&t, &mut l);
                if l.bg.is_none() && l.fg.is_none() {
                    src.skipped.push(Skipped {
                        name,
                        reason: "no background or foreground".into(),
                    });
                    continue;
                }
                src.entries.push(imported(
                    format!("ghostty:theme-{}", slug(&name)),
                    &name,
                    &l,
                ));
            }
            None => src.skipped.push(Skipped {
                name,
                reason: "the file could not be read".into(),
            }),
        }
    }
    Some(src)
}

fn file_name(p: &Path) -> String {
    p.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("theme")
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{env, write};

    #[test]
    fn config_over_named_theme() {
        let tmp = tempfile::tempdir().unwrap();
        write(
            tmp.path(),
            "Applications/Ghostty.app/Contents/Resources/ghostty/themes/Dracula",
            "background = 282a36\nforeground = f8f8f2\npalette = 1=#ff5555\npalette = 4=#bd93f9\n",
        );
        write(
            tmp.path(),
            "home/.config/ghostty/config",
            "# mine\ntheme = light:Nope,dark:Dracula\nfont-family = \"Fira Code\"\nfont-family = Menlo\nfont-size = 15\npalette = 4=#0000ff\n",
        );
        write(
            tmp.path(),
            "home/.config/ghostty/themes/Paper",
            "background = #fafafa\nforeground = #111111\ncursor-color = #222222\n",
        );
        write(
            tmp.path(),
            "home/.config/ghostty/themes/Empty",
            "# nothing\n",
        );
        let src = detect(&env(tmp.path())).unwrap();
        let cur = &src.entries[0];
        assert_eq!(cur.name, "Current config");
        assert_eq!(cur.palette.background, "#282a36");
        assert_eq!(cur.palette.ansi[1], "#ff5555");
        assert_eq!(
            cur.palette.ansi[4], "#0000ff",
            "the config wins over the theme"
        );
        assert_eq!(cur.font.as_deref(), Some("Fira Code"));
        assert_eq!(cur.font_size, Some(15.0));
        let paper = src.entries.iter().find(|e| e.name == "Paper").unwrap();
        assert_eq!(paper.palette.background, "#fafafa");
        assert_eq!(paper.palette.cursor.as_deref(), Some("#222222"));
        assert_eq!(paper.font_size, Some(15.0));
        assert_eq!(src.skipped.len(), 1);
        assert_eq!(src.skipped[0].name, "Empty");
    }

    #[test]
    fn missing_theme_is_reported_and_defaults_fill_in() {
        let tmp = tempfile::tempdir().unwrap();
        write(
            tmp.path(),
            "home/Library/Application Support/com.mitchellh.ghostty/config",
            "theme = ../../etc/passwd\ntheme = Gone\n",
        );
        let src = detect(&env(tmp.path())).unwrap();
        assert_eq!(src.entries[0].palette.background, DEFAULT_BG);
        assert_eq!(src.skipped[0].reason, "the theme file was not found");
    }

    #[test]
    fn theme_names_never_become_paths() {
        assert_eq!(theme_name("../x").as_deref(), None);
        assert_eq!(theme_name("a/b"), None);
        assert_eq!(theme_name("Nord").as_deref(), Some("Nord"));
        assert_eq!(theme_name("light:A, dark:B").as_deref(), Some("B"));
        assert_eq!(theme_name("light:A").as_deref(), Some("A"));
    }
}
