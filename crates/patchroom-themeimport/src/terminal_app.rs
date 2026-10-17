//! Terminal.app: profiles under `Window Settings` in `com.apple.Terminal.plist`.
//!
//! Each color is an `NSKeyedArchiver` archive of an `NSColor`, stored as data. The archive is
//! itself a binary plist, so the `plist` crate decodes it in safe Rust: the root object holds
//! `NSRGB` (ASCII "r g b"), `NSComponents` ("r g b a") or `NSWhite` ("w"). A profile whose
//! colors are present but undecodable (a pattern or catalog color) is skipped. The font is an
//! archived `NSFont` (`NSName`, `NSSize`).

use plist::{Dictionary, Value};

use crate::{
    family_from_postscript, hex, read_capped, slug, Env, Imported, Palette, Skipped, Source,
    MAX_PLIST,
};

const PREFS: &str = "Library/Preferences/com.apple.Terminal.plist";

/// Terminal.app's built-in ANSI colors, for profiles that never changed them.
const TERMINAL_ANSI: [&str; 16] = [
    "#000000", "#990000", "#00a600", "#999900", "#0000b2", "#b200b2", "#00a6b2", "#bfbfbf",
    "#666666", "#e50000", "#00d900", "#e5e500", "#0000ff", "#e500e5", "#00e5e5", "#e5e5e5",
];

const ANSI_KEYS: [&str; 8] = [
    "Black", "Red", "Green", "Yellow", "Blue", "Magenta", "Cyan", "White",
];

/// The archive's object table and its root object.
fn unarchive(data: &[u8]) -> Option<(Vec<Value>, Dictionary)> {
    let v = Value::from_reader(std::io::Cursor::new(data)).ok()?;
    let d = v.as_dictionary()?;
    let objects = d.get("$objects")?.as_array()?.clone();
    let root = d.get("$top")?.as_dictionary()?.get("root")?.as_uid()?.get();
    let root = objects
        .get(usize::try_from(root).ok()?)?
        .as_dictionary()?
        .clone();
    Some((objects, root))
}

fn floats(bytes: &[u8]) -> Vec<f64> {
    String::from_utf8_lossy(bytes)
        .trim_end_matches('\0')
        .split_whitespace()
        .filter_map(|s| s.parse().ok())
        .collect()
}

/// An archived `NSColor` as `#rrggbb`.
pub(crate) fn ns_color(data: &[u8]) -> Option<String> {
    let (_, root) = unarchive(data)?;
    for key in ["NSRGB", "NSComponents"] {
        if let Some(b) = root.get(key).and_then(Value::as_data) {
            let f = floats(b);
            if f.len() >= 3 {
                return Some(hex(f[0], f[1], f[2]));
            }
        }
    }
    let w = root.get("NSWhite").and_then(Value::as_data).map(floats)?;
    w.first().map(|w| hex(*w, *w, *w))
}

/// An archived `NSFont` as (family, size).
fn ns_font(data: &[u8]) -> Option<(String, Option<f64>)> {
    let (objects, root) = unarchive(data)?;
    let uid = root.get("NSName")?.as_uid()?.get();
    let name = objects.get(usize::try_from(uid).ok()?)?.as_string()?;
    let size = root.get("NSSize").and_then(Value::as_real);
    Some((family_from_postscript(name), size))
}

/// A color key: absent gives `None`; present but unreadable is an error.
fn color(d: &Dictionary, key: &str) -> Result<Option<String>, String> {
    match d.get(key) {
        None => Ok(None),
        Some(v) => v
            .as_data()
            .and_then(ns_color)
            .map(Some)
            .ok_or_else(|| format!("{key} could not be decoded")),
    }
}

fn profile(name: &str, d: &Dictionary) -> Result<Imported, String> {
    // Terminal.app's defaults: black text on white.
    let background = color(d, "BackgroundColor")?.unwrap_or_else(|| "#ffffff".into());
    let foreground = color(d, "TextColor")?.unwrap_or_else(|| "#000000".into());
    let mut ansi = Vec::with_capacity(16);
    for (bright, prefix) in [(0, "ANSI"), (8, "ANSIBright")] {
        for (i, c) in ANSI_KEYS.iter().enumerate() {
            let v = color(d, &format!("{prefix}{c}Color"))?;
            ansi.push(v.unwrap_or_else(|| TERMINAL_ANSI[bright + i].to_owned()));
        }
    }
    let (font, font_size) = d
        .get("Font")
        .and_then(Value::as_data)
        .and_then(ns_font)
        .map_or((None, None), |(f, s)| (Some(f), s));
    Ok(Imported {
        id: format!("terminal:{}", slug(name)),
        name: name.to_owned(),
        source: "terminal".into(),
        palette: Palette {
            background,
            foreground,
            cursor: color(d, "CursorColor")?,
            selection: color(d, "SelectionColor")?,
            ansi,
        },
        font,
        font_size,
        accent: None,
    })
}

pub(crate) fn detect(env: &Env) -> Option<Source> {
    let path = env.home.join(PREFS);
    let bytes = read_capped(&path, MAX_PLIST)?;
    let root = Value::from_reader(std::io::Cursor::new(bytes)).ok()?;
    let mut src = Source {
        id: "terminal".into(),
        name: "Terminal".into(),
        entries: Vec::new(),
        skipped: Vec::new(),
    };
    let profiles = root
        .as_dictionary()
        .and_then(|d| d.get("Window Settings"))
        .and_then(Value::as_dictionary);
    for (name, v) in profiles.into_iter().flatten() {
        let Some(d) = v.as_dictionary() else { continue };
        match profile(name, d) {
            Ok(imp) => src.entries.push(imp),
            Err(reason) => src.skipped.push(Skipped {
                name: name.clone(),
                reason,
            }),
        }
    }
    Some(src)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{env, write};
    use plist::Uid;

    /// A minimal keyed archive with `root` as object 1.
    fn archive(root: Dictionary, extra: Vec<Value>) -> Vec<u8> {
        let mut objects = vec![Value::String("$null".into()), Value::Dictionary(root)];
        objects.extend(extra);
        let mut top = Dictionary::new();
        top.insert("root".into(), Value::Uid(Uid::new(1)));
        let mut d = Dictionary::new();
        d.insert("$archiver".into(), Value::String("NSKeyedArchiver".into()));
        d.insert("$objects".into(), Value::Array(objects));
        d.insert("$top".into(), Value::Dictionary(top));
        let mut buf = Vec::new();
        Value::Dictionary(d).to_writer_binary(&mut buf).unwrap();
        buf
    }

    fn rgb(s: &str) -> Value {
        let mut r = Dictionary::new();
        r.insert("NSColorSpace".into(), Value::Integer(1.into()));
        r.insert("NSRGB".into(), Value::Data(format!("{s}\0").into_bytes()));
        Value::Data(archive(r, vec![]))
    }

    fn font(name: &str, size: f64) -> Value {
        let mut r = Dictionary::new();
        r.insert("NSName".into(), Value::Uid(Uid::new(2)));
        r.insert("NSSize".into(), Value::Real(size));
        Value::Data(archive(r, vec![Value::String(name.into())]))
    }

    #[test]
    fn archived_colors_decode() {
        let Value::Data(d) = rgb("1 0.5 0") else {
            unreachable!()
        };
        assert_eq!(ns_color(&d).as_deref(), Some("#ff8000"));
        let mut w = Dictionary::new();
        w.insert("NSWhite".into(), Value::Data(b"0.5\0".to_vec()));
        assert_eq!(ns_color(&archive(w, vec![])).as_deref(), Some("#808080"));
        assert_eq!(ns_color(b"junk"), None);
    }

    #[test]
    fn profiles_read_and_undecodable_ones_are_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        let mut pro = Dictionary::new();
        pro.insert("BackgroundColor".into(), rgb("0 0 0"));
        pro.insert("TextColor".into(), rgb("0.2 1 0.2"));
        pro.insert("ANSIRedColor".into(), rgb("1 0 0"));
        pro.insert("Font".into(), font("SFMono-Regular", 12.0));
        let mut broken = Dictionary::new();
        broken.insert(
            "BackgroundColor".into(),
            Value::Data(b"not an archive".to_vec()),
        );
        let basic = Dictionary::new();
        let mut ws = Dictionary::new();
        ws.insert("Pro".into(), Value::Dictionary(pro));
        ws.insert("Pattern".into(), Value::Dictionary(broken));
        ws.insert("Basic".into(), Value::Dictionary(basic));
        let mut root = Dictionary::new();
        root.insert("Window Settings".into(), Value::Dictionary(ws));
        let mut buf = Vec::new();
        Value::Dictionary(root).to_writer_binary(&mut buf).unwrap();
        write(tmp.path(), &format!("home/{PREFS}"), buf);

        let src = detect(&env(tmp.path())).unwrap();
        let pro = src.entries.iter().find(|e| e.name == "Pro").unwrap();
        assert_eq!(pro.palette.background, "#000000");
        assert_eq!(pro.palette.foreground, "#33ff33");
        assert_eq!(pro.palette.ansi[1], "#ff0000");
        assert_eq!(pro.palette.ansi[2], TERMINAL_ANSI[2]);
        assert_eq!(pro.font.as_deref(), Some("SF Mono"));
        assert_eq!(pro.font_size, Some(12.0));
        let basic = src.entries.iter().find(|e| e.name == "Basic").unwrap();
        assert_eq!(basic.palette.background, "#ffffff");
        assert_eq!(src.skipped.len(), 1);
        assert_eq!(src.skipped[0].name, "Pattern");
    }

    #[test]
    fn no_prefs_file_means_not_listed() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(detect(&env(tmp.path())).is_none());
    }
}
