//! Sound packs: the `sound_*` commands of the manager.
//!
//! The work is in `patchroom-sounds`; this module supplies the paths (the bundled `sounds`
//! resource dir, the app data dir, the Claude config dir read only) and keeps prefs in step
//! when a custom sound is removed.

use std::path::{Path, PathBuf};

use patchroom_prefs::{detect_sound_hooks, Prefs};
use patchroom_sounds::claude::{self, ClaudeProfile};
use patchroom_sounds::custom::{self, CustomSound};
use patchroom_sounds::packs::{self, PackInfo};
use patchroom_sounds::SoundError;
use patchroom_store::{Id, Store};
use serde::Serialize;
use serde_json::json;

use super::{Error, Manager, ManagerConfig, Result};

/// Result of `sound_file` and `sound_custom_file`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoundFile {
    /// `data:<media type>;base64,<bytes>`.
    pub data_url: String,
}

/// Result of `sound_import_claude_profile`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedPack {
    /// Id of the new pack, as listed by `sound_packs`.
    pub pack_id: String,
}

impl From<SoundError> for Error {
    fn from(e: SoundError) -> Self {
        Self::Invalid(e.0)
    }
}

/// Does the user already have a SessionStart audio hook (user settings or any DM's project)?
/// The `session` sound then starts off.
pub(super) fn session_start_hook(cfg: &ManagerConfig, store: &Store, workspace: Id) -> bool {
    let dirs: Vec<PathBuf> = store
        .list_conversations(workspace)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|c| c.cwd.map(PathBuf::from))
        .collect();
    detect_sound_hooks(cfg.claude_config_dir.as_deref(), &dirs)
        .iter()
        .any(|h| h.event == "SessionStart" && !h.guarded)
}

/// Delete custom sounds that the stored prefs do not reference. Does nothing when there are
/// no stored prefs or they cannot be read, so a damaged setting never costs the user's files.
pub(super) fn prune_unreferenced(data_dir: &Path, stored_prefs: Option<&str>) {
    let Some(raw) = stored_prefs.filter(|r| Prefs::is_readable(r)) else {
        return;
    };
    let keep = Prefs::from_stored(raw).custom_sound_ids();
    custom::prune_custom(data_dir, &keep);
}

impl Manager {
    fn home(&self) -> PathBuf {
        self.cfg.home_dir.clone().unwrap_or_default()
    }

    fn resources(&self) -> Option<&Path> {
        self.cfg.sounds_dir.as_deref()
    }

    /// `sound_packs`: every bundled and imported pack.
    #[must_use]
    pub fn sound_packs(&self) -> Vec<PackInfo> {
        packs::list_packs(self.resources(), &self.cfg.data_dir)
    }

    /// `sound_file {packId, event}`: a file pack's sound as a data URL.
    ///
    /// # Errors
    /// Unknown pack, a generated pack, or no sound for that event.
    pub fn sound_file(&self, pack_id: &str, event: &str) -> Result<SoundFile> {
        let data_url = packs::sound_file(self.resources(), &self.cfg.data_dir, pack_id, event)?;
        Ok(SoundFile { data_url })
    }

    /// `sound_import_file {path}`: check the limits, then copy into the data dir.
    ///
    /// # Errors
    /// A type, size or duration limit (the message names it), or an unreadable file.
    pub fn sound_import_file(&self, path: &str) -> Result<CustomSound> {
        Ok(custom::import_file(&self.cfg.data_dir, Path::new(path))?)
    }

    /// `sound_custom_list`: the custom sounds, newest first.
    #[must_use]
    pub fn sound_custom_list(&self) -> Vec<CustomSound> {
        custom::list_custom(&self.cfg.data_dir)
    }

    /// `sound_custom_file {id}`: a custom sound as a data URL.
    ///
    /// # Errors
    /// Unknown id.
    pub fn sound_custom_file(&self, id: &str) -> Result<SoundFile> {
        Ok(SoundFile {
            data_url: custom::custom_file(&self.cfg.data_dir, id)?,
        })
    }

    /// `sound_custom_remove {id}`: delete the file. Any mix that used it falls back to
    /// Patch Tones for that event, and prefs are saved.
    ///
    /// # Errors
    /// Unknown id, or a store failure.
    pub fn sound_custom_remove(self: &std::sync::Arc<Self>, id: &str) -> Result<()> {
        custom::remove_custom(&self.cfg.data_dir, id)?;
        let mut prefs = self.prefs_get();
        if prefs.drop_custom_sound(id) {
            let sound =
                serde_json::to_value(&prefs.sound).map_err(|e| Error::Invalid(e.to_string()))?;
            self.prefs_set(&json!({ "sound": sound }))?;
        }
        Ok(())
    }

    /// `sound_claude_profiles`: the user's Claude sound profiles, read only.
    #[must_use]
    pub fn sound_claude_profiles(&self) -> Vec<ClaudeProfile> {
        self.cfg
            .claude_config_dir
            .as_deref()
            .map(|c| claude::discover(c, &self.home()))
            .unwrap_or_default()
    }

    /// `sound_import_claude_profile {id}`: copy a profile's sounds into an imported pack.
    ///
    /// # Errors
    /// No Claude config dir, no such profile, or nothing in it can be imported.
    pub fn sound_import_claude_profile(&self, id: &str) -> Result<ImportedPack> {
        let cfg = self
            .cfg
            .claude_config_dir
            .as_deref()
            .ok_or_else(|| Error::Invalid("No Claude config folder was found.".into()))?;
        let pack_id = claude::import_profile(cfg, &self.home(), &self.cfg.data_dir, id)?;
        Ok(ImportedPack { pack_id })
    }
}
