//! Model bundles, model labels, update checks and emoji choices: the parts of `Prefs` this batch
//! added. The shapes are camelCase JSON, owned by the IPC contract (`ui/src/ipc/types.ts`).
//!
//! A model string goes onto a command line (`--model <id>`) and into the terminal (`/model <id>`),
//! so every one is checked here with [`valid_model_id`]: no spaces, quotes, control characters
//! or shell metacharacters can reach the CLI from prefs.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::prefs::PrefsError;

/// Longest model string, label or name accepted.
pub const MAX_MODEL_LEN: usize = 128;
/// Most bundles kept.
pub const MAX_BUNDLES: usize = 32;
/// Most entries in one bundle.
pub const MAX_ENTRIES: usize = 32;
/// Longest label or bundle name, in characters.
pub const MAX_LABEL_CHARS: usize = 48;
/// Most model ids remembered for one-time hints and labels.
pub const MAX_REMEMBERED: usize = 256;

/// Tools a bundle entry can name. The adapters live in the UI (`ui/src/lib/models/adapters.ts`).
pub const TOOLS: [&str; 5] = ["claude-code", "codex", "cursor", "gemini", "opencode"];

/// Is this a safe model string? `claude-opus-5-5`, `claude-opus-4-8[1m]`, `openai/gpt-x`,
/// `latest:opus` and the like. Letters, digits and `. _ - : / @ [ ]` only, 1 to 128 bytes.
#[must_use]
pub fn valid_model_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_MODEL_LEN
        && !id.starts_with('-')
        && id.bytes().all(|b| {
            b.is_ascii_alphanumeric()
                || matches!(b, b'.' | b'_' | b'-' | b':' | b'/' | b'@' | b'[' | b']')
        })
}

fn valid_key(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn short(s: &str) -> bool {
    s.chars().count() <= MAX_LABEL_CHARS && !s.chars().any(char::is_control)
}

/// How an emoji is drawn: the system's Apple Color Emoji, or the bundled Noto Color Emoji.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Flavor {
    /// Apple Color Emoji (the system font).
    #[default]
    Apple,
    /// Noto Color Emoji (bundled, OFL).
    Noto,
}

/// Emoji preferences.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EmojiPrefs {
    /// How emoji in chat text (and the terminal) are drawn.
    pub chat: Flavor,
}

/// Chat view preferences.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ChatPrefs {
    /// Logs follow new messages until the user scrolls up. Off: every log starts paused.
    pub auto_scroll: bool,
    /// Switching a session from chat to terminal types the chat draft into claude's input
    /// (without Enter) and clears it in chat. Off by default.
    pub carry_draft: bool,
    /// Up in an empty composer (or on its first line) brings back sent messages, as Claude
    /// Code's prompt does. On by default.
    pub up_history: bool,
}

impl Default for ChatPrefs {
    fn default() -> Self {
        Self {
            auto_scroll: true,
            carry_draft: false,
            up_history: true,
        }
    }
}

/// Opt-in network checks (SPEC D3: opt-in). Nothing fetches while both are off.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Updates {
    /// Check GitHub Releases for a newer Patchroom.
    pub check_app: bool,
    /// Fetch the signed model catalog between builds.
    pub check_models: bool,
    /// The "Want to check for newer models?" question was answered (either way).
    pub asked_models: bool,
}

/// One model in a bundle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleEntry {
    /// Stable id inside the bundle.
    pub id: String,
    /// Tool that runs it (one of [`TOOLS`]).
    pub tool: String,
    /// The model string: a catalog id, free text, or `latest:<family>`.
    pub model: String,
}

/// A named set of models with one default.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bundle {
    /// Stable id.
    pub id: String,
    /// Shown name.
    pub name: String,
    /// Leading emoji, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emoji: Option<String>,
    /// The models, in the order the picker shows them.
    pub entries: Vec<BundleEntry>,
    /// Id of the entry new sessions launch on.
    pub default_entry: String,
}

/// Cloud or local, for the label template.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Place {
    /// Runs in a provider's cloud.
    Cloud,
    /// Runs on this machine.
    Local,
}

/// A label of the user's own for one model.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ModelLabel {
    /// Label text. Empty: use the template.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Emoji in front of the text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub emoji: Option<String>,
    /// Cloud or local. Absent: decided from the session and the catalog.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub place: Option<Place>,
}

/// Label templates per place. `{name}` is the model's name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct GroupLabels {
    /// Template for cloud models.
    pub cloud: String,
    /// Template for local models.
    pub local: String,
}

/// The Local template before 2026-10-29 (a house). A stored template equal to it moves to
/// the laptop default; anything the user typed stays.
pub const OLD_LOCAL_DEFAULT: &str = "\u{1f3e0} {name}";

impl Default for GroupLabels {
    fn default() -> Self {
        Self {
            cloud: "\u{2601}\u{fe0f} {name}".into(),
            local: "\u{1f4bb} {name}".into(),
        }
    }
}

impl GroupLabels {
    /// Move a Local template that still equals the old default to the new one.
    pub fn migrate_local_default(&mut self) {
        if self.local == OLD_LOCAL_DEFAULT {
            self.local = Self::default().local;
        }
    }
}

/// Model preferences: bundles, which bundle applies where, and labels.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Models {
    /// The user's bundles. Empty until the user makes one.
    pub bundles: Vec<Bundle>,
    /// Bundle every session uses unless an override applies.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_bundle: Option<String>,
    /// Bundle per folder (absolute path).
    pub per_folder: BTreeMap<String, String>,
    /// Bundle per section id.
    pub per_section: BTreeMap<String, String>,
    /// Bundle per session id.
    pub per_session: BTreeMap<String, String>,
    /// The user's label per model id.
    pub labels: BTreeMap<String, ModelLabel>,
    /// Label templates for models without a label of their own.
    pub group_labels: GroupLabels,
    /// Model ids the chip has shown, so "set its own label" asks once per model.
    pub seen: Vec<String>,
    /// Newer model ids already offered (Swap or Keep), so each is offered once.
    pub offered: Vec<String>,
}

fn trim_list(list: &mut Vec<String>) {
    list.retain(|m| valid_model_id(m));
    if list.len() > MAX_REMEMBERED {
        let drop = list.len() - MAX_REMEMBERED;
        list.drain(..drop);
    }
}

impl Models {
    /// Check every model string, id, name and label; trim the remembered lists.
    ///
    /// # Errors
    /// A bad model string, id, tool, name or label.
    pub fn validate(&mut self) -> Result<(), PrefsError> {
        let bad = |m: String| Err(PrefsError(m));
        if self.bundles.len() > MAX_BUNDLES {
            return bad(format!("at most {MAX_BUNDLES} bundles"));
        }
        for b in &self.bundles {
            if !valid_key(&b.id) || b.name.trim().is_empty() || !short(&b.name) {
                return bad(format!("bad bundle id or name {:?}", b.id));
            }
            if b.emoji.as_deref().is_some_and(|e| !short(e)) {
                return bad("bad bundle emoji".into());
            }
            if b.entries.is_empty() || b.entries.len() > MAX_ENTRIES {
                return bad(format!("a bundle has 1 to {MAX_ENTRIES} models"));
            }
            for e in &b.entries {
                if !valid_key(&e.id) || !TOOLS.contains(&e.tool.as_str()) {
                    return bad(format!("bad bundle entry {:?}", e.id));
                }
                if !valid_model_id(&e.model) {
                    return bad(format!("bad model string {:?}", e.model));
                }
            }
            if !b.entries.iter().any(|e| e.id == b.default_entry) {
                return bad(format!("bundle {:?} has no default model", b.name));
            }
        }
        let known = |id: &String| self.bundles.iter().any(|b| &b.id == id);
        if self.default_bundle.as_ref().is_some_and(|d| !known(d)) {
            self.default_bundle = None;
        }
        for map in [
            &mut self.per_folder,
            &mut self.per_section,
            &mut self.per_session,
        ] {
            map.retain(|_, v| self.bundles.iter().any(|b| &b.id == v));
        }
        if self.labels.len() > MAX_REMEMBERED {
            return bad("too many model labels".into());
        }
        for (id, l) in &self.labels {
            if !valid_model_id(id) {
                return bad(format!("bad model id {id:?}"));
            }
            if l.text.as_deref().is_some_and(|t| !short(t))
                || l.emoji.as_deref().is_some_and(|t| !short(t))
            {
                return bad(format!("label for {id:?} is too long"));
            }
        }
        if !short(&self.group_labels.cloud) || !short(&self.group_labels.local) {
            return bad("label template is too long".into());
        }
        trim_list(&mut self.seen);
        trim_list(&mut self.offered);
        Ok(())
    }
}

/// A status strip module's label of the user's own: text plus an emoji.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ModuleLabel {
    /// Text in front of the module's value.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Emoji in front of the text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub emoji: Option<String>,
}

impl ModuleLabel {
    /// Both parts fit.
    #[must_use]
    pub fn valid(&self) -> bool {
        self.text.as_deref().is_none_or(short) && self.emoji.as_deref().is_none_or(short)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_strings_are_safe_for_a_command_line() {
        for ok in [
            "claude-opus-5-5",
            "claude-opus-4-8[1m]",
            "sonnet",
            "latest:opus",
            "openai/gpt-5.1",
            "llama3.2:3b",
            "us.anthropic.claude-x@v1",
        ] {
            assert!(valid_model_id(ok), "{ok}");
        }
        for bad in [
            "",
            "a b",
            "x;rm -rf",
            "x\n/clear",
            "$(id)",
            "`id`",
            "'q'",
            "-p",
            "--dangerously-skip-permissions",
            &"a".repeat(129),
        ] {
            assert!(!valid_model_id(bad), "{bad}");
        }
    }

    fn daily() -> Models {
        let e = |id: &str, model: &str| BundleEntry {
            id: id.into(),
            tool: "claude-code".into(),
            model: model.into(),
        };
        Models {
            bundles: vec![Bundle {
                id: "daily".into(),
                name: "Daily".into(),
                emoji: Some("\u{2600}\u{fe0f}".into()),
                entries: vec![
                    e("a", "claude-opus-5-5"),
                    e("b", "claude-fable-5-1"),
                    e("c", "claude-sonnet-4-6"),
                    e("d", "claude-opus-4-8[1m]"),
                ],
                default_entry: "a".into(),
            }],
            default_bundle: Some("daily".into()),
            ..Models::default()
        }
    }

    #[test]
    fn a_bundle_validates_and_stale_overrides_drop() {
        let mut m = daily();
        m.per_section.insert("s1".into(), "daily".into());
        m.per_session.insert("x".into(), "gone".into());
        m.validate().unwrap();
        assert_eq!(m.per_section.len(), 1);
        assert!(m.per_session.is_empty(), "points at a deleted bundle");
    }

    #[test]
    fn bad_bundles_are_refused() {
        let mut m = daily();
        m.bundles[0].default_entry = "zz".into();
        assert!(m.validate().is_err());
        let mut m = daily();
        m.bundles[0].entries[1].model = "x y".into();
        assert!(m.validate().is_err());
        let mut m = daily();
        m.bundles[0].entries[0].tool = "bash".into();
        assert!(m.validate().is_err());
        let mut m = daily();
        m.bundles[0].entries.clear();
        assert!(m.validate().is_err());
        let mut m = daily();
        m.labels.insert(
            "claude-opus-5-5".into(),
            ModelLabel {
                text: Some("x".repeat(49)),
                ..ModelLabel::default()
            },
        );
        assert!(m.validate().is_err());
    }

    #[test]
    fn templates_default_to_cloud_and_laptop() {
        let g = GroupLabels::default();
        assert!(g.cloud.contains("{name}") && g.local.contains("{name}"));
        assert_eq!(g.local, "\u{1f4bb} {name}");
    }

    #[test]
    fn only_the_old_local_default_migrates() {
        let mut g = GroupLabels {
            local: OLD_LOCAL_DEFAULT.into(),
            ..GroupLabels::default()
        };
        g.migrate_local_default();
        assert_eq!(g.local, GroupLabels::default().local);
        let mut own = GroupLabels {
            local: "\u{1f3e0} at home: {name}".into(),
            ..GroupLabels::default()
        };
        own.migrate_local_default();
        assert_eq!(own.local, "\u{1f3e0} at home: {name}");
    }
}
