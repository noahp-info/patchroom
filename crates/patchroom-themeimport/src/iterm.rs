//! iTerm2: profiles in `com.googlecode.iterm2.plist`, and `.itermcolors` files.
//!
//! The owner's plan named `plutil -convert json -o -`. That conversion fails on these files
//! ("Invalid object in plist for JSON format") because they hold `<data>` and `<date>` values,
//! so the `plist` crate reads them in process instead. It opens the file read-only, like plutil.

use std::path::Path;

use plist::{Dictionary, Value};

use crate::{
    family_from_postscript, hex, read_capped, slug, Env, Imported, Palette, Skipped, Source,
    MAX_PLIST, XTERM_ANSI,
};

const PREFS: &str = "Library/Preferences/com.googlecode.iterm2.plist";

fn component(d: &Dictionary, key: &str) -> Option<f64> {
    let v = d.get(key)?;
    v.as_real()
        .or_else(|| v.as_signed_integer().map(|i| i as f64))
}

/// One color dict (`Red Component` and friends). Profiles with separate light and dark colors
/// keep them under `<key> (Dark)` and `<key> (Light)`; the plain key wins, then dark.
fn color(d: &Dictionary, key: &str) -> Option<String> {
    let c = d
        .get(key)
        .or_else(|| d.get(&format!("{key} (Dark)")))?
        .as_dictionary()?;
    Some(hex(
        component(c, "Red Component")?,
        component(c, "Green Component")?,
        component(c, "Blue Component")?,
    ))
}

/// `"JetBrainsMono-Regular 13"` -> (`JetBrains Mono`, 13).
fn font(spec: &str) -> (Option<String>, Option<f64>) {
    let spec = spec.trim();
    match spec.rsplit_once(' ') {
        Some((name, size)) if size.parse::<f64>().is_ok() => (
            Some(family_from_postscript(name)),
            size.parse::<f64>().ok().filter(|s| *s > 0.0),
        ),
        _ if !spec.is_empty() => (Some(family_from_postscript(spec)), None),
        _ => (None, None),
    }
}

/// A palette from a profile or `.itermcolors` dict. Missing ANSI slots use iTerm's xterm defaults.
fn palette(d: &Dictionary) -> Result<Palette, String> {
    let background = color(d, "Background Color").ok_or("no background color")?;
    let foreground = color(d, "Foreground Color").ok_or("no foreground color")?;
    let ansi = (0..16)
        .map(|i| color(d, &format!("Ansi {i} Color")).unwrap_or_else(|| XTERM_ANSI[i].to_owned()))
        .collect();
    Ok(Palette {
        background,
        foreground,
        cursor: color(d, "Cursor Color"),
        selection: color(d, "Selection Color"),
        ansi,
    })
}

fn profile(name: &str, d: &Dictionary) -> Result<Imported, String> {
    let palette = palette(d)?;
    let (font, font_size) = d
        .get("Normal Font")
        .and_then(Value::as_string)
        .map_or((None, None), font);
    Ok(Imported {
        id: format!("iterm2:{}", slug(name)),
        name: name.to_owned(),
        source: "iterm2".into(),
        palette,
        font,
        font_size,
        accent: color(d, "Link Color"),
    })
}

pub(crate) fn detect(env: &Env) -> Option<Source> {
    let prefs = env.home.join(PREFS);
    let app = env.applications.join("iTerm.app");
    if !prefs.is_file() && !app.exists() {
        return None;
    }
    let mut src = Source {
        id: "iterm2".into(),
        name: "iTerm2".into(),
        entries: Vec::new(),
        skipped: Vec::new(),
    };
    let root = read_capped(&prefs, MAX_PLIST)
        .and_then(|b| Value::from_reader(std::io::Cursor::new(b)).ok());
    let profiles = root
        .as_ref()
        .and_then(Value::as_dictionary)
        .and_then(|d| d.get("New Bookmarks"))
        .and_then(Value::as_array);
    for p in profiles.into_iter().flatten() {
        let Some(d) = p.as_dictionary() else { continue };
        let name = d
            .get("Name")
            .and_then(Value::as_string)
            .unwrap_or("Unnamed profile");
        match profile(name, d) {
            Ok(mut imp) => {
                // Two profiles may share a name; keep ids unique.
                let n = src.entries.iter().filter(|e| e.id == imp.id).count();
                if n > 0 {
                    imp.id = format!("{}-{}", imp.id, n + 1);
                }
                src.entries.push(imp);
            }
            Err(reason) => src.skipped.push(Skipped {
                name: name.to_owned(),
                reason,
            }),
        }
    }
    Some(src)
}

/// Read one `.itermcolors` file the user picked. Read only.
///
/// # Errors
/// The path is not an `.itermcolors` file, is too large, or holds no background and foreground.
pub fn read_itermcolors(path: &Path) -> Result<Imported, String> {
    let ok_ext = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("itermcolors"));
    if !ok_ext {
        return Err("choose an .itermcolors file".into());
    }
    let bytes = read_capped(path, MAX_PLIST).ok_or("the file could not be read")?;
    let v = Value::from_reader(std::io::Cursor::new(bytes)).map_err(|e| e.to_string())?;
    let d = v.as_dictionary().ok_or("not an iTerm2 color preset")?;
    let name = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("iTerm2 colors")
        .to_owned();
    let palette = palette(d)?;
    Ok(Imported {
        id: format!("file:{}", slug(&name)),
        name,
        source: "file".into(),
        palette,
        font: None,
        font_size: None,
        accent: color(d, "Link Color"),
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::testutil::{env, write};

    pub fn color_dict(r: f64, g: f64, b: f64) -> Value {
        let mut d = Dictionary::new();
        d.insert("Red Component".into(), Value::Real(r));
        d.insert("Green Component".into(), Value::Real(g));
        d.insert("Blue Component".into(), Value::Real(b));
        d.insert("Color Space".into(), Value::String("sRGB".into()));
        Value::Dictionary(d)
    }

    fn profile_dict(name: &str, with_bg: bool) -> Value {
        let mut d = Dictionary::new();
        d.insert("Name".into(), Value::String(name.into()));
        if with_bg {
            d.insert("Background Color".into(), color_dict(0.0, 0.0, 0.0));
        }
        d.insert("Foreground Color".into(), color_dict(1.0, 1.0, 1.0));
        d.insert("Ansi 1 Color".into(), color_dict(1.0, 0.0, 0.0));
        d.insert("Cursor Color".into(), color_dict(0.0, 1.0, 0.0));
        d.insert(
            "Normal Font".into(),
            Value::String("JetBrainsMono-Regular 14".into()),
        );
        // A binary value: the reason `plutil -convert json` refuses the real file.
        d.insert("Background Image Data".into(), Value::Data(vec![1, 2, 3]));
        Value::Dictionary(d)
    }

    #[test]
    fn profiles_read_from_the_binary_prefs() {
        let tmp = tempfile::tempdir().unwrap();
        let mut root = Dictionary::new();
        root.insert(
            "New Bookmarks".into(),
            Value::Array(vec![
                profile_dict("Default", true),
                profile_dict("Default", true),
                profile_dict("Broken", false),
            ]),
        );
        let mut buf = Vec::new();
        Value::Dictionary(root).to_writer_binary(&mut buf).unwrap();
        write(tmp.path(), &format!("home/{PREFS}"), buf);
        let src = detect(&env(tmp.path())).unwrap();
        assert_eq!(src.entries.len(), 2);
        let e = &src.entries[0];
        assert_eq!(e.id, "iterm2:default");
        assert_eq!(src.entries[1].id, "iterm2:default-2");
        assert_eq!(e.palette.background, "#000000");
        assert_eq!(e.palette.foreground, "#ffffff");
        assert_eq!(e.palette.ansi[1], "#ff0000");
        assert_eq!(e.palette.ansi[0], XTERM_ANSI[0]);
        assert_eq!(e.palette.cursor.as_deref(), Some("#00ff00"));
        assert_eq!(e.font.as_deref(), Some("JetBrains Mono"));
        assert_eq!(e.font_size, Some(14.0));
        assert_eq!(src.skipped.len(), 1);
        assert_eq!(src.skipped[0].name, "Broken");
    }

    #[test]
    fn app_without_prefs_still_counts_as_installed() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("Applications/iTerm.app")).unwrap();
        let src = detect(&env(tmp.path())).unwrap();
        assert!(src.entries.is_empty());
    }

    #[test]
    fn itermcolors_files_read_and_other_files_are_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let mut d = Dictionary::new();
        d.insert("Background Color".into(), color_dict(0.0, 0.17, 0.21));
        d.insert("Foreground Color".into(), color_dict(0.51, 0.58, 0.59));
        d.insert(
            "Selection Color (Dark)".into(),
            color_dict(0.03, 0.21, 0.26),
        );
        let path = tmp.path().join("Solarized Dark.itermcolors");
        Value::Dictionary(d).to_file_xml(&path).unwrap();
        let before = std::fs::read(&path).unwrap();
        let imp = read_itermcolors(&path).unwrap();
        assert_eq!(imp.name, "Solarized Dark");
        assert_eq!(imp.palette.background, "#002b36");
        assert_eq!(imp.palette.selection.as_deref(), Some("#083642"));
        assert_eq!(std::fs::read(&path).unwrap(), before, "read only");
        let txt = tmp.path().join("x.txt");
        std::fs::write(&txt, "hi").unwrap();
        assert!(read_itermcolors(&txt).is_err());
        let bad = tmp.path().join("bad.itermcolors");
        std::fs::write(&bad, "not a plist").unwrap();
        assert!(read_itermcolors(&bad).is_err());
    }

    #[test]
    fn font_specs_split() {
        assert_eq!(font("Menlo-Regular 12"), (Some("Menlo".into()), Some(12.0)));
        assert_eq!(font("Monaco"), (Some("Monaco".into()), None));
        assert_eq!(font(""), (None, None));
    }
}
