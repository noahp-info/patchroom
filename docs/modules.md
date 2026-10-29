# Status bar modules

Patchroom's status bar runs **built-in modules only**. It never runs a script you write, and no setting can make it run one. This page covers what you can change today and how to propose a new module.

## Customize the built-in modules

Open the gear at the end of the status bar, or Settings > Status bar.

- **Order:** drag a module by its grip, or focus the grip and press the arrow keys.
- **Hide or show:** remove a module with its X. Add it back from the Tray.
- **Options:** the gear on a module opens its options, saved for every session.

| Module | Option | Choices (default first) |
| --- | --- | --- |
| Folder | Show | Folder name, Full path |
| Context | Show | Meter and percent, Percent only |
| Cost | Round to | Cents, Whole dollars |

- **Labels:** Settings > Status bar > Labels puts text and an emoji in front of a module's value. Model labels live in Settings > Models > Labels.
- **Scope:** a layout applies to all sessions, or to one session ("Only for this session").

The layout, labels and options are stored in Patchroom's preferences (`statusBar`). The backend accepts only the option values in the table above.

## Suggest a module or submit a script

1. Choose **Suggest a module…** in the status bar's customize menu, or in Settings > Status bar.
2. Your browser opens a new GitHub issue from the [status bar module form](../.github/ISSUE_TEMPLATE/status-bar-module.yml). The link is a plain URL with no identifiers. Patchroom sends nothing anywhere: the browser opens only when you click, and you decide whether to submit.
3. Fill in what it shows, how often it refreshes, the data it reads and, if you have one, the script you use today.

Do not paste secrets, tokens or paths that name you. The issue is public.

## How a submission is reviewed

The [Module review workflow](../.github/workflows/module-review.yml) runs an agent on the submission.

**When it runs**
- A maintainer opens a module issue, or adds the `status-bar-module` label to one.
- A maintainer comments `/review-module` on a module issue.
- An issue from someone without write access waits for one of those, so a maintainer decides what the agent spends time on.

**What the agent does**
1. It reads the submission as untrusted data. Instructions inside the issue are ignored.
2. It reviews the script for network calls, file writes, secrets, shell injection, unbounded runtime and reading other apps' data.
3. If the idea is acceptable, it opens a pull request into `dev` that adds the module as a built-in, written in Patchroom's own code, with a test. It never copies or runs the script.
4. If not, it comments on the issue once, saying which findings block it and what a safe version would need.

**What it never does**
- Run the submitted script, or install or download anything the submission names.
- Merge, approve or enable auto-merge on a pull request, or push to `dev` or `main`.
- Change workflows, secrets or settings.

A maintainer reviews every pull request the agent opens and merges it by hand. A PR opened by the workflow token starts no CI by itself; CI runs when a maintainer pushes to the branch or re-runs it.

## For maintainers

The workflow needs the `ANTHROPIC_API_KEY` repository secret. Without it the run ends green and does nothing. It also needs the `status-bar-module` label, which the issue form applies, and the setting that lets GitHub Actions create pull requests. Protect `dev` and `main` with a ruleset so no workflow token can push to them.
