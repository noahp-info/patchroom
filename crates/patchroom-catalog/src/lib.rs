//! The model catalog between builds: an opt-in, signed download.
//!
//! Every build ships the latest catalog (`ui/src/lib/models/catalog.json`, refreshed by the
//! weekly `model-catalog` workflow). When the user turns on Settings > Updates > "Check for newer
//! models", the app may also fetch a newer one:
//!
//! * a plain GET of [`CATALOG_URL`] and its detached signature [`SIGNATURE_URL`], through the
//!   system `curl` with no headers beyond its defaults, no cookies and no identifiers;
//! * the signature is ed25519 over the exact catalog bytes, checked against [`PUBLIC_KEY_HEX`]
//!   (embedded at build time) before anything is parsed or stored;
//! * the verified bytes and signature are cached in the data dir and checked again on every load.
//!
//! The private key never lives in the repo or in CI. `patchroom-catalog-sign` makes the key pair
//! and signs a catalog on the owner's machine.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use ed25519_dalek::{Signature, VerifyingKey};
use serde_json::Value;

/// The catalog file. Fixed: the app never fetches from anywhere else.
pub const CATALOG_URL: &str =
    "https://github.com/noahp-info/patchroom/releases/download/model-catalog/models.json";
/// Its detached signature: 128 hex characters (64 bytes), ed25519 over the catalog bytes.
pub const SIGNATURE_URL: &str =
    "https://github.com/noahp-info/patchroom/releases/download/model-catalog/models.json.sig";
/// The public key the signature must verify against, as 64 hex characters.
pub const PUBLIC_KEY_HEX: &str = include_str!("../catalog-key.pub");
/// Largest catalog accepted, in bytes.
pub const MAX_CATALOG_BYTES: usize = 1024 * 1024;
/// Most models in one catalog.
pub const MAX_MODELS: usize = 4000;
/// Longest the download may take.
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(20);

const CACHE_FILE: &str = "model-catalog.json";
const CACHE_SIG: &str = "model-catalog.json.sig";

/// Why a catalog was refused.
#[derive(Debug, PartialEq, Eq)]
pub enum CatalogError {
    /// The download failed.
    Fetch(String),
    /// The signature is missing, malformed or does not match.
    Signature(String),
    /// The bytes are not a catalog.
    Shape(String),
    /// Reading or writing the cache failed.
    Io(String),
}

impl std::fmt::Display for CatalogError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Fetch(m) => write!(f, "could not download the model catalog: {m}"),
            Self::Signature(m) => write!(f, "the model catalog signature is not valid: {m}"),
            Self::Shape(m) => write!(f, "the model catalog is malformed: {m}"),
            Self::Io(m) => write!(f, "could not store the model catalog: {m}"),
        }
    }
}

impl std::error::Error for CatalogError {}

/// Decode hex into exactly `N` bytes.
#[must_use]
pub fn hex_bytes<const N: usize>(s: &str) -> Option<[u8; N]> {
    let s = s.trim();
    if s.len() != N * 2 {
        return None;
    }
    let mut out = [0u8; N];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(s.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}

/// Hex of `bytes`, lowercase.
#[must_use]
pub fn to_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::new(), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}

/// The embedded public key.
///
/// # Errors
/// The embedded key is malformed (a build problem).
pub fn public_key() -> Result<VerifyingKey, CatalogError> {
    key_from_hex(PUBLIC_KEY_HEX)
}

/// A verifying key from 64 hex characters.
///
/// # Errors
/// Not 32 bytes of hex, or not a valid point.
pub fn key_from_hex(hex: &str) -> Result<VerifyingKey, CatalogError> {
    let raw = hex_bytes::<32>(hex).ok_or_else(|| CatalogError::Signature("bad key".into()))?;
    VerifyingKey::from_bytes(&raw).map_err(|e| CatalogError::Signature(e.to_string()))
}

/// Check `sig_hex` over `bytes` with `key`.
///
/// # Errors
/// A malformed or wrong signature.
pub fn verify_with(key: &VerifyingKey, bytes: &[u8], sig_hex: &str) -> Result<(), CatalogError> {
    let raw = hex_bytes::<64>(sig_hex)
        .ok_or_else(|| CatalogError::Signature("expected 128 hex characters".into()))?;
    key.verify_strict(bytes, &Signature::from_bytes(&raw))
        .map_err(|_| CatalogError::Signature("it does not match the catalog".into()))
}

fn shape_err(m: &str) -> CatalogError {
    CatalogError::Shape(m.to_owned())
}

/// Parse and check a catalog: `{schema: 1, generated, tools: [...], models: [...]}` where each
/// model has string `id`, `tool`, `name` and `family`. Unknown fields are kept for the UI.
///
/// # Errors
/// Too large, not JSON, or the wrong shape.
pub fn parse(bytes: &[u8]) -> Result<Value, CatalogError> {
    if bytes.len() > MAX_CATALOG_BYTES {
        return Err(shape_err("too large"));
    }
    let v: Value = serde_json::from_slice(bytes).map_err(|e| shape_err(&e.to_string()))?;
    if v.get("schema").and_then(Value::as_u64) != Some(1) {
        return Err(shape_err("unknown schema"));
    }
    if v.get("generated").and_then(Value::as_str).is_none() {
        return Err(shape_err("no generated date"));
    }
    let models = v
        .get("models")
        .and_then(Value::as_array)
        .ok_or_else(|| shape_err("no models"))?;
    if models.is_empty() || models.len() > MAX_MODELS {
        return Err(shape_err("model count out of range"));
    }
    for m in models {
        for k in ["id", "tool", "name", "family"] {
            let ok = m
                .get(k)
                .and_then(Value::as_str)
                .is_some_and(|s| !s.is_empty() && s.len() <= 128);
            if !ok {
                return Err(shape_err(&format!("a model has no {k}")));
            }
        }
        let id = m.get("id").and_then(Value::as_str).unwrap_or_default();
        if !id.bytes().all(|b| {
            b.is_ascii_alphanumeric()
                || matches!(b, b'.' | b'_' | b'-' | b':' | b'/' | b'@' | b'[' | b']')
        }) || id.starts_with('-')
        {
            return Err(shape_err("a model id has unsafe characters"));
        }
    }
    Ok(v)
}

/// Verify with the embedded key, then parse.
///
/// # Errors
/// As [`verify_with`] and [`parse`].
pub fn verified(bytes: &[u8], sig_hex: &str) -> Result<Value, CatalogError> {
    verify_with(&public_key()?, bytes, sig_hex)?;
    parse(bytes)
}

/// The cached catalog, verified again. `None` when there is none or it no longer verifies.
#[must_use]
pub fn load_cached(data_dir: &Path) -> Option<Value> {
    let bytes = std::fs::read(data_dir.join(CACHE_FILE)).ok()?;
    let sig = std::fs::read_to_string(data_dir.join(CACHE_SIG)).ok()?;
    verified(&bytes, &sig).ok()
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), CatalogError> {
    use std::io::Write as _;
    use std::os::unix::fs::OpenOptionsExt as _;
    let tmp = path.with_extension("tmp");
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)
        .map_err(|e| CatalogError::Io(e.to_string()))?;
    f.write_all(bytes)
        .map_err(|e| CatalogError::Io(e.to_string()))?;
    std::fs::rename(&tmp, path).map_err(|e| CatalogError::Io(e.to_string()))
}

/// Store verified bytes and their signature in the data dir.
///
/// # Errors
/// The bytes do not verify, or a write failed.
pub fn store(data_dir: &Path, bytes: &[u8], sig_hex: &str) -> Result<Value, CatalogError> {
    let v = verified(bytes, sig_hex)?;
    std::fs::create_dir_all(data_dir).map_err(|e| CatalogError::Io(e.to_string()))?;
    write_private(&data_dir.join(CACHE_FILE), bytes)?;
    write_private(&data_dir.join(CACHE_SIG), sig_hex.trim().as_bytes())?;
    Ok(v)
}

/// A plain GET through the system curl: https only, redirects followed (GitHub release assets
/// redirect to their CDN), no cookies, no extra headers, size and time bounded.
///
/// # Errors
/// curl could not run, or the request failed.
pub fn https_get(url: &str, curl: &Path) -> Result<Vec<u8>, CatalogError> {
    if !url.starts_with("https://") {
        return Err(CatalogError::Fetch("https only".into()));
    }
    let out = Command::new(curl)
        .args([
            "--fail",
            "--silent",
            "--show-error",
            "--location",
            "--proto",
            "=https",
            "--proto-redir",
            "=https",
            "--max-redirs",
            "5",
            "--max-filesize",
            &MAX_CATALOG_BYTES.to_string(),
            "--max-time",
            &FETCH_TIMEOUT.as_secs().to_string(),
            "--",
            url,
        ])
        .output()
        .map_err(|e| CatalogError::Fetch(e.to_string()))?;
    if !out.status.success() {
        let why = String::from_utf8_lossy(&out.stderr).trim().to_owned();
        return Err(CatalogError::Fetch(if why.is_empty() {
            format!("curl exited {}", out.status)
        } else {
            why
        }));
    }
    Ok(out.stdout)
}

/// The system curl (`/usr/bin/curl` on macOS).
#[must_use]
pub fn system_curl() -> PathBuf {
    PathBuf::from("/usr/bin/curl")
}

/// Download, verify and cache the catalog. Call this only when the user turned the check on.
///
/// # Errors
/// The download failed, or the catalog does not verify or parse.
pub fn fetch(data_dir: &Path, curl: &Path) -> Result<Value, CatalogError> {
    let bytes = https_get(CATALOG_URL, curl)?;
    let sig = https_get(SIGNATURE_URL, curl)?;
    let sig = String::from_utf8(sig).map_err(|_| CatalogError::Signature("not text".into()))?;
    store(data_dir, &bytes, &sig)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn catalog() -> Vec<u8> {
        br#"{"schema":1,"generated":"2026-10-25","tools":[],"models":[
            {"id":"claude-opus-5-5","tool":"claude-code","name":"Opus 5.5","family":"opus"}]}"#
            .to_vec()
    }

    fn test_key() -> SigningKey {
        SigningKey::from_bytes(&[7u8; 32])
    }

    #[test]
    fn the_embedded_public_key_is_valid() {
        assert!(public_key().is_ok());
    }

    #[test]
    fn hex_round_trips() {
        let b = [0u8, 1, 0xab, 0xff];
        assert_eq!(hex_bytes::<4>(&to_hex(&b)), Some(b));
        assert_eq!(hex_bytes::<4>("00"), None);
        assert_eq!(hex_bytes::<1>("zz"), None);
    }

    #[test]
    fn a_good_signature_verifies_and_any_change_fails() {
        let k = test_key();
        let bytes = catalog();
        let sig = to_hex(&k.sign(&bytes).to_bytes());
        let vk = k.verifying_key();
        assert!(verify_with(&vk, &bytes, &sig).is_ok());
        let mut tampered = bytes.clone();
        tampered[20] ^= 1;
        assert!(verify_with(&vk, &tampered, &sig).is_err());
        let other = SigningKey::from_bytes(&[9u8; 32]).verifying_key();
        assert!(verify_with(&other, &bytes, &sig).is_err());
        assert!(verify_with(&vk, &bytes, "abcd").is_err());
        // The embedded key did not sign this test catalog.
        assert!(verified(&bytes, &sig).is_err());
    }

    #[test]
    fn shapes_are_checked() {
        assert!(parse(&catalog()).is_ok());
        for bad in [
            &b"nope"[..],
            br#"{"schema":2,"generated":"x","models":[{"id":"a","tool":"t","name":"n","family":"f"}]}"#,
            br#"{"schema":1,"models":[{"id":"a","tool":"t","name":"n","family":"f"}]}"#,
            br#"{"schema":1,"generated":"x","models":[]}"#,
            br#"{"schema":1,"generated":"x","models":[{"id":"a","tool":"t","name":"n"}]}"#,
            br#"{"schema":1,"generated":"x","models":[{"id":"a b","tool":"t","name":"n","family":"f"}]}"#,
            br#"{"schema":1,"generated":"x","models":[{"id":"--x","tool":"t","name":"n","family":"f"}]}"#,
        ] {
            assert!(parse(bad).is_err(), "{}", String::from_utf8_lossy(bad));
        }
        assert!(parse(&vec![b' '; MAX_CATALOG_BYTES + 1]).is_err());
    }

    #[test]
    fn the_cache_refuses_what_does_not_verify() {
        let dir = tempfile::tempdir().unwrap();
        assert!(load_cached(dir.path()).is_none());
        // Bytes signed by some other key are never written.
        let bytes = catalog();
        let sig = to_hex(&test_key().sign(&bytes).to_bytes());
        assert!(store(dir.path(), &bytes, &sig).is_err());
        assert!(!dir.path().join(CACHE_FILE).exists());
        // A planted file that does not verify is ignored on load.
        std::fs::write(dir.path().join(CACHE_FILE), &bytes).unwrap();
        std::fs::write(dir.path().join(CACHE_SIG), &sig).unwrap();
        assert!(load_cached(dir.path()).is_none());
    }

    #[test]
    fn a_failed_download_is_an_error_not_a_panic() {
        let dir = tempfile::tempdir().unwrap();
        let r = fetch(dir.path(), Path::new("/nonexistent/curl"));
        assert!(matches!(r, Err(CatalogError::Fetch(_))));
    }

    #[test]
    fn the_urls_are_fixed_https_on_the_project() {
        for u in [CATALOG_URL, SIGNATURE_URL] {
            assert!(u.starts_with("https://github.com/noahp-info/patchroom/releases/download/"));
        }
    }
}
