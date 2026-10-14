//! Terminal-only waits and the send outcome.
//!
//! Claude sometimes waits on something the chat cannot render: a trust dialog, a `/usage`
//! panel, a menu, a permission dialog whose hook never reached the bridge. The composer's
//! text would land in that dialog. This module notices the wait and says so:
//! - `session:terminal_wait {id, reason, since}` when it begins (and when `reason` changes),
//!   `session:terminal_wait_clear {id}` when it ends. `SessionInfo.terminalWait` holds the same
//!   state for a UI that reloads;
//! - the DM gets the persisted needs-you flag, so the sidebar, notifications and
//!   `activity_list` ("Waiting for you") follow;
//! - `session_send_text` refuses to write while it lasts and returns a typed [`SendOutcome`].
//!
//! Two sources feed it, checked every [`super::WAIT_TICK`] with a debounce:
//! 1. the emulated screen shows a dialog footer (`Esc to cancel`, `Enter to confirm`, a
//!    numbered option list) and the chat holds no prompt for it;
//! 2. presence is `waiting` and the reconciler's `claude agents --json` confirms it, with no
//!    chat prompt open and no prompt just answered here (`waitingFor` becomes the reason).
//!
//! # Locks
//! `Manager::waits` is a leaf: never held across a presence, store, chat or sink call.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;

use super::{lock, Live, Manager, PresenceStatus, Result, UiEvent};
use crate::events::Needs;

/// A dialog footer must stay on screen this long before it counts.
const SCREEN_GRACE: Duration = Duration::from_millis(400);
/// A `waiting` status the chat shows nothing for must last this long (a permission prompt
/// needs about a second to reach the chat).
const PRESENCE_GRACE: Duration = Duration::from_millis(1500);
/// A wait must be gone this long before it clears (the TUI repaints in steps).
const CLEAR_GRACE: Duration = Duration::from_millis(600);
/// How fresh the reconciler's `claude agents --json` answer must be to confirm a wait.
const AGENTS_MAX_AGE: Duration = Duration::from_secs(40);
/// The reason when nothing more specific is known.
const GENERIC_REASON: &str = "dialog open";

/// The terminal-only wait of a DM, as `SessionInfo.terminalWait` reports it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TerminalWaitInfo {
    /// What claude waits for, for example `dialog open`.
    pub reason: String,
    /// When the wait began, epoch milliseconds.
    pub since: i64,
}

/// The result of `session_send_text`. Nothing is swallowed: every call says what happened.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum SendOutcome {
    /// Written to the terminal; claude was idle.
    Sent,
    /// Written to the terminal while claude was busy; it reads it after the turn.
    Queued,
    /// Not written: a dialog only the terminal can answer is open. Keep the draft and offer
    /// the terminal.
    BlockedDialog {
        /// What claude waits for.
        reason: String,
    },
    /// Not written: this DM only mirrors a session running in another terminal.
    MirrorReadonly {
        /// Where it runs.
        #[serde(rename = "where")]
        place: String,
        /// The other process.
        pid: u32,
    },
}

/// What one evaluation looks at.
#[derive(Debug, Clone, Default)]
pub(super) struct Inputs {
    /// The chat holds a prompt (announced or not): it is the chat's to show.
    pub prompt_open: bool,
    /// The emulated screen shows a dialog.
    pub screen_dialog: bool,
    /// Presence is `waiting`.
    pub presence_waiting: bool,
    /// Why presence waits, when no better text is known.
    pub needs: Option<Needs>,
    /// The reconciler's latest answer says this session waits.
    pub agents_waiting: bool,
    /// Its `waitingFor` text.
    pub agents_reason: Option<String>,
    /// When a chat prompt of this DM last resolved, epoch milliseconds (0: never).
    pub last_resolved_ms: i64,
}

/// What a step decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Step {
    /// No change.
    Hold,
    /// The wait began.
    Raise { reason: String, since: i64 },
    /// The wait goes on with another reason.
    Update { reason: String, since: i64 },
    /// The wait ended.
    Clear,
}

/// Debounce state of one DM.
#[derive(Debug, Default)]
pub(super) struct WaitTrack {
    pub(super) active: Option<TerminalWaitInfo>,
    /// The candidate's first sighting.
    seen: Option<Instant>,
    /// The candidate's absence began.
    gone: Option<Instant>,
    /// When presence turned `waiting` (epoch ms), for "answered here".
    presence_since_ms: Option<i64>,
}

impl WaitTrack {
    /// Advance the state machine by one evaluation.
    pub(super) fn step(&mut self, now: Instant, now_ms: i64, i: &Inputs) -> Step {
        if i.presence_waiting {
            self.presence_since_ms.get_or_insert(now_ms);
        } else {
            self.presence_since_ms = None;
        }
        let cand = candidate(i, self.presence_since_ms);
        let Some((reason, grace)) = cand else {
            self.seen = None;
            if self.active.is_none() {
                self.gone = None;
                return Step::Hold;
            }
            let since = *self.gone.get_or_insert(now);
            if now.duration_since(since) >= CLEAR_GRACE {
                self.active = None;
                self.gone = None;
                return Step::Clear;
            }
            return Step::Hold;
        };
        self.gone = None;
        let first = *self.seen.get_or_insert(now);
        if let Some(a) = &mut self.active {
            if a.reason == reason {
                return Step::Hold;
            }
            a.reason.clone_from(&reason);
            return Step::Update {
                reason,
                since: a.since,
            };
        }
        let waited = now.duration_since(first);
        if waited < grace {
            return Step::Hold;
        }
        let since = now_ms - i64::try_from(waited.as_millis()).unwrap_or(0);
        self.active = Some(TerminalWaitInfo {
            reason: reason.clone(),
            since,
        });
        Step::Raise { reason, since }
    }
}

/// The wait the inputs describe, and how long it must hold before it counts.
fn candidate(i: &Inputs, presence_since_ms: Option<i64>) -> Option<(String, Duration)> {
    if i.prompt_open {
        return None;
    }
    let reason = || {
        i.agents_reason
            .clone()
            .filter(|r| !r.trim().is_empty())
            .unwrap_or_else(|| needs_reason(i.needs).to_owned())
    };
    if i.screen_dialog {
        return Some((reason(), SCREEN_GRACE));
    }
    // A prompt answered in the chat leaves presence `waiting` until the tool finishes.
    let answered_here =
        presence_since_ms.is_some_and(|s| i.last_resolved_ms > 0 && i.last_resolved_ms >= s);
    if i.presence_waiting && i.agents_waiting && !answered_here {
        return Some((reason(), PRESENCE_GRACE));
    }
    None
}

fn needs_reason(n: Option<Needs>) -> &'static str {
    match n {
        Some(Needs::Permission) => "permission prompt",
        Some(Needs::Question) => "input needed",
        _ => GENERIC_REASON,
    }
}

/// Phrases of the footers claude draws under a dialog or menu.
const DIALOG_FOOTERS: &[&str] = &[
    "esc to cancel",
    "esc to exit",
    "esc to close",
    "esc to go back",
    "enter to confirm",
    "enter to select",
    "enter to continue",
    "press enter to continue",
];

/// Does the screen show a dialog the chat cannot render?
///
/// Looks at the bottom of the screen only (a dialog sits under the conversation, so a
/// message that merely quotes "Esc to cancel" above it does not count) and ignores the busy
/// footer (`esc to interrupt`).
pub(super) fn dialog_on_screen(screen_text: &str) -> bool {
    let lines: Vec<String> = screen_text
        .lines()
        .map(|l| l.trim().to_lowercase())
        .filter(|l| !l.is_empty())
        .collect();
    let tail = &lines[lines.len().saturating_sub(14)..];
    if tail.iter().any(|l| l.contains("esc to interrupt")) {
        return false;
    }
    if tail
        .iter()
        .any(|l| l.chars().count() <= 100 && DIALOG_FOOTERS.iter().any(|f| l.contains(f)))
    {
        return true;
    }
    // A cursor-marked, numbered option list: `❯ 1. Yes` then `2. No`.
    let numbered = |l: &str| {
        let t = l.trim_start_matches(['❯', '›', ' ']);
        t.split_once('.')
            .is_some_and(|(n, rest)| n.parse::<u32>().is_ok() && rest.starts_with(' '))
    };
    let marked = tail
        .iter()
        .any(|l| l.starts_with(['❯', '›']) && numbered(l));
    marked && tail.iter().filter(|l| numbered(l)).count() >= 2
}

impl Manager {
    /// What `terminalWait` says for a DM now.
    pub(super) fn terminal_wait_of(&self, id: &str) -> Option<TerminalWaitInfo> {
        lock(&self.waits).get(id).and_then(|w| w.active.clone())
    }

    /// `session_send_text {id, text} -> {outcome, ...}`: bracketed paste, then Enter after
    /// the PTY crate's delay, queued behind earlier writes. Writes nothing while a
    /// terminal-only dialog is up or when the DM is a mirror.
    ///
    /// # Errors
    /// Unknown id or exited session.
    pub fn send_text(&self, id: &str, text: String) -> Result<SendOutcome> {
        if let Some(m) = self.mirror_of(id) {
            return Ok(SendOutcome::MirrorReadonly {
                place: m.place,
                pid: m.pid,
            });
        }
        let live = self.live_of(id)?;
        if live.pty.exit_info().is_some() {
            return Err(super::Error::Invalid("session has exited".into()));
        }
        if let Some(reason) = self.dialog_block(id, &live) {
            return Ok(SendOutcome::BlockedDialog { reason });
        }
        let busy = lock(&self.presence)
            .get(id)
            .is_some_and(|p| p.status == PresenceStatus::Busy);
        self.enqueue(id, super::WriteJob::Text(text))?;
        Ok(if busy {
            SendOutcome::Queued
        } else {
            SendOutcome::Sent
        })
    }

    /// Why composer text must not be written now, if it must not. Checks the screen
    /// directly as well as the debounced state, so a dialog that opened a moment ago still
    /// blocks.
    fn dialog_block(&self, id: &str, live: &Live) -> Option<String> {
        if let Some(w) = self.terminal_wait_of(id) {
            return Some(w.reason);
        }
        let screen = live.screen.as_ref()?;
        if self.chat_of(id).is_some_and(|c| c.has_prompts()) {
            return None;
        }
        dialog_on_screen(&screen_text(screen)).then(|| GENERIC_REASON.to_owned())
    }

    /// One evaluation of every live claude DM. Runs from the bridge thread.
    pub(super) fn terminal_wait_tick(self: &Arc<Self>) {
        let lives: Vec<(String, Arc<Live>)> = lock(&self.live)
            .iter()
            .filter(|(_, l)| l.screen.is_some() && l.pty.exit_info().is_none())
            .map(|(k, v)| (k.clone(), Arc::clone(v)))
            .collect();
        let now = Instant::now();
        let now_ms = super::chat::now_ms();
        let agents = self.agents_tap.recent(AGENTS_MAX_AGE);
        let mut seen = HashSet::new();
        for (id, live) in &lives {
            seen.insert(id.clone());
            let inputs = self.wait_inputs(id, live, agents.as_deref());
            let step = lock(&self.waits)
                .entry(id.clone())
                .or_default()
                .step(now, now_ms, &inputs);
            self.apply_wait_step(id, &step, &inputs);
        }
        // Sessions that ended or were deleted: whatever they waited on is gone.
        let gone: Vec<String> = lock(&self.waits)
            .keys()
            .filter(|k| !seen.contains(*k))
            .cloned()
            .collect();
        for id in gone {
            let was = lock(&self.waits)
                .remove(&id)
                .is_some_and(|w| w.active.is_some());
            if was {
                self.sink
                    .emit(UiEvent::TerminalWaitClear { id: id.clone() });
                self.drop_wait_needs(&id);
            }
        }
    }

    fn wait_inputs(
        &self,
        id: &str,
        live: &Live,
        agents: Option<&[patchroom_bridge::AgentEntry]>,
    ) -> Inputs {
        let chat = self.chat_of(id);
        let (status, needs, sid) = lock(&self.presence)
            .get(id)
            .map_or((PresenceStatus::Idle, None, None), |p| {
                (p.status, p.needs, p.claude_sid.clone())
            });
        let pid = live.pty.pid();
        let entry = agents.and_then(|all| {
            all.iter()
                .find(|e| (sid.is_some() && e.session_id == sid) || (e.pid != 0 && e.pid == pid))
        });
        let screen_dialog = live
            .screen
            .as_ref()
            .is_some_and(|s| dialog_on_screen(&screen_text(s)));
        Inputs {
            prompt_open: chat.as_ref().is_some_and(|c| c.has_prompts()),
            screen_dialog,
            presence_waiting: status == PresenceStatus::Waiting,
            needs,
            agents_waiting: entry.is_some_and(|e| e.status == "waiting"),
            agents_reason: entry.and_then(|e| e.waiting_for.clone()),
            last_resolved_ms: chat.as_ref().map_or(0, |c| c.last_resolved_ms()),
        }
    }

    fn apply_wait_step(&self, id: &str, step: &Step, inputs: &Inputs) {
        match step {
            Step::Raise { reason, since } => {
                self.sink.emit(UiEvent::TerminalWait {
                    id: id.to_owned(),
                    reason: reason.clone(),
                    since: *since,
                });
                // Presence `waiting` already carries needs-you; a dialog the hooks never
                // reported needs the flag set here.
                if !inputs.presence_waiting {
                    self.note_needs_you(id, true);
                }
            }
            Step::Update { reason, since } => self.sink.emit(UiEvent::TerminalWait {
                id: id.to_owned(),
                reason: reason.clone(),
                since: *since,
            }),
            Step::Clear => {
                self.sink
                    .emit(UiEvent::TerminalWaitClear { id: id.to_owned() });
                if !inputs.presence_waiting {
                    self.note_needs_you(id, false);
                }
            }
            Step::Hold => {
                // A hook (Idle, Busy) clears the flag while the dialog is still up: put it back.
                if !inputs.presence_waiting && self.terminal_wait_of(id).is_some() {
                    self.note_needs_you(id, true);
                }
            }
        }
    }

    /// A wait ended because its session is gone: clear the flag unless presence owns it.
    fn drop_wait_needs(&self, id: &str) {
        let waiting = lock(&self.presence)
            .get(id)
            .is_some_and(|p| p.status == PresenceStatus::Waiting);
        if !waiting {
            self.note_needs_you(id, false);
        }
    }

    /// Forget a DM's wait when it is deleted.
    pub(super) fn drop_wait(&self, id: &str) {
        let was = lock(&self.waits)
            .remove(id)
            .is_some_and(|w| w.active.is_some());
        if was {
            self.sink
                .emit(UiEvent::TerminalWaitClear { id: id.to_owned() });
        }
    }
}

fn screen_text(screen: &std::sync::Mutex<super::chat::Screen>) -> String {
    lock(screen).text()
}

#[cfg(test)]
mod tests {
    use super::*;

    const MENU: &str = "Settings\n\n\u{276f} 1. Haiku\n  2. Sonnet\n  3. Opus\n\nEnter to confirm \u{b7} Esc to cancel\n";

    #[test]
    fn dialogs_are_told_from_the_normal_ui() {
        assert!(dialog_on_screen(MENU));
        assert!(dialog_on_screen(
            "Usage\n\n  Current session  12%\n\nEsc to cancel"
        ));
        assert!(dialog_on_screen(
            "Do you trust the files in this folder?\n\u{276f} 1. Yes, proceed\n  2. No, exit\n"
        ));
        // The idle composer and the busy spinner are not dialogs.
        assert!(!dialog_on_screen("> \n  ? for shortcuts"));
        assert!(!dialog_on_screen(
            "\u{23fa} thinking\n\u{2736} Working\u{2026} (esc to interrupt)\n"
        ));
        assert!(!dialog_on_screen(""));
        // A message that quotes the phrase far above the footer does not count.
        let mut long = String::from("the footer says Esc to cancel here\n");
        for i in 0..20 {
            long.push_str(&format!("line {i}\n"));
        }
        long.push_str("> \n");
        assert!(!dialog_on_screen(&long));
        // A numbered list without a cursor marker is just text.
        assert!(!dialog_on_screen("1. one\n2. two\n3. three\n"));
    }

    fn waiting_dialog() -> Inputs {
        Inputs {
            screen_dialog: true,
            ..Inputs::default()
        }
    }

    #[test]
    fn a_dialog_raises_after_the_grace_and_clears_after_it_leaves() {
        let mut w = WaitTrack::default();
        let t0 = Instant::now();
        let ms = |d: u64| 10_000 + i64::try_from(d).unwrap();
        assert_eq!(w.step(t0, ms(0), &waiting_dialog()), Step::Hold);
        let t1 = t0 + Duration::from_millis(450);
        let Step::Raise { reason, since } = w.step(t1, ms(450), &waiting_dialog()) else {
            panic!("expected a raise");
        };
        assert_eq!(reason, GENERIC_REASON);
        assert_eq!(since, 10_000);
        assert_eq!(
            w.step(t1 + Duration::from_millis(50), ms(500), &waiting_dialog()),
            Step::Hold
        );
        // The dialog flickers off for less than the clear grace: still active.
        let gone = Inputs::default();
        let t2 = t1 + Duration::from_millis(100);
        assert_eq!(w.step(t2, ms(550), &gone), Step::Hold);
        assert_eq!(
            w.step(t2 + Duration::from_millis(200), ms(750), &waiting_dialog()),
            Step::Hold
        );
        assert!(w.active.is_some());
        let t3 = t2 + Duration::from_millis(300);
        assert_eq!(w.step(t3, ms(900), &gone), Step::Hold);
        assert_eq!(
            w.step(t3 + Duration::from_millis(700), ms(1600), &gone),
            Step::Clear
        );
        assert!(w.active.is_none());
    }

    #[test]
    fn a_blip_shorter_than_the_grace_never_raises() {
        let mut w = WaitTrack::default();
        let t0 = Instant::now();
        assert_eq!(w.step(t0, 0, &waiting_dialog()), Step::Hold);
        assert_eq!(
            w.step(t0 + Duration::from_millis(200), 200, &Inputs::default()),
            Step::Hold
        );
        assert_eq!(
            w.step(t0 + Duration::from_millis(500), 500, &waiting_dialog()),
            Step::Hold
        );
        assert!(w.active.is_none());
    }

    #[test]
    fn a_chat_prompt_is_not_a_terminal_wait() {
        let mut w = WaitTrack::default();
        let t0 = Instant::now();
        let i = Inputs {
            prompt_open: true,
            screen_dialog: true,
            presence_waiting: true,
            agents_waiting: true,
            ..Inputs::default()
        };
        assert_eq!(w.step(t0, 0, &i), Step::Hold);
        assert_eq!(w.step(t0 + Duration::from_secs(5), 5000, &i), Step::Hold);
        assert!(w.active.is_none());
    }

    #[test]
    fn waiting_from_the_agents_listing_names_its_reason() {
        let mut w = WaitTrack::default();
        let t0 = Instant::now();
        let i = Inputs {
            presence_waiting: true,
            agents_waiting: true,
            agents_reason: Some("dialog open".into()),
            needs: Some(Needs::Other),
            ..Inputs::default()
        };
        assert_eq!(w.step(t0, 0, &i), Step::Hold);
        let Step::Raise { reason, .. } = w.step(t0 + Duration::from_millis(1600), 1600, &i) else {
            panic!("expected a raise");
        };
        assert_eq!(reason, "dialog open");
        // The reason changes while it lasts: one update, then quiet.
        let j = Inputs {
            agents_reason: Some("input needed".into()),
            ..i.clone()
        };
        let t = t0 + Duration::from_millis(1700);
        assert!(matches!(w.step(t, 1700, &j), Step::Update { .. }));
        assert_eq!(w.step(t + Duration::from_millis(10), 1710, &j), Step::Hold);
    }

    #[test]
    fn a_prompt_answered_in_chat_does_not_become_a_terminal_wait() {
        let mut w = WaitTrack::default();
        let t0 = Instant::now();
        // Presence turned waiting at 100 ms; the chat prompt resolved at 900 ms; the tool
        // still runs, so presence stays waiting and claude agents still says so.
        let mut i = Inputs {
            prompt_open: true,
            presence_waiting: true,
            agents_waiting: true,
            ..Inputs::default()
        };
        assert_eq!(w.step(t0 + Duration::from_millis(100), 100, &i), Step::Hold);
        i.prompt_open = false;
        i.last_resolved_ms = 900;
        assert_eq!(
            w.step(t0 + Duration::from_millis(1000), 1000, &i),
            Step::Hold
        );
        assert_eq!(w.step(t0 + Duration::from_secs(10), 10_000, &i), Step::Hold);
        assert!(w.active.is_none());
    }

    #[test]
    fn send_outcomes_serialize_with_the_contract_names() {
        let j = |o: SendOutcome| serde_json::to_value(o).unwrap();
        assert_eq!(j(SendOutcome::Sent), serde_json::json!({"outcome":"sent"}));
        assert_eq!(
            j(SendOutcome::Queued),
            serde_json::json!({"outcome":"queued"})
        );
        assert_eq!(
            j(SendOutcome::BlockedDialog {
                reason: "dialog open".into()
            }),
            serde_json::json!({"outcome":"blocked_dialog","reason":"dialog open"})
        );
        assert_eq!(
            j(SendOutcome::MirrorReadonly {
                place: "iTerm".into(),
                pid: 9
            }),
            serde_json::json!({"outcome":"mirror_readonly","where":"iTerm","pid":9})
        );
    }
}
