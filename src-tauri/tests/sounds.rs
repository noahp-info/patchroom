//! Sound pack backend integration tests: the registry through the manager, custom files,
//! pruning at start-up, Claude profile import, and prefs back-compat. Real manager and SQLite
//! file; the Claude config dir is always a synthetic temp tree, never `~/.claude`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use patchroom_lib::events::{EventSink, UiEvent};
use patchroom_lib::manager::{Manager, ManagerConfig, SessionManager};
use serde_json::{json, Value};

struct NullSink;

impl EventSink for NullSink {
    fn emit(&self, _event: UiEvent) {}
}

fn hook_bin() -> PathBuf {
    static COPY: OnceLock<(tempfile::TempDir, PathBuf)> = OnceLock::new();
    COPY.get_or_init(|| {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
        let staged = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.path())
            .find(|p| {
                p.file_name()
                    .is_some_and(|n| n.to_string_lossy().starts_with("patchroom-hook-"))
            })
            .expect("build.rs stages binaries/patchroom-hook-<triple>");
        let tmp = tempfile::tempdir().unwrap();
        let copy = tmp.path().join("patchroom-hook");
        std::fs::copy(staged, &copy).unwrap();
        (tmp, copy)
    })
    .1
    .clone()
}

fn bundled() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/sounds")
}

struct Env {
    data: tempfile::TempDir,
    /// `<home>/.claude`
    config: PathBuf,
    home: tempfile::TempDir,
    m: SessionManager,
}

fn open(data: &Path, config: &Path) -> SessionManager {
    // `<home>/.claude`: the profiles' `$HOME` is the config dir's parent.
    let home = config.parent().unwrap();
    let mut cfg = ManagerConfig::new(data, hook_bin());
    cfg.shell = Some("/bin/sh".into());
    cfg.kill_grace = Duration::from_millis(300);
    cfg.claude_config_dir = Some(config.to_path_buf());
    cfg.sounds_dir = Some(bundled());
    cfg.home_dir = Some(home.to_path_buf());
    Manager::new(cfg, Arc::new(NullSink) as Arc<dyn EventSink>).unwrap()
}

fn env() -> Env {
    let data = tempfile::Builder::new()
        .prefix("pr")
        .tempdir_in("/tmp")
        .unwrap();
    let home = tempfile::tempdir().unwrap();
    let config = home.path().join(".claude");
    std::fs::create_dir_all(&config).unwrap();
    let m = open(data.path(), &config);
    Env {
        data,
        config,
        home,
        m,
    }
}

/// A minimal valid 8 kHz mono wav of `ms` milliseconds.
fn wav(ms: u32) -> Vec<u8> {
    let n = 8 * ms;
    let mut v = Vec::new();
    v.extend(b"RIFF");
    v.extend((36 + n * 2).to_le_bytes());
    v.extend(b"WAVEfmt ");
    v.extend(16u32.to_le_bytes());
    v.extend(1u16.to_le_bytes());
    v.extend(1u16.to_le_bytes());
    v.extend(8000u32.to_le_bytes());
    v.extend(16000u32.to_le_bytes());
    v.extend(2u16.to_le_bytes());
    v.extend(16u16.to_le_bytes());
    v.extend(b"data");
    v.extend((n * 2).to_le_bytes());
    v.extend(vec![0u8; (n * 2) as usize]);
    v
}

fn write(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    std::fs::create_dir_all(dir).unwrap();
    let p = dir.join(name);
    std::fs::write(&p, bytes).unwrap();
    p
}

#[test]
fn sound_packs_lists_all_eleven_bundled_packs() {
    let e = env();
    let packs = e.m.sound_packs();
    assert_eq!(packs.len(), 11);
    let v = serde_json::to_value(&packs).unwrap();
    let first = &v[0];
    assert_eq!(first["id"], "patchtones");
    assert_eq!(first["kind"], "generated");
    assert!(first["notes"]["needs"].is_array());
    for key in [
        "id",
        "name",
        "description",
        "kind",
        "license",
        "author",
        "events",
    ] {
        assert!(first.get(key).is_some(), "{key}");
    }
    let lab = v
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == "lab-glass")
        .unwrap();
    assert_eq!(lab["kind"], "files");
    assert_eq!(lab["events"].as_object().unwrap().len(), 8);
}

#[test]
fn sound_file_returns_a_data_url_for_file_packs_only() {
    let e = env();
    let f = e.m.sound_file("lab-glass", "done").unwrap();
    assert!(f.data_url.starts_with("data:audio/mp4;base64,"));
    assert_eq!(
        serde_json::to_value(&f)
            .unwrap()
            .as_object()
            .unwrap()
            .keys()
            .collect::<Vec<_>>(),
        vec!["dataUrl"]
    );
    assert!(e.m.sound_file("patchtones", "done").is_err());
    assert!(e.m.sound_file("lab-glass", "nope").is_err());
}

#[test]
fn import_limits_reach_the_user_with_the_limit_named() {
    let e = env();
    let src = e.home.path().join("src");
    let long = write(&src, "long.wav", &wav(6_000));
    let msg =
        e.m.sound_import_file(&long.to_string_lossy())
            .unwrap_err()
            .to_string();
    assert!(msg.contains("limit is 5 s"), "{msg}");
    let mut big = wav(1_000);
    big.resize(3 * 1024 * 1024, 0);
    let big = write(&src, "big.wav", &big);
    let msg =
        e.m.sound_import_file(&big.to_string_lossy())
            .unwrap_err()
            .to_string();
    assert!(msg.contains("limit is 2 MB"), "{msg}");
    let ogg = write(&src, "a.ogg", &wav(100));
    let msg =
        e.m.sound_import_file(&ogg.to_string_lossy())
            .unwrap_err()
            .to_string();
    assert!(msg.contains("wav, aiff, mp3, m4a"), "{msg}");
    assert!(e.m.sound_custom_list().is_empty());
}

#[test]
fn a_custom_sound_imports_plays_and_is_removed_with_prefs_falling_back() {
    let e = env();
    let src = write(&e.home.path().join("src"), "Ding.wav", &wav(800));
    let s = e.m.sound_import_file(&src.to_string_lossy()).unwrap();
    assert_eq!(s.name, "Ding");
    assert_eq!(s.duration_ms, 800);
    let stored = e.data.path().join("sounds").join(format!("{}.wav", s.id));
    assert!(stored.is_file());
    assert!(e
        .m
        .sound_custom_file(&s.id)
        .unwrap()
        .data_url
        .starts_with("data:audio/wav;base64,"));
    e.m.prefs_set(&json!({"sound": {"mix": {"done": {"custom": s.id}},
        "perDm": {"dm1": {"mix": {"needs": {"custom": s.id}}}}}}))
        .unwrap();
    assert_eq!(e.m.prefs_get().custom_sound_ids().len(), 1);
    e.m.sound_custom_remove(&s.id).unwrap();
    assert!(!stored.exists());
    assert!(e.m.sound_custom_file(&s.id).is_err());
    let p = serde_json::to_value(e.m.prefs_get()).unwrap();
    assert_eq!(p["sound"]["mix"]["done"], json!({"pack": "patchtones"}));
    assert_eq!(
        p["sound"]["perDm"]["dm1"]["mix"]["needs"],
        json!({"pack": "patchtones"})
    );
}

#[test]
fn start_up_prunes_custom_sounds_that_no_prefs_reference() {
    let e = env();
    let src = e.home.path().join("src");
    let keep =
        e.m.sound_import_file(&write(&src, "keep.wav", &wav(300)).to_string_lossy())
            .unwrap();
    let lose =
        e.m.sound_import_file(&write(&src, "lose.wav", &wav(300)).to_string_lossy())
            .unwrap();
    e.m.prefs_set(&json!({"sound": {"mix": {"bell": {"custom": keep.id}}}}))
        .unwrap();
    let Env {
        data,
        config,
        home,
        m,
    } = e;
    m.shutdown();
    drop(m);
    let m2 = open(data.path(), &config);
    let left: Vec<String> = m2.sound_custom_list().into_iter().map(|s| s.id).collect();
    assert_eq!(left, vec![keep.id.clone()]);
    assert!(!data
        .path()
        .join("sounds")
        .join(format!("{}.wav", lose.id))
        .exists());
    drop(home);
}

#[test]
fn a_damaged_prefs_setting_never_costs_the_users_files() {
    let e = env();
    let src = e.home.path().join("src");
    let s =
        e.m.sound_import_file(&write(&src, "a.wav", &wav(300)).to_string_lossy())
            .unwrap();
    e.m.prefs_set(&json!({"sound": {"mix": {"bell": {"custom": s.id}}}}))
        .unwrap();
    let Env {
        data,
        config,
        home,
        m,
    } = e;
    m.shutdown();
    drop(m);
    // Damage the stored setting on disk.
    let db = data.path().join("patchroom.db");
    assert!(sqlite(
        &db,
        "UPDATE setting SET value = 'not json' WHERE key = 'prefs';"
    ));
    assert_eq!(
        sqlite_out(&db, "SELECT value FROM setting WHERE key = 'prefs';"),
        "not json"
    );
    let m2 = open(data.path(), &config);
    assert_eq!(
        m2.sound_custom_list().len(),
        1,
        "nothing is pruned from unreadable prefs"
    );
    drop(home);
}

/// Run SQL through the `sqlite3` CLI that ships with macOS.
fn sqlite(db: &Path, sql: &str) -> bool {
    std::process::Command::new("sqlite3")
        .arg(db)
        .arg(sql)
        .status()
        .is_ok_and(|s| s.success())
}

fn sqlite_out(db: &Path, sql: &str) -> String {
    let out = std::process::Command::new("sqlite3")
        .arg(db)
        .arg(sql)
        .output()
        .unwrap();
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}

/// A synthetic copy of the real `~/.claude/sounds` layout.
fn claude_fixture(home: &Path, config: &Path) {
    let sounds = config.join("sounds");
    std::fs::create_dir_all(sounds.join("profiles")).unwrap();
    std::fs::write(sounds.join("play.sh"), "#!/bin/bash\nEVENT=\"$1\"\n").unwrap();
    std::fs::write(sounds.join("profile.txt"), "retro\n").unwrap();
    std::fs::write(sounds.join("volume.txt"), "1.0\n").unwrap();
    let audio = home.join("audio");
    write(&audio, "start.wav", &wav(400));
    write(&audio, "stop.wav", &wav(700));
    std::fs::write(
        sounds.join("profiles/retro.sh"),
        "SOUND_SESSION=\"$HOME/audio/start.wav\"\nSOUND_TOOL=\"\"\nSOUND_TASK=\"\"\nSOUND_STOP=\"$HOME/audio/stop.wav\"\n",
    )
    .unwrap();
    std::fs::write(sounds.join("profiles/silent.sh"), "SOUND_SESSION=\"\"\n").unwrap();
}

#[test]
fn claude_profiles_are_discovered_and_imported_without_touching_the_config_dir() {
    let e = env();
    claude_fixture(e.home.path(), &e.config);
    let before = tree(&e.config);
    let profiles = e.m.sound_claude_profiles();
    assert_eq!(profiles.len(), 1);
    assert_eq!(profiles[0].id, "retro");
    let imported = e.m.sound_import_claude_profile("retro").unwrap();
    assert_eq!(
        serde_json::to_value(&imported).unwrap(),
        json!({"packId": "claude-retro"})
    );
    let packs = e.m.sound_packs();
    assert_eq!(packs.len(), 12);
    let p = serde_json::to_value(packs.last().unwrap()).unwrap();
    assert_eq!(p["id"], "claude-retro");
    assert_eq!(p["kind"], "imported");
    assert!(e
        .m
        .sound_file("claude-retro", "done")
        .unwrap()
        .data_url
        .starts_with("data:audio/wav"));
    assert_eq!(
        tree(&e.config),
        before,
        "the Claude config dir is only read"
    );
    assert!(e.m.sound_import_claude_profile("silent").is_err());
    assert!(e.m.sound_import_claude_profile("../x").is_err());
}

fn tree(dir: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    fn walk(d: &Path, out: &mut Vec<(PathBuf, Vec<u8>)>) {
        let mut v: Vec<_> = std::fs::read_dir(d)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .collect();
        v.sort();
        for p in v {
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
fn session_sound_starts_off_when_a_session_start_audio_hook_exists() {
    let plain = env();
    let p = plain.m.prefs_get();
    assert!(p.sound.per_event["session"].on, "no hook: on");
    assert!(
        !p.sound.per_event["message"].on,
        "message is off by default"
    );
    let data = tempfile::Builder::new()
        .prefix("pr")
        .tempdir_in("/tmp")
        .unwrap();
    let home = tempfile::tempdir().unwrap();
    let config = home.path().join(".claude");
    std::fs::create_dir_all(&config).unwrap();
    std::fs::write(
        config.join("settings.json"),
        json!({"hooks": {"SessionStart": [{"hooks": [{"type":"command","command":"afplay /s/hi.aiff"}]}]}})
            .to_string(),
    )
    .unwrap();
    let m = open(data.path(), &config);
    let p = m.prefs_get();
    assert!(!p.sound.per_event["session"].on, "SessionStart hook: off");
    assert!(p.sound.per_event["done"].on);
    // The user turns it on; a restart keeps the choice.
    let mut ev = serde_json::to_value(&p.sound.per_event).unwrap();
    ev["session"]["on"] = Value::Bool(true);
    m.prefs_set(&json!({"sound": {"perEvent": ev}})).unwrap();
    m.shutdown();
    drop(m);
    let m2 = open(data.path(), &config);
    assert!(m2.prefs_get().sound.per_event["session"].on);
    drop(home);
}

#[test]
fn p3_era_stored_prefs_load_as_patch_tones() {
    let e = env();
    // Create the setting row, then overwrite it with what a P3 build stored.
    e.m.prefs_set(&json!({"themeId": "homeroom"})).unwrap();
    let Env {
        data,
        config,
        home,
        m,
    } = e;
    m.shutdown();
    drop(m);
    let old = r#"{"themeId":"homeroom","sound":{"enabled":true,"volume":0.5,"perEvent":{"needs":{"on":true,"sound":"needs"},"done":{"on":true,"sound":"done"},"message":{"on":false,"sound":"message"},"error":{"on":true,"sound":"error"},"bell":{"on":true,"sound":"bell"}},"perDm":{"a":"mute"},"hookPolicy":{}}}"#;
    let db = data.path().join("patchroom.db");
    assert!(sqlite(
        &db,
        &format!("UPDATE setting SET value = '{old}' WHERE key = 'prefs';")
    ));
    assert!(
        sqlite_out(&db, "SELECT value FROM setting WHERE key = 'prefs';")
            .contains("\"hookPolicy\"")
    );
    let m2 = open(data.path(), &config);
    let v = serde_json::to_value(m2.prefs_get()).unwrap();
    for e in [
        "needs", "done", "message", "error", "bell", "decision", "due", "session",
    ] {
        assert_eq!(v["sound"]["mix"][e], json!({"pack": "patchtones"}), "{e}");
    }
    assert_eq!(v["sound"]["perDm"], json!({"a": "mute"}));
    assert!((v["sound"]["volume"].as_f64().unwrap() - 0.5).abs() < 1e-9);
    assert_eq!(v["sound"]["perEvent"].as_object().unwrap().len(), 8);
    assert_eq!(v["sound"]["perEvent"]["message"]["on"], false);
    assert_eq!(v["sound"]["perEvent"]["session"]["on"], true, "no hook: on");
    drop(home);
}

/// A 44.1 kHz mono wav of a 440 Hz sine at `amp`.
fn sine_wav(amp: f64, ms: u32) -> Vec<u8> {
    let rate = 44_100u32;
    let n = rate * ms / 1000;
    let mut v = Vec::new();
    v.extend(b"RIFF");
    v.extend((36 + n * 2).to_le_bytes());
    v.extend(b"WAVEfmt ");
    v.extend(16u32.to_le_bytes());
    v.extend(1u16.to_le_bytes());
    v.extend(1u16.to_le_bytes());
    v.extend(rate.to_le_bytes());
    v.extend((rate * 2).to_le_bytes());
    v.extend(2u16.to_le_bytes());
    v.extend(16u16.to_le_bytes());
    v.extend(b"data");
    v.extend((n * 2).to_le_bytes());
    for i in 0..n {
        let x = (f64::from(i) * 2.0 * std::f64::consts::PI * 440.0 / f64::from(rate)).sin();
        #[allow(clippy::cast_possible_truncation)]
        v.extend(((x * amp * 32767.0).round() as i16).to_le_bytes());
    }
    v
}

#[test]
fn imports_carry_a_norm_and_per_sound_gain_persists_through_prefs() {
    let e = env();
    let src = e.home.path().join("src");
    let loud_bytes = sine_wav(0.9, 400);
    let loud = write(&src, "Loud.wav", &loud_bytes);
    let quiet = write(&src, "Quiet.wav", &sine_wav(0.01, 400));
    let a = e.m.sound_import_file(&loud.to_string_lossy()).unwrap();
    let b = e.m.sound_import_file(&quiet.to_string_lossy()).unwrap();
    assert!(a.norm < 0.3, "{}", a.norm);
    assert!(b.norm > 1.5, "{}", b.norm);
    let listed = serde_json::to_value(e.m.sound_custom_list()).unwrap();
    for row in listed.as_array().unwrap() {
        assert!(row["norm"].is_number() && row["durationMs"].is_number());
    }
    let stored = e.data.path().join("sounds").join(format!("{}.wav", a.id));
    assert_eq!(std::fs::read(stored).unwrap(), loud_bytes, "file untouched");

    // Gain on both pick variants and in a per-DM mix survives prefs_set and prefs_get.
    e.m.prefs_set(&json!({"sound": {
        "mix": {"done": {"custom": a.id, "gain": 0.4}, "bell": {"pack": "cartridge", "gain": 1.5}},
        "perDm": {"dm1": {"mix": {"needs": {"pack": "lab-glass", "gain": 0.25}}}}}}))
        .unwrap();
    let p = serde_json::to_value(e.m.prefs_get()).unwrap();
    assert_eq!(p["sound"]["mix"]["done"]["gain"], json!(0.4));
    assert_eq!(
        p["sound"]["mix"]["bell"],
        json!({"pack": "cartridge", "gain": 1.5})
    );
    assert_eq!(
        p["sound"]["perDm"]["dm1"]["mix"]["needs"]["gain"],
        json!(0.25)
    );
    assert!(e
        .m
        .prefs_set(&json!({"sound": {"mix": {"done": {"pack": "cartridge", "gain": 2.0}}}}))
        .is_err());
    // Bundled packs carry norm per event (1 unless the manifest corrects the level).
    let packs = serde_json::to_value(e.m.sound_packs()).unwrap();
    let lab = packs
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == "lab-glass")
        .unwrap();
    assert_eq!(lab["norm"]["done"], json!(1.0));
}

#[test]
fn imported_claude_profile_packs_carry_measured_norms() {
    let e = env();
    let audio = e.home.path().join("audio");
    write(&audio, "loud.wav", &sine_wav(0.9, 300));
    write(&audio, "quiet.wav", &sine_wav(0.01, 300));
    let profiles = e.config.join("sounds").join("profiles");
    std::fs::create_dir_all(&profiles).unwrap();
    std::fs::write(
        profiles.join("mix.sh"),
        format!(
            "SOUND_STOP=\"{0}/loud.wav\"\nSOUND_SESSION=\"{0}/quiet.wav\"\n",
            audio.display()
        ),
    )
    .unwrap();
    let id = e.m.sound_import_claude_profile("mix").unwrap().pack_id;
    let packs = serde_json::to_value(e.m.sound_packs()).unwrap();
    let p = packs
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == id)
        .unwrap();
    assert!(p["norm"]["done"].as_f64().unwrap() < 0.3, "{p}");
    assert!(p["norm"]["session"].as_f64().unwrap() > 1.5, "{p}");
}
