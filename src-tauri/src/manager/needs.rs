//! The needs-you flag of a DM, derived from every source that can hold it.
//!
//! Three sources hold needs-you:
//! 1. an open chat prompt (a permission, question or plan the bridge holds for the chat);
//! 2. a terminal-only wait (a dialog only the terminal can answer, see `terminal.rs`);
//! 3. presence `waiting` (the hooks or `claude agents` say claude waits).
//!
//! The persisted flag is `prompt || terminal_wait || presence_waiting`, recomputed from the
//! live state by [`Manager::reconcile_needs_you`]. No writer sets or clears the flag on its
//! own: a hook `Busy` or `Idle`, a terminal-wait `Clear` or a resolved prompt only changes its
//! own source, then the flag is derived again. A writer therefore cannot clear it while
//! another source still holds it.
//!
//! The only exception is [`Manager::force_clear_needs_you`]: the process is gone (exit,
//! respawn, mirror end), so nothing can be answered any more.
//!
//! Every change, and every clear that another source blocked, is traced as
//! `writer old new reason` to stderr (the app log) and to [`TRACE_LOG`] in the data dir.

use std::io::Write as _;

use super::{lock, parse_id, Manager, PresenceStatus};

/// The needs-you trace file in the data dir, read by the live e2e report.
pub const TRACE_LOG: &str = "needs-you-trace.log";
/// Rotate the trace file past this size.
const TRACE_MAX_BYTES: u64 = 1024 * 1024;

/// Which sources hold needs-you right now.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) struct NeedsSources {
    /// The chat holds an open prompt.
    pub prompt_open: bool,
    /// A terminal-only wait is active.
    pub terminal_wait: bool,
    /// Presence is `waiting`.
    pub presence_waiting: bool,
}

impl NeedsSources {
    /// The flag these sources derive: held while any source holds.
    pub(super) fn held(self) -> bool {
        self.prompt_open || self.terminal_wait || self.presence_waiting
    }

    /// The holding sources as text, for the trace.
    pub(super) fn holders(self) -> String {
        let mut v = Vec::new();
        if self.prompt_open {
            v.push("prompt");
        }
        if self.terminal_wait {
            v.push("terminal");
        }
        if self.presence_waiting {
            v.push("presence");
        }
        if v.is_empty() {
            "none".into()
        } else {
            v.join("+")
        }
    }
}

impl Manager {
    /// What holds needs-you for `id` now, read from the live state.
    fn needs_sources(&self, id: &str) -> NeedsSources {
        NeedsSources {
            prompt_open: self.chat_of(id).is_some_and(|c| c.has_prompts()),
            terminal_wait: self.terminal_wait_of(id).is_some(),
            presence_waiting: lock(&self.presence)
                .get(id)
                .is_some_and(|p| p.status == PresenceStatus::Waiting),
        }
    }

    fn persisted_needs_you(&self, id: &str) -> Option<bool> {
        let conv = parse_id(id).ok()?;
        lock(&self.store).badges(conv).ok().map(|b| b.needs_you)
    }

    /// Derive needs-you from all its sources and persist it. `writer` names the caller and
    /// `reason` the event; `wants_clear` marks a writer that ended its own source, so a clear
    /// another source blocked is traced.
    pub(super) fn reconcile_needs_you(
        &self,
        id: &str,
        writer: &str,
        reason: &str,
        wants_clear: bool,
    ) {
        let _gate = lock(&self.needs_gate);
        let Some(old) = self.persisted_needs_you(id) else {
            return;
        };
        let sources = self.needs_sources(id);
        let new = sources.held();
        if old != new {
            self.note_needs_you(id, new);
            self.trace_needs(id, writer, old, new, reason, sources);
        } else if wants_clear && new {
            self.trace_needs(id, writer, old, new, &format!("kept: {reason}"), sources);
        }
    }

    /// Clear needs-you because the process that held it is gone. Traced like any writer.
    pub(super) fn force_clear_needs_you(&self, id: &str, writer: &str, reason: &str) {
        let _gate = lock(&self.needs_gate);
        let Some(old) = self.persisted_needs_you(id) else {
            return;
        };
        if old {
            self.note_needs_you(id, false);
            let sources = self.needs_sources(id);
            self.trace_needs(
                id,
                writer,
                old,
                false,
                &format!("forced: {reason}"),
                sources,
            );
        }
    }

    fn trace_needs(
        &self,
        id: &str,
        writer: &str,
        old: bool,
        new: bool,
        reason: &str,
        sources: NeedsSources,
    ) {
        let line = format!(
            "{} needs-you dm={id} writer={writer} old={old} new={new} reason={reason} holders={}",
            chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%.3f%:z"),
            sources.holders()
        );
        eprintln!("[patchroom] {line}");
        let path = self.cfg.data_dir.join(TRACE_LOG);
        if std::fs::metadata(&path).is_ok_and(|m| m.len() > TRACE_MAX_BYTES) {
            let _ = std::fs::rename(&path, self.cfg.data_dir.join(format!("{TRACE_LOG}.1")));
        }
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = writeln!(f, "{line}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One writer event. Each changes only its own source, then needs-you is derived again.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Ev {
        PromptOpen,
        PromptResolve,
        WaitRaise,
        WaitClear,
        WaitHold,
        HookBusy,
        HookIdle,
        HookWaiting,
    }

    const ALL: [Ev; 8] = [
        Ev::PromptOpen,
        Ev::PromptResolve,
        Ev::WaitRaise,
        Ev::WaitClear,
        Ev::WaitHold,
        Ev::HookBusy,
        Ev::HookIdle,
        Ev::HookWaiting,
    ];

    /// The manager's wiring without the manager: the same derivation, applied per event.
    #[derive(Default)]
    struct Model {
        s: NeedsSources,
        persisted: bool,
    }

    impl Model {
        fn apply(&mut self, ev: Ev) {
            match ev {
                Ev::PromptOpen => self.s.prompt_open = true,
                Ev::PromptResolve => self.s.prompt_open = false,
                Ev::WaitRaise => self.s.terminal_wait = true,
                Ev::WaitClear => self.s.terminal_wait = false,
                Ev::WaitHold => {}
                Ev::HookBusy | Ev::HookIdle => self.s.presence_waiting = false,
                Ev::HookWaiting => self.s.presence_waiting = true,
            }
            self.persisted = self.s.held();
        }
    }

    fn run(seq: &[Ev]) -> Model {
        let mut m = Model::default();
        for &ev in seq {
            m.apply(ev);
            assert_eq!(
                m.persisted,
                m.s.prompt_open || m.s.terminal_wait || m.s.presence_waiting,
                "{seq:?} after {ev:?}"
            );
            assert!(
                !m.s.prompt_open || m.persisted,
                "needs-you cleared while a prompt is open: {seq:?} after {ev:?}"
            );
        }
        m
    }

    #[test]
    fn needs_you_stays_true_while_a_prompt_is_open_in_every_order() {
        // Every sequence of up to five events: the invariant is checked after each step.
        let mut count = 0usize;
        let mut seqs: Vec<Vec<Ev>> = vec![vec![]];
        for _ in 0..5 {
            let mut next = Vec::new();
            for s in &seqs {
                for ev in ALL {
                    let mut t = s.clone();
                    t.push(ev);
                    run(&t);
                    count += 1;
                    next.push(t);
                }
            }
            seqs = next;
        }
        assert!(count > 30_000);
    }

    fn perms(items: &[Ev], cur: &mut Vec<Ev>, used: &mut [bool], out: &mut Vec<Vec<Ev>>) {
        out.push(cur.clone());
        for i in 0..items.len() {
            if !used[i] {
                used[i] = true;
                cur.push(items[i]);
                perms(items, cur, used, out);
                cur.pop();
                used[i] = false;
            }
        }
    }

    #[test]
    fn the_prompt_and_the_other_writers_in_every_order_resolve_then_clears() {
        let others = [
            Ev::WaitRaise,
            Ev::WaitClear,
            Ev::WaitHold,
            Ev::HookBusy,
            Ev::HookIdle,
        ];
        let mut out = Vec::new();
        perms(&others, &mut Vec::new(), &mut [false; 5], &mut out);
        assert!(out.len() > 300);
        for mid in &out {
            // The prompt opens first, the other writers follow.
            let mut seq = vec![Ev::PromptOpen];
            seq.extend(mid);
            assert!(run(&seq).persisted, "{seq:?}");
            // Resolve: it clears once no other source holds.
            seq.push(Ev::PromptResolve);
            let m = run(&seq);
            assert_eq!(
                m.persisted,
                m.s.terminal_wait || m.s.presence_waiting,
                "{seq:?}"
            );
            // Close the remaining sources: it clears.
            seq.extend([Ev::WaitClear, Ev::HookIdle]);
            assert!(!run(&seq).persisted, "{seq:?}");

            // The prompt opens last, after the others.
            let mut seq: Vec<Ev> = mid.clone();
            seq.push(Ev::PromptOpen);
            assert!(run(&seq).persisted, "{seq:?}");
            seq.push(Ev::PromptResolve);
            seq.extend([Ev::WaitClear, Ev::HookIdle]);
            assert!(!run(&seq).persisted, "{seq:?}");
        }
    }

    #[test]
    fn the_failing_run_sequence_keeps_needs_you() {
        // Terminal wait raised, then the prompt arrives, the wait clears (a prompt is not a
        // terminal wait), a hook Busy and Idle land: the prompt still holds.
        let m = run(&[
            Ev::WaitRaise,
            Ev::PromptOpen,
            Ev::WaitClear,
            Ev::HookBusy,
            Ev::HookIdle,
            Ev::WaitHold,
        ]);
        assert!(m.persisted);
        let m = run(&[
            Ev::WaitRaise,
            Ev::PromptOpen,
            Ev::WaitClear,
            Ev::HookIdle,
            Ev::PromptResolve,
        ]);
        assert!(!m.persisted);
    }

    #[test]
    fn holders_name_the_sources() {
        assert_eq!(NeedsSources::default().holders(), "none");
        let s = NeedsSources {
            prompt_open: true,
            terminal_wait: false,
            presence_waiting: true,
        };
        assert_eq!(s.holders(), "prompt+presence");
        assert!(s.held());
    }
}
