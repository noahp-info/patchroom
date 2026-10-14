//! The user's own sound files.
//!
//! `import_file` checks the type, the size and the duration, then copies the file to
//! `<data dir>/sounds/<ULID>.<ext>` with mode 0600, next to a `<ULID>.json` sidecar that holds
//! the display name and duration. The source file is only read. Nothing leaves the machine.

use std::collections::HashSet;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use ulid::Ulid;

use crate::media::{self, Kind, ACCEPTED, MAX_BYTES, MAX_DURATION_MS};
use crate::packs::data_url_of;
use crate::{Result, SoundError, SOUNDS_DIR};

/// Longest display name kept.
const MAX_NAME_CHARS: usize = 60;

/// One custom sound, as `sound_import_file` and `sound_custom_list` return it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomSound {
    /// ULID; also the file stem.
    pub id: String,
    /// Display name (the source file's name without its extension).
    pub name: String,
    /// Length, from the file header.
    pub duration_ms: u64,
}

fn sounds_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(SOUNDS_DIR)
}

/// Create `dir` (and parents) private to the user.
pub(crate) fn make_private_dir(dir: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)?;
    }
    #[cfg(not(unix))]
    std::fs::create_dir_all(dir)?;
    Ok(())
}

/// Write a new file readable only by the user. Fails if it exists.
pub(crate) fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(path)?;
    if let Err(e) = f.write_all(bytes).and_then(|()| f.flush()) {
        drop(f);
        let _ = std::fs::remove_file(path);
        return Err(e.into());
    }
    Ok(())
}

fn fmt_mb(bytes: u64) -> String {
    #[allow(clippy::cast_precision_loss)]
    let mb = bytes as f64 / (1024.0 * 1024.0);
    format!("{mb:.1} MB")
}

fn fmt_s(ms: u64) -> String {
    #[allow(clippy::cast_precision_loss)]
    let s = ms as f64 / 1000.0;
    format!("{s:.1} s")
}

/// Read `path` and check it against the limits, without writing anything.
///
/// Returns the kind, the bytes and the duration.
pub(crate) fn check_file(path: &Path) -> Result<(Kind, Vec<u8>, u64)> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let kind = Kind::from_ext(ext).ok_or_else(|| {
        SoundError::new(format!(
            "Only {ACCEPTED} files are accepted. That file is {}.",
            if ext.is_empty() {
                "missing an extension".to_owned()
            } else {
                format!(".{}", ext.to_ascii_lowercase())
            }
        ))
    })?;
    let file = std::fs::File::open(path)
        .map_err(|e| SoundError::new(format!("Could not open that file: {e}.")))?;
    let meta = file.metadata()?;
    if !meta.is_file() {
        return Err(SoundError::new("That is not a file."));
    }
    let too_big = || {
        SoundError::new(format!(
            "That file is over the {} size limit.",
            fmt_mb(MAX_BYTES)
        ))
    };
    if meta.len() > MAX_BYTES {
        return Err(SoundError::new(format!(
            "That file is {}. The limit is {}.",
            fmt_mb(meta.len()),
            fmt_mb(MAX_BYTES).replace(".0 MB", " MB")
        )));
    }
    // Read one byte past the limit, so a file that grows after the check is still refused.
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(too_big());
    }
    let ms = media::duration_ms(kind, &bytes)?;
    if ms > MAX_DURATION_MS {
        return Err(SoundError::new(format!(
            "That sound is {} long. The limit is {} s.",
            fmt_s(ms),
            MAX_DURATION_MS / 1000
        )));
    }
    Ok((kind, bytes, ms))
}

fn display_name(path: &Path) -> String {
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    let clean: String = stem
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_NAME_CHARS)
        .collect();
    let clean = clean.trim();
    if clean.is_empty() {
        "Custom sound".to_owned()
    } else {
        clean.to_owned()
    }
}

/// `sound_import_file {path}`: check and copy a sound file into the data dir.
///
/// # Errors
/// A type, size or duration limit (the message names it), or an unreadable file.
pub fn import_file(data_dir: &Path, path: &Path) -> Result<CustomSound> {
    let (kind, bytes, ms) = check_file(path)?;
    let dir = sounds_dir(data_dir);
    make_private_dir(&dir)?;
    let id = Ulid::generate().to_string();
    let file = dir.join(format!("{id}.{}", kind.ext()));
    write_private(&file, &bytes)?;
    let sound = CustomSound {
        id: id.clone(),
        name: display_name(path),
        duration_ms: ms,
    };
    let meta = serde_json::to_vec(&sound).map_err(|e| SoundError::new(e.to_string()))?;
    if let Err(e) = write_private(&dir.join(format!("{id}.json")), &meta) {
        let _ = std::fs::remove_file(&file);
        return Err(e);
    }
    Ok(sound)
}

/// The stored audio file of custom sound `id`.
fn audio_path(data_dir: &Path, id: &str) -> Result<(PathBuf, Kind)> {
    Ulid::from_string(id).map_err(|_| SoundError::new("Unknown custom sound."))?;
    let dir = sounds_dir(data_dir);
    for ext in ["wav", "aiff", "mp3", "m4a"] {
        let p = dir.join(format!("{id}.{ext}"));
        if p.is_file() {
            if let Some(kind) = Kind::from_ext(ext) {
                return Ok((p, kind));
            }
        }
    }
    Err(SoundError::new("That custom sound no longer exists."))
}

/// A custom sound as a data URL.
///
/// # Errors
/// An unknown id or an unreadable file.
pub fn custom_file(data_dir: &Path, id: &str) -> Result<String> {
    let (path, kind) = audio_path(data_dir, id)?;
    data_url_of(&path, kind)
}

/// Every stored custom sound, newest first.
#[must_use]
pub fn list_custom(data_dir: &Path) -> Vec<CustomSound> {
    let mut out: Vec<CustomSound> = std::fs::read_dir(sounds_dir(data_dir))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            if p.extension()? != "json" {
                return None;
            }
            let id = p.file_stem()?.to_str()?;
            Ulid::from_string(id).ok()?;
            let s: CustomSound = serde_json::from_slice(&std::fs::read(&p).ok()?).ok()?;
            (s.id == id && audio_path(data_dir, id).is_ok()).then_some(s)
        })
        .collect();
    out.sort_by(|a, b| b.id.cmp(&a.id));
    out
}

/// `sound_custom_remove {id}`: delete the file and its sidecar. A missing sound is fine.
///
/// # Errors
/// The id is not a ULID, or a file could not be deleted.
pub fn remove_custom(data_dir: &Path, id: &str) -> Result<()> {
    Ulid::from_string(id).map_err(|_| SoundError::new("Unknown custom sound."))?;
    let dir = sounds_dir(data_dir);
    for ext in ["wav", "aiff", "mp3", "m4a", "json"] {
        match std::fs::remove_file(dir.join(format!("{id}.{ext}"))) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}

/// Delete every custom sound whose id is not in `keep`. Files that are not
/// `<ULID>.<ext>` or `<ULID>.json` are left alone. Returns how many sounds were deleted.
pub fn prune_custom(data_dir: &Path, keep: &HashSet<String>) -> usize {
    let mut doomed: HashSet<String> = HashSet::new();
    for e in std::fs::read_dir(sounds_dir(data_dir))
        .into_iter()
        .flatten()
        .flatten()
    {
        let p = e.path();
        if !p.is_file() {
            continue;
        }
        let (Some(stem), Some(ext)) = (
            p.file_stem().and_then(|s| s.to_str()),
            p.extension().and_then(|s| s.to_str()),
        ) else {
            continue;
        };
        if Ulid::from_string(stem).is_ok()
            && (ext == "json" || Kind::from_ext(ext).is_some())
            && !keep.contains(stem)
        {
            doomed.insert(stem.to_owned());
        }
    }
    let n = doomed.len();
    for id in doomed {
        let _ = remove_custom(data_dir, &id);
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::fixtures;

    fn put(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, bytes).unwrap();
        p
    }

    #[test]
    fn each_accepted_type_imports_and_lists() {
        let src = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let cases: [(&str, Vec<u8>); 5] = [
            ("ding.wav", fixtures::wav(900)),
            ("tone.AIFF", fixtures::aiff(900)),
            ("song.mp3", fixtures::mp3(30, true)),
            ("clip.m4a", fixtures::m4a(900)),
            ("legacy.aif", fixtures::aiff(900)),
        ];
        for (name, bytes) in &cases {
            let s = import_file(data.path(), &put(src.path(), name, bytes)).unwrap();
            assert!(s.duration_ms > 0 && s.duration_ms <= 5000, "{name}");
            assert_eq!(Ulid::from_string(&s.id).unwrap().to_string(), s.id);
            assert_eq!(s.name, name.rsplit_once('.').unwrap().0);
            let url = custom_file(data.path(), &s.id).unwrap();
            assert!(url.starts_with("data:audio/"), "{url:.30}");
        }
        assert_eq!(list_custom(data.path()).len(), 5);
    }

    #[test]
    fn the_copy_lives_in_the_data_dir_as_ulid_ext_with_mode_0600() {
        let src = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let from = put(src.path(), "My Chime.wav", &fixtures::wav(500));
        let s = import_file(data.path(), &from).unwrap();
        let stored = data.path().join("sounds").join(format!("{}.wav", s.id));
        assert_eq!(
            std::fs::read(&stored).unwrap(),
            std::fs::read(&from).unwrap()
        );
        assert_eq!(s.name, "My Chime");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&stored), 0o600);
            assert_eq!(mode(&data.path().join("sounds")), 0o700);
            assert_eq!(
                mode(&data.path().join("sounds").join(format!("{}.json", s.id))),
                0o600
            );
        }
        assert!(from.exists(), "the source is only read");
    }

    #[test]
    fn a_file_over_5_seconds_is_refused_and_the_message_names_the_limit() {
        let src = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let long = put(src.path(), "long.wav", &fixtures::wav(5_400));
        let e = import_file(data.path(), &long).unwrap_err();
        assert!(e.0.contains("limit is 5 s"), "{e}");
        let ok = put(src.path(), "edge.wav", &fixtures::wav(5_000));
        assert!(
            import_file(data.path(), &ok).is_ok(),
            "exactly 5 s is allowed"
        );
        assert_eq!(
            list_custom(data.path()).len(),
            1,
            "nothing stored for the refusal"
        );
    }

    #[test]
    fn a_file_over_2_mb_is_refused_and_the_message_names_the_limit() {
        let src = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        // A short, valid wav padded with trailing bytes past 2 MiB.
        let mut big = fixtures::wav(1_000);
        big.extend(std::iter::repeat_n(0u8, 2 * 1024 * 1024));
        let p = put(src.path(), "big.wav", &big);
        let e = import_file(data.path(), &p).unwrap_err();
        assert!(e.0.contains("limit is 2 MB"), "{e}");
        let exact = 2 * 1024 * 1024;
        let mut at = fixtures::wav(1_000);
        at.resize(exact, 0);
        assert!(import_file(data.path(), &put(src.path(), "at.wav", &at)).is_ok());
        assert!(!data.path().join("sounds").join("x").exists());
    }

    #[test]
    fn other_types_and_impostors_are_refused() {
        let src = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        for name in ["a.ogg", "a.flac", "a.txt", "a", "a.wav.exe"] {
            let p = put(src.path(), name, &fixtures::wav(100));
            let e = import_file(data.path(), &p).unwrap_err();
            assert!(e.0.contains("wav, aiff, mp3, m4a"), "{name}: {e}");
        }
        // The extension says wav; the bytes say otherwise.
        let fake = put(src.path(), "fake.wav", b"MZ this is not audio at all");
        assert!(import_file(data.path(), &fake).is_err());
        let fake = put(src.path(), "fake.m4a", &fixtures::mp3(10, false));
        assert!(import_file(data.path(), &fake).is_err());
        assert!(import_file(data.path(), &src.path().join("missing.wav")).is_err());
        assert!(import_file(data.path(), src.path()).is_err(), "a directory");
        assert!(list_custom(data.path()).is_empty());
        assert!(!data.path().join("sounds").exists() || list_custom(data.path()).is_empty());
    }

    #[test]
    fn remove_deletes_the_file_and_rejects_non_ulids() {
        let src = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let s = import_file(data.path(), &put(src.path(), "a.wav", &fixtures::wav(200))).unwrap();
        remove_custom(data.path(), &s.id).unwrap();
        assert!(list_custom(data.path()).is_empty());
        assert!(custom_file(data.path(), &s.id).is_err());
        remove_custom(data.path(), &s.id).unwrap();
        assert!(remove_custom(data.path(), "../../etc/passwd").is_err());
        assert!(custom_file(data.path(), "../x").is_err());
    }

    #[test]
    fn pruning_keeps_referenced_sounds_and_foreign_files() {
        let src = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let a = import_file(data.path(), &put(src.path(), "a.wav", &fixtures::wav(200))).unwrap();
        let b = import_file(
            data.path(),
            &put(src.path(), "b.mp3", &fixtures::mp3(8, false)),
        )
        .unwrap();
        let c = import_file(data.path(), &put(src.path(), "c.m4a", &fixtures::m4a(200))).unwrap();
        let dir = data.path().join("sounds");
        std::fs::write(dir.join("notes.txt"), "mine").unwrap();
        std::fs::create_dir_all(dir.join("packs/claude-retro")).unwrap();
        std::fs::write(dir.join("packs/claude-retro/pack.json"), "{}").unwrap();
        let keep: HashSet<String> = [a.id.clone()].into();
        assert_eq!(prune_custom(data.path(), &keep), 2);
        let left: Vec<String> = list_custom(data.path()).into_iter().map(|s| s.id).collect();
        assert_eq!(left, vec![a.id.clone()]);
        assert!(!dir.join(format!("{}.mp3", b.id)).exists());
        assert!(!dir.join(format!("{}.json", c.id)).exists());
        assert!(dir.join("notes.txt").exists());
        assert!(
            dir.join("packs/claude-retro/pack.json").exists(),
            "imported packs stay"
        );
        assert_eq!(prune_custom(data.path(), &keep), 0);
        assert_eq!(prune_custom(&data.path().join("nowhere"), &keep), 0);
    }
}
