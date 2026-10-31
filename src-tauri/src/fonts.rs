//! Installed font families for Settings > Themes > Fonts, read from Core Text. Read only: no
//! file, no network, no new permission. The folding and filtering live in `patchroom-prefs`.

use patchroom_prefs::FontFamily;

/// Every installed family, sorted, with its fixed-pitch trait.
#[cfg(target_os = "macos")]
#[must_use]
pub fn installed() -> Vec<FontFamily> {
    use core_text::font_collection::create_for_all_families;
    use core_text::font_descriptor::{SymbolicTraitAccessors, TraitAccessors};
    use std::panic::{catch_unwind, AssertUnwindSafe};

    let Some(descs) = create_for_all_families().get_descriptors() else {
        return Vec::new();
    };
    let faces = descs.iter().filter_map(|d| {
        // A malformed font can make the Core Text wrapper panic on its traits: skip that face.
        catch_unwind(AssertUnwindSafe(|| {
            (d.family_name(), d.traits().symbolic_traits().is_monospace())
        }))
        .ok()
    });
    patchroom_prefs::families_from_faces(faces)
}

/// Other platforms list nothing: the bundled faces still show.
#[cfg(not(target_os = "macos"))]
#[must_use]
pub fn installed() -> Vec<FontFamily> {
    Vec::new()
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    #[test]
    fn core_text_lists_menlo_as_mono() {
        let list = super::installed();
        assert!(list.len() > 10, "Core Text should list the system families");
        let menlo = list
            .iter()
            .find(|f| f.family == "Menlo")
            .expect("Menlo ships with macOS");
        assert!(menlo.mono);
        assert!(list.iter().any(|f| !f.mono), "proportional families too");
        assert!(list.iter().all(|f| !f.family.starts_with('.')));
    }
}
