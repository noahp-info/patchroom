//! `paste_image`: clipboard images become files whose absolute path the composer inserts.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;

use super::{Error, Manager, Result};

/// Largest accepted image, in decoded bytes.
pub(super) const MAX_BYTES: usize = 20 * 1024 * 1024;
/// Paste files older than this are removed on startup.
pub(super) const MAX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);

fn extension_for(media_type: &str) -> Option<&'static str> {
    match media_type.trim().to_ascii_lowercase().as_str() {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpeg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        _ => None,
    }
}

/// Write the decoded image under `<data_dir>/pastes/` and return its absolute path.
pub(super) fn write_paste(data_dir: &Path, data: &str, media_type: &str) -> Result<PathBuf> {
    let ext = extension_for(media_type)
        .ok_or_else(|| Error::Invalid(format!("unsupported image type {media_type:?}")))?;
    // Base64 expands by 4/3: refuse before decoding anything huge.
    if data.len() > MAX_BYTES / 3 * 4 + 8 {
        return Err(Error::Invalid("image is larger than 20 MB".into()));
    }
    let bytes = B64
        .decode(data.trim())
        .map_err(|e| Error::Invalid(format!("image data is not base64: {e}")))?;
    if bytes.is_empty() {
        return Err(Error::Invalid("image is empty".into()));
    }
    if bytes.len() > MAX_BYTES {
        return Err(Error::Invalid("image is larger than 20 MB".into()));
    }
    let dir = data_dir.join("pastes");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{}.{ext}", ulid::Ulid::generate()));
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(&path)?;
    f.write_all(&bytes)?;
    f.flush()?;
    Ok(std::fs::canonicalize(&path).unwrap_or(path))
}

/// Remove paste files older than `max_age`. Errors are ignored: this is housekeeping.
pub(super) fn prune_old(data_dir: &Path, max_age: Duration) {
    let Ok(rd) = std::fs::read_dir(data_dir.join("pastes")) else {
        return;
    };
    let now = SystemTime::now();
    for e in rd.flatten() {
        let Ok(meta) = e.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let old = meta
            .modified()
            .ok()
            .and_then(|m| now.duration_since(m).ok())
            .is_some_and(|age| age > max_age);
        if old {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

impl Manager {
    /// `paste_image {id, data, mediaType}`: returns the absolute path of the new file.
    ///
    /// # Errors
    /// Unknown id, unsupported type, bad base64, oversize image or I/O failure.
    pub fn paste_image(&self, id: &str, data: &str, media_type: &str) -> Result<String> {
        self.conversation(id)?;
        let path = write_paste(&self.cfg.data_dir, data, media_type)?;
        Ok(path.to_string_lossy().into_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nsynthetic";

    #[test]
    fn writes_a_0600_file_with_the_right_extension() {
        let d = tempfile::tempdir().unwrap();
        for (mt, ext) in [
            ("image/png", "png"),
            ("image/jpeg", "jpeg"),
            ("image/gif", "gif"),
            ("image/webp", "webp"),
        ] {
            let p = write_paste(d.path(), &B64.encode(PNG), mt).unwrap();
            assert!(p.is_absolute());
            assert_eq!(p.extension().unwrap(), ext);
            assert!(p.starts_with(std::fs::canonicalize(d.path()).unwrap().join("pastes")));
            assert_eq!(std::fs::read(&p).unwrap(), PNG);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = std::fs::metadata(&p).unwrap().permissions().mode();
                assert_eq!(mode & 0o777, 0o600);
            }
            assert_eq!(p.file_stem().unwrap().len(), 26, "ULID name");
        }
    }

    #[test]
    fn rejects_non_images_and_bad_data() {
        let d = tempfile::tempdir().unwrap();
        for mt in ["text/plain", "image/svg+xml", "application/pdf", ""] {
            assert!(write_paste(d.path(), &B64.encode(PNG), mt).is_err(), "{mt}");
        }
        assert!(write_paste(d.path(), "!!not base64!!", "image/png").is_err());
        assert!(write_paste(d.path(), "", "image/png").is_err());
        assert!(!d.path().join("pastes").exists());
    }

    #[test]
    fn caps_the_size_at_20_mb() {
        let d = tempfile::tempdir().unwrap();
        let ok = vec![1u8; MAX_BYTES];
        assert!(write_paste(d.path(), &B64.encode(&ok), "image/png").is_ok());
        let big = vec![1u8; MAX_BYTES + 1];
        assert!(write_paste(d.path(), &B64.encode(&big), "image/png").is_err());
    }

    #[test]
    fn prune_removes_only_old_files() {
        let d = tempfile::tempdir().unwrap();
        let fresh = write_paste(d.path(), &B64.encode(PNG), "image/png").unwrap();
        let old = write_paste(d.path(), &B64.encode(PNG), "image/gif").unwrap();
        let f = std::fs::File::options().write(true).open(&old).unwrap();
        f.set_modified(SystemTime::now() - Duration::from_secs(8 * 24 * 3600))
            .unwrap();
        prune_old(d.path(), MAX_AGE);
        assert!(fresh.exists());
        assert!(!old.exists());
    }
}
