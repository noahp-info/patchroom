# Security policy

## Scope and posture

Patchroom is a local-only desktop app. It runs AI coding CLIs as the user, exactly as a terminal does, and grants nothing the terminal does not. See [docs/SPEC.md](docs/SPEC.md) section 4.

- No TCP listeners. The hook bridge is a unix socket (`0600`) in the user's Application Support folder.
- No telemetry.
- Patchroom never writes the user's CLI settings. Hooks are injected per launch.
- Patchroom never stores secrets. The in-app claude.ai cookie store is the only credential state.
- Plugins run in sandboxed webviews with declared capabilities. No native plugin code.

## Reporting a vulnerability

Use GitHub private vulnerability reporting: open the **Security** tab of this repository and choose **Report a vulnerability**. Do not open a public issue for a security problem.

Include the affected version or commit, reproduction steps, and the impact you see. Expect an acknowledgement within a few days. This is a volunteer project with no bug bounty.

## Repo practices

- Secrets are scanned with gitleaks on every commit (local hook) and every push (CI). See `.gitleaks.toml`.
- Every gitleaks allowlist entry needs a comment saying why it is a confirmed false positive.
- Dependabot opens weekly update PRs for cargo, npm, and GitHub Actions against `dev`.
- If a secret is ever committed, rotate it first. Deleting the commit is not enough.
