//! Font preferences (Settings > Themes > Fonts) and the installed-family list.
//!
//! Five areas take a family and a size: `ui` (the default for everything), `chat`, `code` (code
//! and the terminal), `sidebar` and `statusBar`. An unset field inherits; the UI works out from
//! where. A sidebar section or a session can override the chat font (`perSection`,
//! `perSession`). Family names reach CSS custom properties, so only plain names pass.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::prefs::PrefsError;

/// Smallest font size accepted, in px.
pub const MIN_SIZE: f64 = 8.0;
/// Largest font size accepted, in px.
pub const MAX_SIZE: f64 = 32.0;
/// Longest family name accepted.
pub const MAX_FAMILY_LEN: usize = 96;
/// Most per-section or per-session overrides kept.
pub const MAX_OVERRIDES: usize = 512;

/// One area's family and size. Both optional: unset inherits.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct FontChoice {
    /// Font family name, as Core Text and CSS know it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub family: Option<String>,
    /// Size in px.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<f64>,
}

impl FontChoice {
    /// Neither field is set.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.family.is_none() && self.size.is_none()
    }

    fn validate(&self) -> Result<(), PrefsError> {
        if let Some(f) = &self.family {
            if !valid_family(f) {
                return Err(PrefsError(format!("bad font family {f:?}")));
            }
        }
        if let Some(s) = self.size {
            if !s.is_finite() || !(MIN_SIZE..=MAX_SIZE).contains(&s) {
                return Err(PrefsError(format!(
                    "font size must be {MIN_SIZE} to {MAX_SIZE} px"
                )));
            }
        }
        Ok(())
    }
}

/// Every font preference. Missing areas and an empty object mean "all defaults".
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Fonts {
    /// The default for everything.
    #[serde(skip_serializing_if = "FontChoice::is_empty")]
    pub ui: FontChoice,
    /// Chat messages.
    #[serde(skip_serializing_if = "FontChoice::is_empty")]
    pub chat: FontChoice,
    /// Code and the terminal (fixed pitch).
    #[serde(skip_serializing_if = "FontChoice::is_empty")]
    pub code: FontChoice,
    /// The sidebar.
    #[serde(skip_serializing_if = "FontChoice::is_empty")]
    pub sidebar: FontChoice,
    /// The status strip.
    #[serde(skip_serializing_if = "FontChoice::is_empty")]
    pub status_bar: FontChoice,
    /// Chat font per sidebar section id.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub per_section: BTreeMap<String, FontChoice>,
    /// Chat font per session id. Wins over the section's.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub per_session: BTreeMap<String, FontChoice>,
}

impl Fonts {
    /// Check every field, and drop empty overrides.
    ///
    /// # Errors
    /// A family name that is not a plain name, a size out of range, or too many overrides.
    pub fn validate(&mut self) -> Result<(), PrefsError> {
        for c in [
            &self.ui,
            &self.chat,
            &self.code,
            &self.sidebar,
            &self.status_bar,
        ] {
            c.validate()?;
        }
        for map in [&mut self.per_section, &mut self.per_session] {
            map.retain(|_, c| !c.is_empty());
            if map.len() > MAX_OVERRIDES {
                return Err(PrefsError("too many font overrides".into()));
            }
            for (id, c) in map.iter() {
                if id.is_empty() || id.len() > 64 {
                    return Err(PrefsError("bad id in a font override".into()));
                }
                c.validate()?;
            }
        }
        Ok(())
    }
}

/// Is this a plain family name? It is written into a CSS custom property inside double quotes,
/// so quotes, backslashes, semicolons, braces, angle brackets and control characters never pass.
#[must_use]
pub fn valid_family(name: &str) -> bool {
    let t = name.trim();
    !t.is_empty()
        && t.len() == name.len()
        && name.chars().count() <= MAX_FAMILY_LEN
        && !name
            .chars()
            .any(|c| c.is_control() || matches!(c, '"' | '\'' | '\\' | ';' | '{' | '}' | '<' | '>'))
}

/// One installed font family, as `fonts_list` returns it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FontFamily {
    /// The family name.
    pub family: String,
    /// Every face of the family is fixed pitch.
    pub mono: bool,
}

/// Fold one entry per installed face (`family`, `fixed pitch`) into a sorted family list.
/// Hidden system families (a leading `.`) and names CSS cannot carry are skipped. A family is
/// mono only when every face of it is.
#[must_use]
pub fn families_from_faces<I, S>(faces: I) -> Vec<FontFamily>
where
    I: IntoIterator<Item = (S, bool)>,
    S: Into<String>,
{
    let mut mono: BTreeMap<String, bool> = BTreeMap::new();
    for (name, fixed) in faces {
        let name: String = name.into();
        if name.starts_with('.') || !valid_family(&name) {
            continue;
        }
        mono.entry(name)
            .and_modify(|m| *m = *m && fixed)
            .or_insert(fixed);
    }
    // Case-insensitive order, as the Font Book lists them; ties keep a stable order.
    let mut out: Vec<FontFamily> = mono
        .into_iter()
        .map(|(family, mono)| FontFamily { family, mono })
        .collect();
    out.sort_by(|a, b| {
        a.family
            .to_lowercase()
            .cmp(&b.family.to_lowercase())
            .then_with(|| a.family.cmp(&b.family))
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn plain_names_pass_and_css_breakers_do_not() {
        for ok in [
            "Figtree",
            "JetBrains Mono",
            "SF Pro Text",
            "Noto Sans CJK JP",
            "Ubuntu-Mono",
        ] {
            assert!(valid_family(ok), "{ok}");
        }
        for bad in [
            "",
            " Figtree",
            "Figtree ",
            "a\"b",
            "a'b",
            "a;b",
            "a{b}",
            "a\\b",
            "a<b",
            "a\nb",
            &"x".repeat(97),
        ] {
            assert!(!valid_family(bad), "{bad:?}");
        }
    }

    #[test]
    fn empty_fonts_serialize_to_an_empty_object() {
        assert_eq!(serde_json::to_value(Fonts::default()).unwrap(), json!({}));
    }

    #[test]
    fn choices_round_trip_in_camel_case() {
        let v = json!({
            "ui": {"family": "Inter", "size": 15},
            "statusBar": {"size": 11},
            "perSection": {"s1": {"family": "Georgia"}},
            "perSession": {"d1": {"size": 16}}
        });
        let mut f: Fonts = serde_json::from_value(v.clone()).unwrap();
        f.validate().unwrap();
        assert_eq!(f.ui.family.as_deref(), Some("Inter"));
        assert_eq!(f.status_bar.size, Some(11.0));
        assert_eq!(
            serde_json::to_value(&f).unwrap()["perSection"],
            v["perSection"]
        );
    }

    #[test]
    fn bad_values_are_refused() {
        for bad in [
            json!({"ui": {"size": 4}}),
            json!({"ui": {"size": 33}}),
            json!({"chat": {"family": "x;}body{"}}),
            json!({"perSession": {"": {"size": 12}}}),
        ] {
            let mut f: Fonts = serde_json::from_value(bad.clone()).unwrap();
            assert!(f.validate().is_err(), "{bad}");
        }
    }

    #[test]
    fn empty_overrides_are_dropped() {
        let mut f: Fonts =
            serde_json::from_value(json!({"perSection": {"a": {}, "b": {"size": 14}}})).unwrap();
        f.validate().unwrap();
        assert_eq!(f.per_section.keys().collect::<Vec<_>>(), ["b"]);
    }

    #[test]
    fn faces_fold_into_sorted_families() {
        let list = families_from_faces([
            ("Menlo", true),
            ("menlo2", true),
            (".SF NS", false),
            ("Avenir", false),
            ("Menlo", true),
            ("Mixed", true),
            ("Mixed", false),
            ("bad;name", true),
        ]);
        let names: Vec<_> = list.iter().map(|f| f.family.as_str()).collect();
        assert_eq!(names, ["Avenir", "Menlo", "menlo2", "Mixed"]);
        assert!(list[1].mono);
        assert!(!list[3].mono, "a family is mono only if every face is");
    }
}
