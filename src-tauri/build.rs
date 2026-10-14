//! Build script: compiles the `patchroom-hook` binary and stages it as a Tauri
//! sidecar (`binaries/patchroom-hook-<target-triple>`), then runs `tauri-build`.
//!
//! Tauri copies the staged file next to the app executable under the plain name
//! `patchroom-hook`: `target/<profile>/` in dev and `Contents/MacOS/` in the
//! bundle. The runtime resolver in `src/hook_path.rs` looks there first.
//!
//! The nested cargo build uses its own target dir under `OUT_DIR`, so it never
//! contends for the outer build's lock.

use std::error::Error;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::Command;

fn main() -> Result<(), Box<dyn Error>> {
    stage_hook_sidecar()?;
    tauri_build::build();
    Ok(())
}

fn stage_hook_sidecar() -> Result<(), Box<dyn Error>> {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR")?);
    let root = manifest_dir
        .parent()
        .ok_or("src-tauri has no parent directory")?
        .to_path_buf();
    let target = std::env::var("TARGET")?;
    let profile = std::env::var("PROFILE")?;
    let target_dir = PathBuf::from(std::env::var("OUT_DIR")?).join("hook-target");

    for p in [
        "crates/patchroom-hook",
        "crates/patchroom-bridge",
        "Cargo.lock",
    ] {
        println!("cargo:rerun-if-changed={}", root.join(p).display());
    }

    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
    let mut cmd = Command::new(cargo);
    cmd.args([
        "build",
        "-p",
        "patchroom-hook",
        "--locked",
        "--manifest-path",
    ])
    .arg(root.join("Cargo.toml"))
    .arg("--target-dir")
    .arg(&target_dir)
    .args(["--target", &target]);
    if profile == "release" {
        cmd.arg("--release");
    }
    // Do not inherit the outer build's jobserver or make flags.
    cmd.env_remove("CARGO_MAKEFLAGS")
        .env_remove("MAKEFLAGS")
        .env_remove("MFLAGS");
    let status = cmd.status()?;
    if !status.success() {
        return Err("building the patchroom-hook sidecar failed".into());
    }

    let built = target_dir
        .join(&target)
        .join(if profile == "release" {
            "release"
        } else {
            "debug"
        })
        .join("patchroom-hook");
    let dest_dir = manifest_dir.join("binaries");
    std::fs::create_dir_all(&dest_dir)?;
    let dest = dest_dir.join(format!("patchroom-hook-{target}"));
    let new = std::fs::read(&built)?;
    if std::fs::read(&dest).map_or(true, |old| old != new) {
        std::fs::write(&dest, new)?;
    }
    // The staged copy must be executable: the CLI runs it as a hook command.
    std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755))?;
    Ok(())
}
