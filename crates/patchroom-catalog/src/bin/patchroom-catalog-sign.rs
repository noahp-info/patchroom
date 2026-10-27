//! `patchroom-catalog-sign`: the owner's tool for the signed model catalog. Runs on the owner's
//! machine only; the private key never enters the repo or CI.
//!
//! ```text
//! patchroom-catalog-sign keygen <private-key-file> <public-key-file>
//! patchroom-catalog-sign sign <private-key-file> <catalog.json>        # writes <catalog.json>.sig
//! patchroom-catalog-sign verify <public-key-file> <catalog.json> <sig>
//! ```
//!
//! Key files hold 64 hex characters. `keygen` writes the private key with mode 0600 and refuses
//! to overwrite either file. Copy the public key into `crates/patchroom-catalog/catalog-key.pub`.

use std::io::{Read as _, Write as _};
use std::os::unix::fs::OpenOptionsExt as _;
use std::process::ExitCode;

use ed25519_dalek::{Signer as _, SigningKey};
use patchroom_catalog::{hex_bytes, key_from_hex, parse, to_hex, verify_with};

fn write_new(path: &str, text: &str, mode: u32) -> Result<(), String> {
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .open(path)
        .map_err(|e| format!("{path}: {e}"))?;
    f.write_all(text.as_bytes())
        .map_err(|e| format!("{path}: {e}"))
}

fn read(path: &str) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| format!("{path}: {e}"))
}

fn signing_key(path: &str) -> Result<SigningKey, String> {
    let text = String::from_utf8(read(path)?).map_err(|_| format!("{path}: not text"))?;
    let seed = hex_bytes::<32>(&text).ok_or_else(|| format!("{path}: expected 64 hex"))?;
    Ok(SigningKey::from_bytes(&seed))
}

fn run(args: &[String]) -> Result<(), String> {
    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["keygen", private, public] => {
            let mut seed = [0u8; 32];
            std::fs::File::open("/dev/urandom")
                .and_then(|mut f| f.read_exact(&mut seed))
                .map_err(|e| format!("/dev/urandom: {e}"))?;
            let key = SigningKey::from_bytes(&seed);
            write_new(private, &format!("{}\n", to_hex(&seed)), 0o600)?;
            write_new(
                public,
                &format!("{}\n", to_hex(key.verifying_key().as_bytes())),
                0o644,
            )?;
            println!("wrote {private} (keep it private) and {public}");
            Ok(())
        }
        ["sign", private, catalog] => {
            let key = signing_key(private)?;
            let bytes = read(catalog)?;
            parse(&bytes).map_err(|e| e.to_string())?;
            let sig = to_hex(&key.sign(&bytes).to_bytes());
            let out = format!("{catalog}.sig");
            std::fs::write(&out, format!("{sig}\n")).map_err(|e| format!("{out}: {e}"))?;
            verify_with(&key.verifying_key(), &bytes, &sig).map_err(|e| e.to_string())?;
            println!("wrote {out}");
            Ok(())
        }
        ["verify", public, catalog, sig] => {
            let text = String::from_utf8(read(public)?).map_err(|_| "key: not text")?;
            let key = key_from_hex(&text).map_err(|e| e.to_string())?;
            let sig = String::from_utf8(read(sig)?).map_err(|_| "sig: not text")?;
            verify_with(&key, &read(catalog)?, &sig).map_err(|e| e.to_string())?;
            println!("ok");
            Ok(())
        }
        _ => Err("usage: patchroom-catalog-sign keygen <priv> <pub> | sign <priv> <catalog.json> | verify <pub> <catalog.json> <sig>".into()),
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("patchroom-catalog-sign: {e}");
            ExitCode::FAILURE
        }
    }
}
