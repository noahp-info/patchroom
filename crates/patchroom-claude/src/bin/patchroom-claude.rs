//! `patchroom-claude dump <transcript.jsonl>`: print chat items and line accounting.
//!
//! stdout: `{"items": [...], "accounting": {"lines","items","hidden","fallback","errors"}}`.
//! stderr: `lines=N items=I hidden=H fallback=F errors=E`, then the hidden reasons and the
//! fallback line types with counts. Exit code 0 on success, 2 on bad usage, 1 when the
//! file cannot be read.

use std::io::Write;
use std::path::Path;
use std::process::ExitCode;

use patchroom_claude::dump::dump_file;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [cmd, file] = args.as_slice() else {
        eprintln!("usage: patchroom-claude dump <transcript.jsonl>");
        return ExitCode::from(2);
    };
    if cmd != "dump" {
        eprintln!("unknown command {cmd:?}; usage: patchroom-claude dump <transcript.jsonl>");
        return ExitCode::from(2);
    }
    let dump = match dump_file(Path::new(file)) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("patchroom-claude: cannot read {file}: {e}");
            return ExitCode::from(1);
        }
    };
    let mut out = std::io::stdout().lock();
    if serde_json::to_writer(&mut out, &dump).is_err() || writeln!(out).is_err() {
        return ExitCode::from(1);
    }
    eprintln!("{}", dump.accounting_line());
    for (reason, n) in &dump.hidden_reasons {
        eprintln!("hidden  {n:>6}  {reason}");
    }
    for (ty, n) in &dump.fallback_types {
        eprintln!("fallback {n:>5}  {ty}");
    }
    ExitCode::SUCCESS
}
