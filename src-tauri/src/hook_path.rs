//! Locating the `patchroom-hook` binary at runtime.
//!
//! `build.rs` compiles the hook and stages it as a Tauri sidecar. Tauri then
//! places it next to the app executable under the plain name `patchroom-hook`:
//!
//! - dev (`pnpm tauri dev`) and the debug build: `target/<profile>/patchroom-hook`,
//!   beside the `patchroom` executable;
//! - the `.app` bundle: `Patchroom.app/Contents/MacOS/patchroom-hook`.
//!
//! Resolution order: the `PATCHROOM_HOOK_BIN` override, the executable's own
//! directory, then its parent (covers test binaries in `target/<profile>/deps`).

use std::path::{Path, PathBuf};

/// File name of the hook binary.
pub const HOOK_BIN_NAME: &str = "patchroom-hook";

/// Environment variable that overrides the lookup with an explicit path.
pub const HOOK_BIN_ENV: &str = "PATCHROOM_HOOK_BIN";

/// Candidate paths in priority order. Pure so it can be tested.
#[must_use]
pub fn candidates(exe: &Path, override_path: Option<&str>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(p) = override_path.filter(|p| !p.is_empty()) {
        out.push(PathBuf::from(p));
    }
    if let Some(dir) = exe.parent() {
        out.push(dir.join(HOOK_BIN_NAME));
        if let Some(up) = dir.parent() {
            out.push(up.join(HOOK_BIN_NAME));
        }
    }
    out
}

/// The first existing candidate, or the first candidate when none exist (so
/// the error message can name where the app looked).
#[must_use]
pub fn resolve_hook_binary() -> PathBuf {
    let exe = std::env::current_exe().unwrap_or_default();
    let env = std::env::var(HOOK_BIN_ENV).ok();
    let list = candidates(&exe, env.as_deref());
    list.iter()
        .find(|p| p.is_file())
        .cloned()
        .or_else(|| list.into_iter().next())
        .unwrap_or_else(|| PathBuf::from(HOOK_BIN_NAME))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn override_comes_first_then_exe_dir_then_parent() {
        let c = candidates(Path::new("/t/debug/deps/x"), Some("/opt/hook"));
        assert_eq!(
            c,
            vec![
                PathBuf::from("/opt/hook"),
                PathBuf::from("/t/debug/deps/patchroom-hook"),
                PathBuf::from("/t/debug/patchroom-hook"),
            ]
        );
    }

    #[test]
    fn empty_override_is_ignored() {
        let c = candidates(
            Path::new("/b/Patchroom.app/Contents/MacOS/patchroom"),
            Some(""),
        );
        assert_eq!(
            c[0],
            PathBuf::from("/b/Patchroom.app/Contents/MacOS/patchroom-hook")
        );
    }
}
