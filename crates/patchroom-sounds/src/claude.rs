//! Read-only discovery and import of the user's Claude Code sound profiles.
//!
//! The layout this reads (`<config dir>` is `~/.claude`):
//!
//! ```text
//! <config dir>/sounds/play.sh            dispatcher: `play.sh session|tool|task|stop`
//! <config dir>/sounds/profile.txt        the chosen profile name
//! <config dir>/sounds/profiles/<id>.sh   SOUND_SESSION="/path/a.aiff"  SOUND_TOOL=...
//! ```
//!
//! A profile is a shell file of `SOUND_<EVENT>="<audio file>"` assignments. This module never
//! runs it: it reads the lines, expands only `~`, `$HOME` and `$SOUNDS_DIR`, and refuses any
//! value that still holds a shell construct. It never writes under the config dir. Importing
//! copies the audio files into `<data dir>/sounds/packs/claude-<id>/`.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};

use patchroom_prefs::valid_sound_id;
use serde::Serialize;

use crate::custom::{check_file, make_private_dir, write_private};
use crate::media::Kind;
use crate::packs::IMPORTED_DIR;
use crate::{Result, SoundError, SOUNDS_DIR};

/// Largest profile file read, in bytes.
const MAX_PROFILE_BYTES: u64 = 64 * 1024;

/// Most profiles listed.
const MAX_PROFILES: usize = 64;

/// How a profile variable maps to Patchroom events. `tool` is a short tick, so it becomes
/// `message`; `task` becomes `bell`; `stop` (Claude finished and waits for you) covers both
/// `done` and `needs`.
const MAP: [(&str, &[&str]); 4] = [
    ("SOUND_SESSION", &["session"]),
    ("SOUND_TOOL", &["message"]),
    ("SOUND_TASK", &["bell"]),
    ("SOUND_STOP", &["done", "needs"]),
];

/// One profile, as `sound_claude_profiles` returns it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ClaudeProfile {
    /// Profile file stem, for example `retro`.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Patchroom events the profile has a usable sound for.
    pub events: BTreeMap<String, bool>,
}

fn profiles_dir(config_dir: &Path) -> PathBuf {
    config_dir.join("sounds").join("profiles")
}

fn read_capped(path: &Path) -> Option<String> {
    let f = std::fs::File::open(path).ok()?;
    let mut s = String::new();
    f.take(MAX_PROFILE_BYTES).read_to_string(&mut s).ok()?;
    Some(s)
}

fn expand(value: &str, home: &Path, sounds_dir: &Path) -> Option<PathBuf> {
    let v = value.trim();
    let h = home.to_str()?;
    let s = sounds_dir.to_str()?;
    let out = if let Some(rest) = v.strip_prefix("~/") {
        format!("{h}/{rest}")
    } else {
        v.replace("${HOME}", h)
            .replace("$HOME", h)
            .replace("${SOUNDS_DIR}", s)
            .replace("$SOUNDS_DIR", s)
    };
    // Anything left over is a shell construct this reader does not evaluate.
    if out.is_empty() || out.contains(['$', '`', '\\', '*', '?', '\n']) || !out.starts_with('/') {
        return None;
    }
    Some(PathBuf::from(out))
}

fn unquote(v: &str) -> &str {
    let v = v.trim();
    for q in ['"', '\''] {
        if let Some(inner) = v.strip_prefix(q).and_then(|r| r.strip_suffix(q)) {
            return inner;
        }
    }
    v
}

/// The audio file each Patchroom event gets from one profile, after the files are checked.
fn resolve(config_dir: &Path, home: &Path, id: &str) -> BTreeMap<String, PathBuf> {
    let mut out = BTreeMap::new();
    if !valid_sound_id(id) {
        return out;
    }
    let sounds = config_dir.join("sounds");
    let Some(text) = read_capped(&profiles_dir(config_dir).join(format!("{id}.sh"))) else {
        return out;
    };
    for line in text.lines() {
        let line = line.trim();
        let line = line.strip_prefix("export ").unwrap_or(line).trim();
        if line.starts_with('#') {
            continue;
        }
        let Some((var, value)) = line.split_once('=') else {
            continue;
        };
        let Some((_, events)) = MAP.iter().find(|(v, _)| *v == var.trim()) else {
            continue;
        };
        let Some(path) = expand(unquote(value), home, &sounds) else {
            continue;
        };
        let audio = path
            .extension()
            .and_then(|x| x.to_str())
            .and_then(Kind::from_ext)
            .is_some();
        if !audio || !path.is_file() {
            continue;
        }
        for e in *events {
            out.insert((*e).to_owned(), path.clone());
        }
    }
    out
}

fn title(id: &str) -> String {
    let mut c = id.chars();
    c.next().map_or_else(String::new, |f| {
        f.to_uppercase().chain(c).collect::<String>()
    })
}

/// `sound_claude_profiles`: the profiles under `<config dir>/sounds/profiles` that have at
/// least one usable sound. Read only.
#[must_use]
pub fn discover(config_dir: &Path, home: &Path) -> Vec<ClaudeProfile> {
    let mut ids: Vec<String> = std::fs::read_dir(profiles_dir(config_dir))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            (p.extension()? == "sh").then(|| p.file_stem()?.to_str().map(str::to_owned))?
        })
        .filter(|id| valid_sound_id(id))
        .collect();
    ids.sort();
    ids.truncate(MAX_PROFILES);
    ids.into_iter()
        .filter_map(|id| {
            let found = resolve(config_dir, home, &id);
            (!found.is_empty()).then(|| ClaudeProfile {
                name: format!("Claude {}", title(&id)),
                events: found.keys().map(|e| (e.clone(), true)).collect(),
                id,
            })
        })
        .collect()
}

/// `sound_import_claude_profile {id}`: copy the profile's usable sounds into an imported
/// pack and return its id. Files that break the custom sound limits are skipped. Importing
/// again replaces the pack.
///
/// # Errors
/// No such profile, or none of its sounds can be imported.
pub fn import_profile(config_dir: &Path, home: &Path, data_dir: &Path, id: &str) -> Result<String> {
    let found = resolve(config_dir, home, id);
    if found.is_empty() {
        return Err(SoundError::new(format!(
            "No Claude sound profile named {id:?} with usable sounds."
        )));
    }
    let pack_id = format!("claude-{id}");
    let root = data_dir.join(SOUNDS_DIR).join(IMPORTED_DIR).join(&pack_id);
    let staging = root.with_extension("new");
    let _ = std::fs::remove_dir_all(&staging);
    make_private_dir(&staging)?;
    let result = (|| {
        let mut sounds = serde_json::Map::new();
        let mut skipped = Vec::new();
        for (event, src) in &found {
            match check_file(src) {
                Ok((kind, bytes, _)) => {
                    let name = format!("{event}.{}", kind.ext());
                    write_private(&staging.join(&name), &bytes)?;
                    sounds.insert(event.clone(), serde_json::Value::String(name));
                }
                Err(e) => skipped.push(format!("{event}: {e}")),
            }
        }
        if sounds.is_empty() {
            return Err(SoundError::new(format!(
                "None of the sounds in that profile can be imported. {}",
                skipped.join(" ")
            )));
        }
        let manifest = serde_json::json!({
            "id": pack_id,
            "name": format!("Claude {}", title(id)),
            "description": "Your Claude Code sound profile, copied into Patchroom.",
            "kind": "imported",
            "license": "Your own files",
            "author": "You",
            "source": format!("Imported from your Claude sound profile \"{id}\""),
            "sounds": sounds,
        });
        let bytes =
            serde_json::to_vec_pretty(&manifest).map_err(|e| SoundError::new(e.to_string()))?;
        write_private(&staging.join("pack.json"), &bytes)
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e);
    }
    let _ = std::fs::remove_dir_all(&root);
    std::fs::rename(&staging, &root)?;
    Ok(pack_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::fixtures;
    use crate::packs::list_packs;

    /// A synthetic copy of the real layout: `sounds/{play.sh,profile.txt,profiles/*.sh}` and
    /// audio files the profiles point at (some through `$HOME`).
    fn fixture(root: &Path) -> (PathBuf, PathBuf) {
        let home = root.join("home");
        let cfg = home.join(".claude");
        let sounds = cfg.join("sounds");
        std::fs::create_dir_all(sounds.join("profiles")).unwrap();
        std::fs::create_dir_all(home.join("audio")).unwrap();
        std::fs::write(sounds.join("play.sh"), "#!/bin/bash\nEVENT=\"$1\"\n").unwrap();
        std::fs::write(sounds.join("profile.txt"), "retro\n").unwrap();
        std::fs::write(sounds.join("volume.txt"), "1.0\n").unwrap();
        let a = |n: &str, bytes: Vec<u8>| {
            std::fs::write(home.join("audio").join(n), bytes).unwrap();
        };
        a("start.wav", fixtures::wav(400));
        a("tick.aiff", fixtures::aiff(200));
        a("done.wav", fixtures::wav(600));
        a("long.wav", fixtures::wav(9_000));
        let p = |n: &str, body: String| {
            std::fs::write(sounds.join("profiles").join(format!("{n}.sh")), body).unwrap();
        };
        let abs = home.join("audio");
        p(
            "retro",
            format!(
                "SOUND_SESSION=\"{0}/start.wav\"\nSOUND_TOOL=\"$HOME/audio/tick.aiff\"\n\
                 SOUND_TASK='${{HOME}}/audio/done.wav'\nSOUND_STOP=\"~/audio/done.wav\"\n",
                abs.display()
            ),
        );
        p(
            "partial",
            "# comment\nexport SOUND_STOP=\"$HOME/audio/done.wav\"\nSOUND_TOOL=\"\"\n\
             SOUND_SESSION=\"/does/not/exist.wav\"\n"
                .into(),
        );
        p("silent", "SOUND_SESSION=\"\"\nSOUND_TOOL=\"\"\n".into());
        p(
            "evil",
            "SOUND_SESSION=\"$(touch /tmp/pwned).wav\"\nSOUND_STOP=\"`id`\"\n\
             SOUND_TASK=\"$HOME/../../etc/*\"\nSOUND_TOOL=\"relative.wav\"\n"
                .into(),
        );
        p(
            "toolong",
            "SOUND_STOP=\"$HOME/audio/long.wav\"\nSOUND_TASK=\"$HOME/audio/done.wav\"\n".into(),
        );
        (home, cfg)
    }

    /// Hash of every file path and byte under `dir`, to prove a read-only walk.
    fn snapshot(dir: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        fn walk(d: &Path, out: &mut Vec<(PathBuf, Vec<u8>)>) {
            let mut entries: Vec<_> = std::fs::read_dir(d).unwrap().flatten().collect();
            entries.sort_by_key(std::fs::DirEntry::path);
            for e in entries {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, out);
                } else {
                    out.push((p.clone(), std::fs::read(&p).unwrap()));
                }
            }
        }
        let mut out = Vec::new();
        walk(dir, &mut out);
        out
    }

    #[test]
    fn discovery_lists_profiles_with_usable_sounds_and_changes_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let (home, cfg) = fixture(tmp.path());
        let before = snapshot(&home);
        let found = discover(&cfg, &home);
        let ids: Vec<&str> = found.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["partial", "retro", "toolong"],
            "silent and evil have none"
        );
        let retro = found.iter().find(|p| p.id == "retro").unwrap();
        assert_eq!(retro.name, "Claude Retro");
        let ev: Vec<&str> = retro.events.keys().map(String::as_str).collect();
        assert_eq!(ev, vec!["bell", "done", "message", "needs", "session"]);
        let partial = found.iter().find(|p| p.id == "partial").unwrap();
        assert_eq!(
            partial
                .events
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            vec!["done", "needs"]
        );
        assert_eq!(snapshot(&home), before, "discovery is read only");
    }

    #[test]
    fn a_missing_sounds_folder_finds_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(discover(&tmp.path().join(".claude"), tmp.path()).is_empty());
    }

    #[test]
    fn import_copies_the_files_into_an_imported_pack_and_never_writes_the_config_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let (home, cfg) = fixture(tmp.path());
        let data = tmp.path().join("data");
        let before = snapshot(&home);
        let pack_id = import_profile(&cfg, &home, &data, "retro").unwrap();
        assert_eq!(pack_id, "claude-retro");
        assert_eq!(
            snapshot(&home),
            before,
            "nothing under the config dir changed"
        );
        let packs = list_packs(None, &data);
        assert_eq!(packs.len(), 1);
        let p = &packs[0];
        assert_eq!(p.id, "claude-retro");
        assert_eq!(p.kind, crate::packs::PackKind::Imported);
        assert_eq!(p.events.len(), 5);
        assert_eq!(p.author, "You");
        let url = crate::packs::sound_file(None, &data, "claude-retro", "message").unwrap();
        assert!(url.starts_with("data:audio/aiff;base64,"));
        let url = crate::packs::sound_file(None, &data, "claude-retro", "session").unwrap();
        assert!(url.starts_with("data:audio/wav;base64,"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let f = data.join("sounds/packs/claude-retro/session.wav");
            assert_eq!(
                std::fs::metadata(f).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        // Importing again replaces the pack without error.
        import_profile(&cfg, &home, &data, "retro").unwrap();
        assert_eq!(list_packs(None, &data).len(), 1);
    }

    #[test]
    fn files_over_the_limits_are_skipped_and_an_unusable_profile_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let (home, cfg) = fixture(tmp.path());
        let data = tmp.path().join("data");
        import_profile(&cfg, &home, &data, "toolong").unwrap();
        let p = &list_packs(None, &data)[0];
        assert_eq!(p.events.keys().collect::<Vec<_>>(), vec!["bell"]);
        for id in ["silent", "evil", "missing", "../retro", "a/b"] {
            assert!(import_profile(&cfg, &home, &data, id).is_err(), "{id}");
        }
        assert!(!data.join("sounds/packs/claude-evil").exists());
        assert!(!data.join("sounds/packs/claude-evil.new").exists());
    }

    #[test]
    fn a_profile_cannot_smuggle_a_non_audio_file() {
        let tmp = tempfile::tempdir().unwrap();
        let (home, cfg) = fixture(tmp.path());
        std::fs::write(home.join("secret.txt"), "top secret").unwrap();
        std::fs::write(home.join("fake.wav"), "top secret").unwrap();
        std::fs::write(
            cfg.join("sounds/profiles/sneaky.sh"),
            "SOUND_STOP=\"$HOME/secret.txt\"\nSOUND_SESSION=\"$HOME/fake.wav\"\n",
        )
        .unwrap();
        let data = tmp.path().join("data");
        assert!(import_profile(&cfg, &home, &data, "sneaky").is_err());
        assert!(list_packs(None, &data).is_empty());
    }
}
