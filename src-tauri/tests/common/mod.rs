//! Helpers shared by the integration tests.

use std::path::Path;
use std::process::Command;

/// Write an executable stub without this process ever holding a write handle to it.
///
/// Tests run on many threads. A thread that forks while another holds the stub open for writing
/// passes that handle to its child until the child execs, and running the stub in that window
/// fails with ETXTBSY ("Text file busy"). `install` creates the stub in its own process, so no
/// fork here can inherit a write handle to it.
#[allow(dead_code)]
pub fn write_exe(path: &Path, body: &str) {
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
