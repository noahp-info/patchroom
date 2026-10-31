//! Test-only: write an executable stub without holding a write handle to it in this process.
//! See `tests/common/mod.rs` for why (ETXTBSY when a sibling test thread forks).

use std::path::Path;
use std::process::Command;

pub(crate) fn write_exe(path: &Path, body: &str) {
    let src = path.with_extension("src");
    std::fs::write(&src, body).unwrap();
    let ok = Command::new("install")
        .args(["-m", "755"])
        .arg(&src)
        .arg(path)
        .status()
        .unwrap()
        .success();
    assert!(ok, "install {}", path.display());
    let _ = std::fs::remove_file(&src);
}
