//! The pack registry and file serving.
//!
//! Three sources, one list:
//! * `generated-packs.json` in the bundled `sounds` resource dir: note tables the webview
//!   synthesizes (`kind: "generated"`).
//! * `<resource dir>/<slug>/pack.json`: bundled CC0 file packs (`kind: "files"`).
//! * `<data dir>/sounds/packs/<id>/pack.json`: packs imported from Claude sound profiles
//!   (`kind: "imported"`).

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use patchroom_prefs::{valid_sound_id, SOUND_EVENTS};
use serde::Serialize;
use serde_json::Value;

use crate::media::Kind;
use crate::{Result, SoundError, SOUNDS_DIR};

/// Folder under `<data dir>/sounds` that holds imported packs.
pub const IMPORTED_DIR: &str = "packs";

/// Largest pack file the registry will serve, in bytes.
const MAX_SERVED_BYTES: u64 = 4 * 1024 * 1024;

/// Largest manifest read, in bytes.
const MAX_MANIFEST_BYTES: u64 = 2 * 1024 * 1024;

/// How a pack makes sound.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PackKind {
    /// Note tables played by the oscillator engine.
    Generated,
    /// Audio files bundled with the app.
    Files,
    /// Audio files copied from the user's Claude sound profile.
    Imported,
}

/// One pack, as `sound_packs` returns it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PackInfo {
    /// Stable id.
    pub id: String,
    /// Display name.
    pub name: String,
    /// One line about the pack.
    pub description: String,
    /// How it makes sound.
    pub kind: PackKind,
    /// License of the sounds.
    pub license: String,
    /// Who made them.
    pub author: String,
    /// Where they come from, for the credits.
    pub source: String,
    /// Events the pack has a sound for.
    pub events: BTreeMap<String, bool>,
    /// Normalizing gain per event for a file pack (multiply the sound by it). Bundled packs
    /// are already leveled, so their entries are 1; imported packs carry the gain measured at
    /// import. Absent for generated packs.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub norm: BTreeMap<String, f64>,
    /// Note tables of a generated pack, as in `generated-packs.json`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<Value>,
}

struct Loaded {
    info: PackInfo,
    root: PathBuf,
    files: BTreeMap<String, PathBuf>,
}

fn read_json(path: &Path) -> Option<Value> {
    use std::io::Read;
    let f = std::fs::File::open(path).ok()?;
    let mut s = String::new();
    f.take(MAX_MANIFEST_BYTES).read_to_string(&mut s).ok()?;
    serde_json::from_str(&s).ok()
}

fn text(v: &Value, key: &str, default: &str) -> String {
    v.get(key)
        .and_then(Value::as_str)
        .unwrap_or(default)
        .chars()
        .take(300)
        .collect()
}

/// A manifest path that stays inside the pack folder.
fn safe_relative(rel: &str) -> Option<PathBuf> {
    let p = Path::new(rel);
    if p.as_os_str().is_empty() || !p.components().all(|c| matches!(c, Component::Normal(_))) {
        return None;
    }
    Some(p.to_path_buf())
}

fn load_generated(dir: &Path, out: &mut Vec<Loaded>) {
    let Some(doc) = read_json(&dir.join("generated-packs.json")) else {
        return;
    };
    let Some(list) = doc.get("packs").and_then(Value::as_array) else {
        return;
    };
    for p in list {
        let id = text(p, "id", "");
        let Some(notes) = p.get("notes").and_then(Value::as_object) else {
            continue;
        };
        if !valid_sound_id(&id) {
            continue;
        }
        let events = SOUND_EVENTS
            .iter()
            .filter(|e| {
                notes
                    .get(**e)
                    .and_then(Value::as_array)
                    .is_some_and(|a| !a.is_empty())
            })
            .map(|e| ((*e).to_owned(), true))
            .collect();
        out.push(Loaded {
            info: PackInfo {
                name: text(p, "name", &id),
                description: text(p, "blurb", ""),
                kind: PackKind::Generated,
                license: text(p, "license", "Apache-2.0"),
                author: text(p, "author", "Patchroom"),
                source: text(p, "source", "Generated in the app"),
                events,
                norm: BTreeMap::new(),
                notes: Some(Value::Object(notes.clone())),
                id,
            },
            root: dir.to_path_buf(),
            files: BTreeMap::new(),
        });
    }
}

fn load_file_pack(root: &Path, kind: PackKind, expect_id: Option<&str>) -> Option<Loaded> {
    let m = read_json(&root.join("pack.json"))?;
    let id = text(&m, "id", "");
    if !valid_sound_id(&id) || expect_id.is_some_and(|e| e != id) {
        return None;
    }
    let sounds = m.get("sounds")?.as_object()?;
    let mut files = BTreeMap::new();
    for e in SOUND_EVENTS {
        let Some(rel) = sounds.get(e).and_then(Value::as_str) else {
            continue;
        };
        let Some(rel) = safe_relative(rel) else {
            continue;
        };
        let path = root.join(rel);
        let ok_ext = path
            .extension()
            .and_then(|x| x.to_str())
            .and_then(Kind::from_ext)
            .is_some();
        if ok_ext && path.is_file() {
            files.insert(e.to_owned(), path);
        }
    }
    if files.is_empty() {
        return None;
    }
    Some(Loaded {
        info: PackInfo {
            name: text(&m, "name", &id),
            description: text(&m, "description", ""),
            kind,
            license: text(&m, "license", "unknown"),
            author: text(&m, "author", "unknown"),
            source: text(&m, "source", ""),
            events: files.keys().map(|e| (e.clone(), true)).collect(),
            norm: files
                .keys()
                .map(|e| (e.clone(), manifest_norm(&m, e)))
                .collect(),
            notes: None,
            id,
        },
        root: root.to_path_buf(),
        files,
    })
}

/// The `norm` gain a manifest stores for `event`; 1 when absent or out of range.
fn manifest_norm(m: &Value, event: &str) -> f64 {
    let (lo, hi) = crate::loudness::NORM_RANGE;
    m.get("norm")
        .and_then(|n| n.get(event))
        .and_then(Value::as_f64)
        .filter(|g| g.is_finite() && (lo..=hi).contains(g))
        .unwrap_or(1.0)
}

fn subdirs(dir: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    v.sort();
    v
}

fn load_all(resource_dir: Option<&Path>, data_dir: &Path) -> Vec<Loaded> {
    let mut out = Vec::new();
    if let Some(dir) = resource_dir {
        load_generated(dir, &mut out);
        for sub in subdirs(dir) {
            if let Some(p) = load_file_pack(&sub, PackKind::Files, None) {
                out.push(p);
            }
        }
    }
    let imported = data_dir.join(SOUNDS_DIR).join(IMPORTED_DIR);
    for sub in subdirs(&imported) {
        let name = sub.file_name().and_then(|n| n.to_str()).map(str::to_owned);
        if let Some(p) = load_file_pack(&sub, PackKind::Imported, name.as_deref()) {
            out.push(p);
        }
    }
    // First definition of an id wins; a bundled pack can never be shadowed by an import.
    let mut seen = std::collections::HashSet::new();
    out.retain(|p| seen.insert(p.info.id.clone()));
    out
}

/// Every pack: bundled first (generated, then files by folder name), then imported.
#[must_use]
pub fn list_packs(resource_dir: Option<&Path>, data_dir: &Path) -> Vec<PackInfo> {
    load_all(resource_dir, data_dir)
        .into_iter()
        .map(|p| p.info)
        .collect()
}

/// The data URL of one sound file.
pub(crate) fn data_url_of(path: &Path, kind: Kind) -> Result<String> {
    use std::io::Read;
    let f = std::fs::File::open(path)?;
    let mut buf = Vec::new();
    f.take(MAX_SERVED_BYTES + 1).read_to_end(&mut buf)?;
    if buf.len() as u64 > MAX_SERVED_BYTES {
        return Err(SoundError::new("That sound file is too large to play."));
    }
    Ok(format!("data:{};base64,{}", kind.mime(), B64.encode(buf)))
}

/// `sound_file {packId, event}`: the pack's sound for `event` as a data URL.
///
/// # Errors
/// No such pack, a generated pack (it has no files), or no sound for that event.
pub fn sound_file(
    resource_dir: Option<&Path>,
    data_dir: &Path,
    pack_id: &str,
    event: &str,
) -> Result<String> {
    if !valid_sound_id(pack_id) {
        return Err(SoundError::new("Unknown sound pack."));
    }
    let pack = load_all(resource_dir, data_dir)
        .into_iter()
        .find(|p| p.info.id == pack_id)
        .ok_or_else(|| SoundError::new(format!("No sound pack named {pack_id:?}.")))?;
    if pack.info.kind == PackKind::Generated {
        return Err(SoundError::new(format!(
            "{} is a generated pack: it has no sound files.",
            pack.info.name
        )));
    }
    let path = pack.files.get(event).ok_or_else(|| {
        SoundError::new(format!("{} has no sound for {event:?}.", pack.info.name))
    })?;
    // Belt and braces: the file must still live inside the pack folder.
    let (root, real) = (pack.root.canonicalize()?, path.canonicalize()?);
    if !real.starts_with(&root) {
        return Err(SoundError::new("That sound file is outside its pack."));
    }
    let kind = path
        .extension()
        .and_then(|x| x.to_str())
        .and_then(Kind::from_ext)
        .ok_or_else(|| SoundError::new("Unsupported sound file type."))?;
    data_url_of(&real, kind)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::fixtures;

    fn bundled() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../plugins/sounds")
    }

    #[test]
    fn the_bundled_tree_lists_eleven_packs_with_eight_events_each() {
        let data = tempfile::tempdir().unwrap();
        let packs = list_packs(Some(&bundled()), data.path());
        let ids: Vec<&str> = packs.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(packs.len(), 11, "{ids:?}");
        for want in [
            "patchtones",
            "telegraph",
            "nightshift",
            "modular",
            "lab-glass",
            "switchboard",
            "pocket-console",
            "pizzicato-hour",
            "island-time",
            "cartridge",
            "bridge-crew",
        ] {
            assert!(ids.contains(&want), "{want} missing from {ids:?}");
        }
        assert_eq!(
            packs
                .iter()
                .filter(|p| p.kind == PackKind::Generated)
                .count(),
            4
        );
        assert_eq!(packs[0].id, "patchtones", "the default comes first");
        for p in &packs {
            assert_eq!(p.events.len(), 8, "{}", p.id);
            assert!(!p.license.is_empty() && !p.author.is_empty(), "{}", p.id);
            match p.kind {
                PackKind::Generated => assert!(p.notes.is_some()),
                _ => assert!(p.notes.is_none() && p.license == "CC0-1.0"),
            }
        }
    }

    #[test]
    fn every_bundled_file_serves_and_has_a_real_duration() {
        let data = tempfile::tempdir().unwrap();
        let res = bundled();
        let mut n = 0;
        for p in list_packs(Some(&res), data.path())
            .iter()
            .filter(|p| p.kind == PackKind::Files)
        {
            for e in SOUND_EVENTS {
                let url = sound_file(Some(&res), data.path(), &p.id, e).unwrap();
                let b64 = url
                    .strip_prefix("data:audio/mp4;base64,")
                    .expect("an m4a data url");
                let bytes = B64.decode(b64).unwrap();
                let ms = crate::media::duration_ms(Kind::M4a, &bytes)
                    .unwrap_or_else(|err| panic!("{}/{e}: {err}", p.id));
                assert!(ms > 0 && ms <= 5_000, "{}/{}: {ms} ms", p.id, e);
                n += 1;
            }
        }
        assert_eq!(n, 56);
    }

    /// Checklist item 11: every shipped file is leveled. Decodes all of them.
    #[test]
    fn every_shipped_file_is_leveled_peak_at_most_minus_2_5_and_mean_between_32_and_20() {
        let data = tempfile::tempdir().unwrap();
        let res = bundled();
        let mut n = 0;
        let mut report = Vec::new();
        for p in list_packs(Some(&res), data.path())
            .iter()
            .filter(|p| p.kind == PackKind::Files)
        {
            for e in SOUND_EVENTS {
                let url = sound_file(Some(&res), data.path(), &p.id, e).unwrap();
                let b64 = url.strip_prefix("data:audio/mp4;base64,").unwrap();
                let bytes = B64.decode(b64).unwrap();
                let l = crate::loudness::measure(&bytes, "m4a")
                    .unwrap_or_else(|| panic!("{}/{e} did not decode", p.id));
                // The level the user hears: the file times the manifest's own `norm` (1 if none).
                let g_db = 20.0 * p.norm[e].log10();
                let (mean, peak) = (l.mean_db + g_db, l.peak_db + g_db);
                eprintln!("{}/{e}: mean {mean:.1} dBFS, peak {peak:.1} dBFS", p.id);
                if peak > -2.5 || !(-32.0..=-20.0).contains(&mean) || g_db < -1.0 {
                    report.push(format!("{}/{e}: mean {mean:.1}, peak {peak:.1}", p.id));
                }
                n += 1;
            }
        }
        assert_eq!(n, 56, "every shipped file was measured");
        assert!(report.is_empty(), "out of range: {report:#?}");
    }

    #[test]
    fn generated_packs_have_no_files_and_bad_requests_are_refused() {
        let data = tempfile::tempdir().unwrap();
        let res = bundled();
        let e = sound_file(Some(&res), data.path(), "patchtones", "done").unwrap_err();
        assert!(e.0.contains("generated"));
        assert!(sound_file(Some(&res), data.path(), "nope", "done").is_err());
        assert!(sound_file(Some(&res), data.path(), "../lab-glass", "done").is_err());
        assert!(sound_file(Some(&res), data.path(), "lab-glass", "../x").is_err());
        assert!(sound_file(None, data.path(), "lab-glass", "done").is_err());
    }

    #[test]
    fn manifests_cannot_point_outside_their_pack() {
        let tmp = tempfile::tempdir().unwrap();
        let res = tmp.path().join("res");
        let pack = res.join("evil");
        std::fs::create_dir_all(pack.join("sounds")).unwrap();
        std::fs::write(res.join("secret.wav"), fixtures::wav(100)).unwrap();
        std::fs::write(pack.join("sounds/ok.wav"), fixtures::wav(100)).unwrap();
        std::fs::write(
            pack.join("pack.json"),
            r#"{"id":"evil","name":"Evil","license":"x","author":"y",
              "sounds":{"needs":"../secret.wav","done":"/etc/passwd","bell":"sounds/ok.wav",
                        "error":"sounds/ok.txt"}}"#,
        )
        .unwrap();
        let data = tmp.path().join("data");
        let packs = list_packs(Some(&res), &data);
        assert_eq!(packs.len(), 1);
        assert_eq!(
            packs[0].events.keys().collect::<Vec<_>>(),
            vec![&"bell".to_owned()]
        );
    }

    #[test]
    fn a_missing_resource_dir_lists_only_imported_packs() {
        let data = tempfile::tempdir().unwrap();
        assert!(list_packs(None, data.path()).is_empty());
        assert!(list_packs(Some(Path::new("/nonexistent/sounds")), data.path()).is_empty());
    }
}
