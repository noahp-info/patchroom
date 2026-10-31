//! Models, the opt-in checks and restart-and-resume.
//!
//! * `session_set_model {id, model}`: after the UI confirmed a `/model` switch, remember the
//!   model as the DM's `--model`, so a resume (and a restart) comes back on it.
//! * `catalog_get` / `catalog_refresh`: the signed model catalog between builds
//!   (`patchroom-catalog`). `catalog_refresh` refuses unless Settings turned the check on.
//! * `update_check`: one GET of the latest GitHub release, only when Settings turned it on.
//! * `app_restart {ids}` / `app_restart_pending`: write the DMs to reopen, relaunch, and hand
//!   the list to the UI once on the next start. The UI resumes each with `--resume <id>`.

use std::path::PathBuf;

use patchroom_prefs::valid_model_id;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{lock, parse_id, AdapterState, Error, Manager, Result};

/// The file in the data dir that carries the DMs to reopen across a restart.
pub const RESTART_FILE: &str = "restart.json";

/// The latest release when an app update check ran.
const RELEASES_LATEST: &str = "https://api.github.com/repos/noahp-info/patchroom/releases/latest";

/// What `update_check` found.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// This build's version.
    pub current: String,
    /// The newest published version, if any release exists.
    pub latest: Option<String>,
    /// Its release page.
    pub url: Option<String>,
    /// `latest` is newer than `current`.
    pub newer: bool,
}

#[derive(Serialize, Deserialize, Default)]
struct RestartFile {
    resume: Vec<String>,
}

/// The `--model` value in a DM's launch arguments.
#[must_use]
pub(super) fn launch_model(args: &[String]) -> Option<String> {
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == "--model" {
            return it.next().cloned();
        }
        if let Some(v) = a.strip_prefix("--model=") {
            return Some(v.to_owned());
        }
    }
    None
}

/// `args` with its `--model` set to `model` (replaced, or appended when missing).
#[must_use]
pub(super) fn with_model(args: &[String], model: &str) -> Vec<String> {
    let mut out = Vec::with_capacity(args.len() + 2);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == "--model" {
            it.next();
        } else if !a.starts_with("--model=") {
            out.push(a.clone());
        }
    }
    out.push("--model".into());
    out.push(model.to_owned());
    out
}

/// `1.2.3` style versions; a leading `v` is ignored. `None` when it does not parse.
fn version_parts(v: &str) -> Option<Vec<u64>> {
    let v = v.trim().trim_start_matches('v');
    let core = v.split(['-', '+']).next()?;
    core.split('.').map(|p| p.parse().ok()).collect()
}

/// Is `latest` newer than `current`?
#[must_use]
pub(super) fn is_newer(latest: &str, current: &str) -> bool {
    match (version_parts(latest), version_parts(current)) {
        (Some(a), Some(b)) => {
            let n = a.len().max(b.len());
            let pad = |v: &Vec<u64>, i| v.get(i).copied().unwrap_or(0);
            (0..n)
                .map(|i| pad(&a, i).cmp(&pad(&b, i)))
                .find(|o| o.is_ne())
                .is_some_and(std::cmp::Ordering::is_gt)
        }
        _ => false,
    }
}

impl Manager {
    fn restart_path(&self) -> PathBuf {
        self.cfg.data_dir.join(RESTART_FILE)
    }

    /// `session_set_model {id, model}`: the DM launches and resumes with `--model <model>`.
    ///
    /// # Errors
    /// Unknown DM, a non-claude DM, or an unsafe model string.
    pub fn set_model(&self, id: &str, model: &str) -> Result<()> {
        if !valid_model_id(model) {
            return Err(Error::Invalid(format!("not a model name: {model:?}")));
        }
        let conv = self.conversation(id)?;
        let mut spec = AdapterState::parse(&conv.adapter_state);
        if !spec.is_claude() {
            return Err(Error::Invalid(
                "only Claude Code sessions switch models".into(),
            ));
        }
        spec.args = with_model(&spec.args, model);
        lock(&self.store).set_adapter_state(
            parse_id(id)?,
            &serde_json::to_string(&spec).unwrap_or_else(|_| "{}".into()),
        )?;
        Ok(())
    }

    /// `session_set_emoji {id, emoji?, flavor?}`.
    ///
    /// # Errors
    /// Unknown DM, an emoji that is too long, or an unknown flavor.
    pub fn set_session_emoji(
        &self,
        id: &str,
        emoji: Option<&str>,
        flavor: Option<&str>,
    ) -> Result<()> {
        lock(&self.store).set_conversation_emoji(parse_id(id)?, emoji, flavor)?;
        Ok(())
    }

    /// `section_set_emoji {id, emoji?, flavor?}` with a flavor.
    ///
    /// # Errors
    /// Unknown section, an emoji that is too long, or an unknown flavor.
    pub fn set_section_emoji_flavor(
        &self,
        id: &str,
        emoji: Option<&str>,
        flavor: Option<&str>,
    ) -> Result<()> {
        lock(&self.store).set_section_emoji_flavor(parse_id(id)?, emoji, flavor)?;
        Ok(())
    }

    /// `catalog_get`: the newer catalog fetched earlier, verified again, or `None`.
    #[must_use]
    pub fn catalog_cached(&self) -> Option<Value> {
        patchroom_catalog::load_cached(&self.cfg.data_dir)
    }

    /// `catalog_refresh`: download and verify the signed catalog. Only when the user turned
    /// "Check for newer models" on; the backend checks the setting itself.
    ///
    /// # Errors
    /// The check is off, or the download or signature failed.
    pub fn catalog_refresh(&self) -> Result<Value> {
        if !self.prefs_get().updates.check_models {
            return Err(Error::Invalid(
                "Check for newer models is off in Settings".into(),
            ));
        }
        patchroom_catalog::fetch(&self.cfg.data_dir, &patchroom_catalog::system_curl())
            .map_err(|e| Error::Invalid(e.to_string()))
    }

    /// `update_check`: is a newer Patchroom published? Only when "Check for app updates" is on.
    ///
    /// # Errors
    /// The check is off, or the request failed.
    pub fn update_check(&self) -> Result<UpdateInfo> {
        if !self.prefs_get().updates.check_app {
            return Err(Error::Invalid(
                "Check for app updates is off in Settings".into(),
            ));
        }
        let current = env!("CARGO_PKG_VERSION").to_owned();
        let body = patchroom_catalog::https_get(RELEASES_LATEST, &patchroom_catalog::system_curl());
        let v: Value = match body {
            Ok(b) => serde_json::from_slice(&b).unwrap_or(Value::Null),
            // No release published yet answers 404: nothing is newer.
            Err(e) if e.to_string().contains("404") => Value::Null,
            Err(e) => return Err(Error::Invalid(e.to_string())),
        };
        let latest = v
            .get("tag_name")
            .and_then(Value::as_str)
            .map(|t| t.trim_start_matches('v').to_owned());
        let url = v
            .get("html_url")
            .and_then(Value::as_str)
            .filter(|u| u.starts_with("https://github.com/"))
            .map(str::to_owned);
        let newer = latest.as_deref().is_some_and(|l| is_newer(l, &current));
        Ok(UpdateInfo {
            current,
            latest,
            url,
            newer,
        })
    }

    /// `app_restart {ids}`: remember which DMs to reopen. The shell then relaunches the app.
    /// Only DMs this store knows, claude DMs with a session id, and never mirrors.
    ///
    /// # Errors
    /// The file could not be written.
    pub fn prepare_restart(&self, ids: &[String]) -> Result<usize> {
        let keep: Vec<String> = ids
            .iter()
            .filter(|id| self.mirror_of(id).is_none())
            .filter(|id| {
                self.conversation(id).is_ok_and(|c| {
                    c.session_id.is_some() && AdapterState::parse(&c.adapter_state).is_claude()
                })
            })
            .cloned()
            .collect();
        let body = serde_json::to_vec(&RestartFile {
            resume: keep.clone(),
        })
        .unwrap_or_default();
        std::fs::write(self.restart_path(), body)?;
        Ok(keep.len())
    }

    /// `app_restart_pending`: the DMs a restart asked to reopen, once. The file is removed.
    #[must_use]
    pub fn take_restart(&self) -> Vec<String> {
        let path = self.restart_path();
        let Ok(raw) = std::fs::read(&path) else {
            return Vec::new();
        };
        let _ = std::fs::remove_file(&path);
        serde_json::from_slice::<RestartFile>(&raw)
            .map(|f| f.resume)
            .unwrap_or_default()
            .into_iter()
            .filter(|id| self.conversation(id).is_ok())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn the_launch_model_is_read_and_replaced() {
        assert_eq!(launch_model(&v(&[])), None);
        assert_eq!(
            launch_model(&v(&["--model", "claude-opus-5-5"])).as_deref(),
            Some("claude-opus-5-5")
        );
        assert_eq!(
            launch_model(&v(&["--model=haiku"])).as_deref(),
            Some("haiku")
        );
        assert_eq!(
            with_model(&v(&["--verbose", "--model", "a", "--x"]), "b"),
            v(&["--verbose", "--x", "--model", "b"])
        );
        assert_eq!(
            with_model(&v(&["--model=a"]), "claude-opus-4-8[1m]"),
            v(&["--model", "claude-opus-4-8[1m]"])
        );
    }

    #[test]
    fn versions_compare_numerically() {
        assert!(is_newer("0.0.2", "0.0.1"));
        assert!(is_newer("v0.10.0", "0.9.9"));
        assert!(is_newer("1.0", "0.9.9"));
        assert!(!is_newer("0.0.1", "0.0.1"));
        assert!(!is_newer("0.0.1", "0.1.0"));
        assert!(!is_newer("garbage", "0.0.1"));
        assert!(!is_newer("0.0.1-beta", "0.0.1"));
    }
}
