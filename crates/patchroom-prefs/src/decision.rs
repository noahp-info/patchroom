//! The single notification decision: levels, focus, Do Not Disturb and the user's own hooks.
//!
//! The backend decides once per event. A `fire` decision posts the native notification and
//! emits `notify:fire`, which the UI turns into a sound, so sound and notification never
//! disagree. Every decision, fired or suppressed, becomes one line in the decision log
//! (event, DM id, decision, reason; never a message body).

use chrono::NaiveDateTime;

use crate::hooks::{hook_events_for, DetectedHook};
use crate::prefs::{HookPolicy, Level, Prefs};

/// What happened.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    /// A prompt or dialog waits on the user.
    Needs,
    /// A turn finished.
    Done,
    /// The terminal asked for attention (OSC 9 or OSC 777).
    Message,
    /// A turn or the process failed.
    Error,
    /// A terminal bell.
    Bell,
    /// A session began (Claude's SessionStart on startup or resume). Sound only: it never
    /// posts a notification, and it plays while the session is on screen.
    Session,
}

impl Event {
    /// The contract name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Event::Needs => "needs",
            Event::Done => "done",
            Event::Message => "message",
            Event::Error => "error",
            Event::Bell => "bell",
            Event::Session => "session",
        }
    }
}

/// Why an event did or did not notify.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    /// Nothing stopped it.
    Ok,
    /// The DM is archived (only needs-you gets through).
    Archived,
    /// Do Not Disturb is on.
    Dnd,
    /// The DM is muted.
    Muted,
    /// The DM is set to needs-you only.
    NeedsOnly,
    /// The user is looking at this DM in a focused window.
    Focused,
    /// The user's own sound hook covers this event and the policy is "keep yours".
    HookKeep,
    /// The same attention was already announced a moment ago.
    Duplicate,
    /// The Test notification button.
    Test,
}

impl Reason {
    /// The name written to the decision log.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Reason::Ok => "ok",
            Reason::Archived => "archived",
            Reason::Dnd => "dnd",
            Reason::Muted => "dm_muted",
            Reason::NeedsOnly => "level_needs_only",
            Reason::Focused => "focused",
            Reason::HookKeep => "hook_keep",
            Reason::Duplicate => "duplicate",
            Reason::Test => "test",
        }
    }
}

/// The outcome.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Decision {
    /// Post the notification and emit `notify:fire`.
    pub fire: bool,
    /// Why.
    pub reason: Reason,
}

/// What the decision depends on besides the prefs.
#[derive(Debug, Clone)]
pub struct Facts<'a> {
    /// DM id.
    pub dm: &'a str,
    /// The event.
    pub event: Event,
    /// The window is focused and visible and shows this DM.
    pub focused: bool,
    /// The DM is archived.
    pub archived: bool,
    /// Local wall-clock time now.
    pub local_now: NaiveDateTime,
    /// The user's audio hooks, from `detect_sound_hooks`.
    pub detected: &'a [DetectedHook],
}

fn no(reason: Reason) -> Decision {
    Decision {
        fire: false,
        reason,
    }
}

/// Is the event covered by a detected hook whose policy is "keep"? A hook is covered when
/// it sits on one of the Claude hook events that duplicate `event`. The policy is looked up
/// by that hook event name, then by the Patchroom event name; with neither set the default
/// is "keep".
fn hook_keeps(prefs: &Prefs, event: Event, detected: &[DetectedHook]) -> bool {
    let covering = hook_events_for(event.as_str());
    let mut any = false;
    // A guarded hook stays quiet in Patchroom sessions: it covers nothing here.
    for hook in detected
        .iter()
        .filter(|h| !h.guarded && covering.contains(&h.event.as_str()))
    {
        any = true;
        let policy = prefs
            .sound
            .hook_policy
            .get(&hook.event)
            .or_else(|| prefs.sound.hook_policy.get(event.as_str()))
            .copied()
            .unwrap_or(HookPolicy::Keep);
        if policy == HookPolicy::Both {
            return false;
        }
    }
    any
}

/// Decide whether `facts.event` notifies. The checks run in a fixed order and the first that
/// stops the event is the reason: archived, Do Not Disturb, the DM's level, focus, hooks.
#[must_use]
pub fn decide(prefs: &Prefs, facts: &Facts<'_>) -> Decision {
    let needs = facts.event == Event::Needs;
    if facts.archived && !needs {
        return no(Reason::Archived);
    }
    if prefs.dnd.active_at(facts.local_now) {
        return no(Reason::Dnd);
    }
    let level = prefs
        .notify
        .per_dm
        .get(facts.dm)
        .copied()
        .unwrap_or(prefs.notify.default);
    match level {
        Level::Mute => return no(Reason::Muted),
        Level::Needs if !needs => return no(Reason::NeedsOnly),
        _ => {}
    }
    // A start sound is a cue while you watch the session come up; focus never hides it.
    if facts.focused && facts.event != Event::Session {
        return no(Reason::Focused);
    }
    if hook_keeps(prefs, facts.event, facts.detected) {
        return no(Reason::HookKeep);
    }
    Decision {
        fire: true,
        reason: Reason::Ok,
    }
}

/// One decision log line: `<time> event=<e> dm=<id> decision=<fire|suppress> reason=<r>`.
/// `time` is an ISO-8601 local timestamp. No message text is ever included.
#[must_use]
pub fn log_line(time: &str, event: Event, dm: &str, decision: Decision) -> String {
    format!(
        "{time} event={} dm={dm} decision={} reason={}",
        event.as_str(),
        if decision.fire { "fire" } else { "suppress" },
        decision.reason.as_str()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dnd::{Dnd, Schedule};
    use chrono::NaiveDate;

    fn now() -> NaiveDateTime {
        // Monday noon.
        NaiveDate::from_ymd_opt(2026, 10, 12)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap()
    }

    fn facts<'a>(event: Event, detected: &'a [DetectedHook]) -> Facts<'a> {
        Facts {
            dm: "dm1",
            event,
            focused: false,
            archived: false,
            local_now: now(),
            detected,
        }
    }

    fn hook(event: &str) -> DetectedHook {
        DetectedHook {
            event: event.into(),
            command: "afplay x".into(),
            source: "user".into(),
            path: "/s".into(),
            script: None,
            guarded: false,
        }
    }

    fn d(prefs: &Prefs, f: &Facts<'_>) -> (bool, &'static str) {
        let r = decide(prefs, f);
        (r.fire, r.reason.as_str())
    }

    #[test]
    fn defaults_fire_for_every_event() {
        let p = Prefs::default();
        for e in [
            Event::Needs,
            Event::Done,
            Event::Message,
            Event::Error,
            Event::Bell,
        ] {
            assert_eq!(d(&p, &facts(e, &[])), (true, "ok"), "{e:?}");
        }
    }

    #[test]
    fn per_dm_level_beats_the_default() {
        let mut p = Prefs::default();
        p.notify.default = Level::Needs;
        assert_eq!(d(&p, &facts(Event::Done, &[])), (false, "level_needs_only"));
        assert_eq!(d(&p, &facts(Event::Needs, &[])), (true, "ok"));
        p.notify.per_dm.insert("dm1".into(), Level::All);
        assert_eq!(d(&p, &facts(Event::Done, &[])), (true, "ok"));
        p.notify.per_dm.insert("dm1".into(), Level::Mute);
        assert_eq!(d(&p, &facts(Event::Needs, &[])), (false, "dm_muted"));
        // Another DM is unaffected by dm1's level.
        let mut f = facts(Event::Done, &[]);
        f.dm = "dm2";
        assert_eq!(d(&p, &f), (false, "level_needs_only"));
    }

    #[test]
    fn the_focused_dm_never_notifies_but_others_do() {
        let p = Prefs::default();
        let mut f = facts(Event::Done, &[]);
        f.focused = true;
        assert_eq!(d(&p, &f), (false, "focused"));
        f.event = Event::Needs;
        assert_eq!(d(&p, &f), (false, "focused"));
        f.focused = false;
        assert_eq!(d(&p, &f), (true, "ok"));
    }

    #[test]
    fn archived_dms_only_let_needs_you_through() {
        let p = Prefs::default();
        let mut f = facts(Event::Done, &[]);
        f.archived = true;
        assert_eq!(d(&p, &f), (false, "archived"));
        f.event = Event::Bell;
        assert_eq!(d(&p, &f), (false, "archived"));
        f.event = Event::Needs;
        assert_eq!(d(&p, &f), (true, "ok"));
    }

    #[test]
    fn dnd_suppresses_everything_including_needs() {
        let mut p = Prefs {
            dnd: Dnd {
                manual: true,
                schedule: None,
            },
            ..Prefs::default()
        };
        assert_eq!(d(&p, &facts(Event::Needs, &[])), (false, "dnd"));
        p.dnd = Dnd {
            manual: false,
            schedule: Some(Schedule {
                days: vec![1],
                start: "11:00".into(),
                end: "13:00".into(),
            }),
        };
        assert_eq!(d(&p, &facts(Event::Done, &[])), (false, "dnd"));
        p.dnd.schedule.as_mut().unwrap().days = vec![2];
        assert_eq!(d(&p, &facts(Event::Done, &[])), (true, "ok"));
    }

    #[test]
    fn session_start_sounds_while_focused_and_yields_to_a_start_hook() {
        let p = Prefs::default();
        let mut f = facts(Event::Session, &[]);
        f.focused = true;
        assert_eq!(d(&p, &f), (true, "ok"), "focus never hides the start cue");
        let hooks = [hook("SessionStart")];
        assert_eq!(d(&p, &facts(Event::Session, &hooks)), (false, "hook_keep"));
        assert_eq!(Event::Session.as_str(), "session");
    }

    #[test]
    fn a_guarded_hook_covers_nothing() {
        let p = Prefs::default();
        let mut stop = hook("Stop");
        stop.guarded = true;
        assert_eq!(d(&p, &facts(Event::Done, &[stop])), (true, "ok"));
    }

    #[test]
    fn a_detected_hook_keeps_its_event_silent_by_default() {
        let mut p = Prefs::default();
        let hooks = [hook("Stop"), hook("SessionStart")];
        assert_eq!(d(&p, &facts(Event::Done, &hooks)), (false, "hook_keep"));
        // Neither hook duplicates needs or bell: they still fire.
        assert_eq!(d(&p, &facts(Event::Needs, &hooks)), (true, "ok"));
        assert_eq!(d(&p, &facts(Event::Bell, &hooks)), (true, "ok"));
        // "Play both" by the Claude hook event name, or by the Patchroom event name.
        p.sound.hook_policy.insert("Stop".into(), HookPolicy::Both);
        assert_eq!(d(&p, &facts(Event::Done, &hooks)), (true, "ok"));
        p.sound.hook_policy.clear();
        p.sound.hook_policy.insert("done".into(), HookPolicy::Both);
        assert_eq!(d(&p, &facts(Event::Done, &hooks)), (true, "ok"));
        // An explicit "keep" is the same as the default.
        p.sound.hook_policy.insert("Stop".into(), HookPolicy::Keep);
        assert_eq!(d(&p, &facts(Event::Done, &hooks)), (false, "hook_keep"));
    }

    #[test]
    fn two_hooks_on_one_event_keep_unless_every_policy_is_both() {
        let mut p = Prefs::default();
        let hooks = [hook("Stop"), hook("TaskCompleted")];
        p.sound.hook_policy.insert("Stop".into(), HookPolicy::Both);
        // TaskCompleted still says keep (default), and "both" on any one hook wins.
        assert_eq!(d(&p, &facts(Event::Done, &hooks)), (true, "ok"));
    }

    #[test]
    fn order_is_archived_then_dnd_then_level_then_focus_then_hooks() {
        let mut p = Prefs::default();
        p.dnd.manual = true;
        p.notify.default = Level::Mute;
        let hooks = [hook("Stop")];
        let mut f = facts(Event::Done, &hooks);
        f.focused = true;
        f.archived = true;
        assert_eq!(d(&p, &f).1, "archived");
        f.archived = false;
        assert_eq!(d(&p, &f).1, "dnd");
        p.dnd.manual = false;
        assert_eq!(d(&p, &f).1, "dm_muted");
        p.notify.default = Level::All;
        assert_eq!(d(&p, &f).1, "focused");
        f.focused = false;
        assert_eq!(d(&p, &f).1, "hook_keep");
    }

    #[test]
    fn log_lines_carry_no_message_text() {
        let line = log_line(
            "2026-10-12T12:00:00.000-04:00",
            Event::Done,
            "01HX",
            Decision {
                fire: false,
                reason: Reason::Dnd,
            },
        );
        assert_eq!(
            line,
            "2026-10-12T12:00:00.000-04:00 event=done dm=01HX decision=suppress reason=dnd"
        );
        assert_eq!(
            log_line(
                "t",
                Event::Needs,
                "d",
                Decision {
                    fire: true,
                    reason: Reason::Ok
                }
            ),
            "t event=needs dm=d decision=fire reason=ok"
        );
    }
}
