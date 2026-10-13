//! `patchroom-hook`: forwards hook JSON from a CLI to the Patchroom bridge socket.
//!
//! Stub. The final version reads hook JSON on stdin, sends it to the bridge unix socket,
//! and prints the bridge's decision (if any) to stdout. With no bridge reachable it must
//! print nothing and exit 0, so the CLI's own TUI decides (fail open).

use std::io::Read;
use std::process::ExitCode;

fn main() -> ExitCode {
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        return ExitCode::SUCCESS;
    }
    // TODO(P1): connect to the bridge socket and relay `input`; fail open on any error.
    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    #[test]
    fn stub_builds() {}
}
