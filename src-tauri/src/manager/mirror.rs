//! Never two processes on one session: the live re-check and the read-only mirror.
//!
//! Every path that would spawn `claude --resume <id>` first runs `claude agents --json`
//! synchronously, bounded by [`CHECK_TIMEOUT`]. The answer decides:
//! - `Free`: nothing outside this app runs the session, so it is spawned;
//! - `Live`: another terminal runs it. Nothing is spawned. The DM becomes a **mirror**: the
//!   transcript is tailed into the chat read only (see [`MirrorInfo`]) and the composer is
//!   refused with `mirror_readonly`;
//! - `Unknown`: the check failed or timed out (after one retry). The open fails with the
//!   typed `check_failed` error, because a wrong guess would start the second process. The UI
//!   then offers retry, or "Open anyway" (`openAnyway: true`, asked first).
//!
//! Patchroom never signals a process it did not start. A mirror ends when the other process
//! exits. With `takeoverWhenClosed` on, the DM then resumes by itself (through the same
//! re-check). `session_takeover` does the same on demand and refuses while the other
//! process still runs.
//!
//! # Locks
//! `Manager::mirrors` is a leaf: never held across a presence, store, chat or sink call.

use std::sync::atomic::Ordering;
use std::sync::{Arc, Weak};
use std::time::Duration;

use patchroom_bridge::{AgentEntry, AgentsSource, Status as BridgeStatus};
use serde::Serialize;
use serde_json::json;

use super::{
    lock, map_status, AdapterState, Error, Manager, Presence, PresenceStatus, Result, SessionInfo,
    UiEvent,
};
use crate::agents::{CheckSource, LoginShellAgents, TappedAgents};

/// Longest one attempt of the synchronous re-check waits for `claude agents --json`. A failed
/// attempt is retried once, so the worst case is twice this.
pub(super) const CHECK_TIMEOUT: Duration = Duration::from_secs(3);
/// Transcript poll interval of a mirror, so another terminal's turn shows up quickly.
const MIRROR_WATCH: Duration = Duration::from_millis(250);

/// A DM that only mirrors a session running in another terminal.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct MirrorInfo {
    /// Where it runs: `iTerm`, `Terminal`, `tmux`, ... or `another terminal` when unknown.
    #[serde(rename = "where")]
    pub place: String,
    /// The other process (0 when unknown).
    pub pid: u32,
    /// Resume this DM automatically when the other process exits.
    #[serde(rename = "takeoverWhenClosed")]
    pub takeover_when_closed: bool,
}

pub(super) struct Mirror {
    sid: String,
    pub(super) info: MirrorInfo,
}

/// The verdict of one re-check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum LiveCheck {
    /// No process outside this app runs the session.
    Free,
    /// Another process runs it.
    Live {
        pid: u32,
        place: String,
        status: Option<BridgeStatus>,
    },
    /// The check did not finish. Do not spawn.
    Unknown(String),
}

impl Manager {
    /// Replace `claude agents --json` for the re-check, mirrors and the folder listing
    /// (tests). `None` goes back to the real source.
    pub fn set_agents_override(&self, source: Option<Arc<dyn AgentsSource>>) {
        *lock(&self.agents_override) = source;
    }

    /// The source for the synchronous re-check, bounded by [`CHECK_TIMEOUT`]. `None`
    /// when this manager never runs the CLI (tests with the reconciler off).
    pub(super) fn check_source(&self) -> Option<Arc<dyn AgentsSource>> {
        if let Some(s) = lock(&self.agents_override).clone() {
            return Some(s);
        }
        self.cfg.reconcile.then(|| {
            Arc::new(CheckSource {
                inner: LoginShellAgents::checker(CHECK_TIMEOUT),
                tap: Arc::clone(&self.agents_tap),
            }) as Arc<dyn AgentsSource>
        })
    }

    /// The source for background refreshes (the folder listing).
    pub(super) fn background_source(&self) -> Option<Arc<dyn AgentsSource>> {
        if let Some(s) = lock(&self.agents_override).clone() {
            return Some(s);
        }
        self.cfg.reconcile.then(|| {
            Arc::new(TappedAgents {
                inner: LoginShellAgents::new(Arc::new(std::sync::atomic::AtomicBool::new(true))),
                tap: Arc::clone(&self.agents_tap),
                gate: None,
            }) as Arc<dyn AgentsSource>
        })
    }

    /// Every live interactive session on the machine: the CLI's answer plus the test
    /// override ids. Errors when the CLI could not be read in time.
    pub(super) fn live_entries(&self) -> std::result::Result<Vec<AgentEntry>, String> {
        let mut out = match self.check_source() {
            Some(src) => src.list().map_err(|e| e.to_string())?,
            None => Vec::new(),
        };
        if let Some(ids) = lock(&self.folders.live_override).clone() {
            out.extend(ids.into_iter().map(|sid| AgentEntry {
                pid: 0,
                cwd: String::new(),
                kind: "interactive".into(),
                session_id: Some(sid),
                name: None,
                status: "idle".into(),
                waiting_for: None,
            }));
        }
        Ok(out)
    }

    /// Re-check, right now, whether a process outside this app runs session `sid`.
    pub(super) fn live_check(&self, sid: &str) -> LiveCheck {
        let entries = match self.live_entries() {
            Ok(e) => e,
            Err(e) => return LiveCheck::Unknown(e),
        };
        match find_live(&entries, sid) {
            None => LiveCheck::Free,
            Some(e) => LiveCheck::Live {
                pid: e.pid,
                place: terminal_of(e.pid),
                status: e.to_status(),
            },
        }
    }

    /// The mirror state of a DM, if it is one.
    pub(super) fn mirror_of(&self, id: &str) -> Option<MirrorInfo> {
        lock(&self.mirrors).get(id).map(|m| m.info.clone())
    }

    fn emit_mirror(&self, id: &str, info: Option<&MirrorInfo>) {
        self.sink.emit(UiEvent::Mirror {
            id: id.to_owned(),
            mirror: info.map_or(serde_json::Value::Null, |i| json!(i)),
        });
    }

    /// Turn `id` into a mirror of the process `pid`. Spawns nothing.
    pub(super) fn start_mirror(
        self: &Arc<Self>,
        id: &str,
        sid: &str,
        pid: u32,
        place: &str,
        status: Option<BridgeStatus>,
    ) {
        let info = {
            let mut ms = lock(&self.mirrors);
            let takeover = ms.get(id).is_some_and(|m| m.info.takeover_when_closed);
            let info = MirrorInfo {
                place: place.to_owned(),
                pid,
                takeover_when_closed: takeover,
            };
            let changed = ms.get(id).is_none_or(|m| m.info != info);
            ms.insert(
                id.to_owned(),
                Mirror {
                    sid: sid.to_owned(),
                    info: info.clone(),
                },
            );
            changed.then_some(info)
        };
        // The transcript is the mirror: tail it quickly.
        if let Ok(chat) = self.chat_for_read(id) {
            chat.watcher.set_interval(MIRROR_WATCH);
            chat.watcher.kick();
        }
        let (st, needs) = status.map_or((PresenceStatus::Idle, None), map_status);
        {
            let mut presence = lock(&self.presence);
            let title = self
                .conversation(id)
                .map(|c| AdapterState::parse(&c.adapter_state).title)
                .unwrap_or_default();
            presence.insert(
                id.to_owned(),
                Presence {
                    title,
                    status: st,
                    needs,
                    claude_sid: Some(sid.to_owned()),
                },
            );
            self.sink.emit(UiEvent::Status {
                id: id.to_owned(),
                status: st,
                needs,
            });
            self.refresh_active(&presence);
        }
        if let Some(info) = info {
            self.emit_mirror(id, Some(&info));
        }
        self.ensure_mirror_monitor();
    }

    /// Stop mirroring `id`. The DM becomes an exited one that can be resumed. Returns false
    /// when it was no mirror. Never touches the other process.
    pub(super) fn end_mirror(&self, id: &str) -> bool {
        if lock(&self.mirrors).remove(id).is_none() {
            return false;
        }
        self.emit_mirror(id, None);
        if let Some(chat) = self.chat_of(id) {
            chat.watcher.set_interval(super::chat::IDLE_POLL);
        }
        self.set_status(id, PresenceStatus::Exited, None);
        self.force_clear_needs_you(id, "mirror-end", "the other process is gone");
        true
    }

    /// Forget a mirror without events (the DM is being deleted).
    pub(super) fn drop_mirror(&self, id: &str) {
        lock(&self.mirrors).remove(id);
    }

    /// `session_mirror_takeover_when_closed {id, enabled}`.
    ///
    /// # Errors
    /// The DM is not a mirror.
    pub fn set_mirror_takeover(&self, id: &str, enabled: bool) -> Result<()> {
        let info = {
            let mut ms = lock(&self.mirrors);
            let m = ms
                .get_mut(id)
                .ok_or_else(|| Error::Invalid("this DM is not a read-only mirror".into()))?;
            m.info.takeover_when_closed = enabled;
            m.info.clone()
        };
        self.emit_mirror(id, Some(&info));
        Ok(())
    }

    /// `session_takeover {id, cols?, rows?}`: resume a mirrored (or exited) DM now. Refuses
    /// while the other process still runs; Patchroom never kills it.
    ///
    /// # Errors
    /// Unknown DM, the other process still runs, the check failed, or the spawn failed.
    pub fn takeover(
        self: &Arc<Self>,
        id: &str,
        cols: Option<u16>,
        rows: Option<u16>,
    ) -> Result<SessionInfo> {
        self.resume_with(id, cols, rows, true, false)?;
        self.list()?
            .into_iter()
            .find(|s| s.id == id)
            .ok_or_else(|| Error::NoSession(id.to_owned()))
    }

    // ---- monitor ----

    /// Start the single monitor thread (once). It exits when no mirror is left.
    fn ensure_mirror_monitor(self: &Arc<Self>) {
        if self.mirror_monitor.swap(true, Ordering::SeqCst) {
            return;
        }
        let weak: Weak<Manager> = Arc::downgrade(self);
        let spawned = std::thread::Builder::new()
            .name("patchroom-mirror-monitor".into())
            .spawn(move || {
                while let Some(period) = weak.upgrade().map(|m| m.cfg.mirror_poll) {
                    std::thread::sleep(period);
                    let Some(me) = weak.upgrade() else { break };
                    if me.shutting_down.load(Ordering::SeqCst) {
                        break;
                    }
                    if !me.mirror_tick() {
                        me.mirror_monitor.store(false, Ordering::SeqCst);
                        // A mirror added since the empty snapshot starts a new monitor, or this
                        // one goes on.
                        if lock(&me.mirrors).is_empty()
                            || me.mirror_monitor.swap(true, Ordering::SeqCst)
                        {
                            break;
                        }
                    }
                }
            });
        if spawned.is_err() {
            self.mirror_monitor.store(false, Ordering::SeqCst);
        }
    }

    /// One monitor pass. False when no mirror is left.
    pub(super) fn mirror_tick(self: &Arc<Self>) -> bool {
        let mirrors: Vec<(String, String)> = lock(&self.mirrors)
            .iter()
            .map(|(k, m)| (k.clone(), m.sid.clone()))
            .collect();
        if mirrors.is_empty() {
            return false;
        }
        // A failed or slow check changes nothing: the other process may well still run.
        let Ok(entries) = self.live_entries() else {
            return true;
        };
        for (id, sid) in mirrors {
            match find_live(&entries, &sid) {
                Some(e) => self.refresh_mirror(&id, e),
                None => self.mirror_closed(&id),
            }
        }
        true
    }

    fn refresh_mirror(self: &Arc<Self>, id: &str, e: &AgentEntry) {
        let moved = lock(&self.mirrors)
            .get(id)
            .is_some_and(|m| e.pid != 0 && m.info.pid != e.pid);
        if moved {
            let info = {
                let mut ms = lock(&self.mirrors);
                ms.get_mut(id).map(|m| {
                    m.info.pid = e.pid;
                    m.info.place = terminal_of(e.pid);
                    m.info.clone()
                })
            };
            if let Some(info) = info {
                self.emit_mirror(id, Some(&info));
            }
        }
        if let Some(st) = e.to_status() {
            let (s, n) = map_status(st);
            self.set_status(id, s, n);
            self.reconcile_needs_you(
                id,
                "mirror-status",
                &format!("{s:?}"),
                s != PresenceStatus::Waiting,
            );
        }
    }

    /// The other process is gone: take over if asked, else end the mirror.
    fn mirror_closed(self: &Arc<Self>, id: &str) {
        let take = lock(&self.mirrors)
            .get(id)
            .is_some_and(|m| m.info.takeover_when_closed);
        if take && self.resume_with(id, None, None, false, false).is_ok() {
            return;
        }
        self.end_mirror(id);
    }
}

/// The live interactive entry for `sid`, ignoring registry leftovers whose process is gone.
fn find_live<'a>(entries: &'a [AgentEntry], sid: &str) -> Option<&'a AgentEntry> {
    entries
        .iter()
        .filter(|e| e.kind.is_empty() || e.kind == "interactive")
        .filter(|e| e.session_id.as_deref() == Some(sid))
        .find(|e| pid_alive(e.pid))
}

/// Is `pid` a running process? Unknown (0) and unreadable count as alive: the check errs
/// toward "do not spawn".
fn pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return true;
    }
    std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "pid="])
        .stderr(std::process::Stdio::null())
        .output()
        .map_or(true, |o| o.status.success() && !o.stdout.is_empty())
}

/// The terminal app that hosts `pid`, found by walking up its parents. Falls back to
/// `another terminal`.
pub(super) fn terminal_of(pid: u32) -> String {
    let mut chain = Vec::new();
    let mut cur = pid;
    for _ in 0..16 {
        if cur <= 1 {
            break;
        }
        let Ok(out) = std::process::Command::new("ps")
            .args(["-o", "ppid=,comm=", "-p", &cur.to_string()])
            .stderr(std::process::Stdio::null())
            .output()
        else {
            break;
        };
        let text = String::from_utf8_lossy(&out.stdout).into_owned();
        let Some((ppid, comm)) = parse_ps_line(&text) else {
            break;
        };
        chain.push(comm);
        cur = ppid;
    }
    terminal_from_chain(&chain)
        .unwrap_or("another terminal")
        .to_owned()
}

/// `  1234 /Applications/iTerm.app/...` into `(1234, command)`.
fn parse_ps_line(line: &str) -> Option<(u32, String)> {
    let t = line.trim();
    let (ppid, comm) = t.split_once(char::is_whitespace)?;
    Some((ppid.parse().ok()?, comm.trim().to_owned()))
}

/// The nearest ancestor that is a known terminal host.
fn terminal_from_chain(chain: &[String]) -> Option<&'static str> {
    const KNOWN: &[(&str, &str)] = &[
        ("tmux", "tmux"),
        ("zellij", "zellij"),
        ("iterm", "iTerm"),
        ("ghostty", "Ghostty"),
        ("wezterm", "WezTerm"),
        ("alacritty", "Alacritty"),
        ("kitty", "kitty"),
        ("warp", "Warp"),
        ("hyper", "Hyper"),
        ("/terminal.app/", "Terminal"),
        ("visual studio code", "VS Code"),
        ("cursor", "Cursor"),
    ];
    chain.iter().find_map(|comm| {
        let c = comm.to_lowercase();
        let base = c.rsplit('/').next().unwrap_or(&c);
        KNOWN
            .iter()
            .find(|(needle, _)| {
                if *needle == "tmux" || *needle == "zellij" {
                    base.starts_with(needle)
                } else {
                    c.contains(needle)
                }
            })
            .map(|(_, name)| *name)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(pid: u32, sid: &str, kind: &str) -> AgentEntry {
        AgentEntry {
            pid,
            cwd: String::new(),
            kind: kind.into(),
            session_id: Some(sid.into()),
            name: None,
            status: "idle".into(),
            waiting_for: None,
        }
    }

    #[test]
    fn terminals_are_named_from_the_nearest_known_ancestor() {
        let chain = |v: &[&str]| v.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
        assert_eq!(
            terminal_from_chain(&chain(&[
                "claude",
                "-zsh",
                "/Applications/iTerm.app/Contents/MacOS/iTerm2",
                "/sbin/launchd"
            ])),
            Some("iTerm")
        );
        assert_eq!(
            terminal_from_chain(&chain(&[
                "claude",
                "-zsh",
                "/opt/homebrew/bin/tmux",
                "/Applications/iTerm.app/Contents/MacOS/iTerm2"
            ])),
            Some("tmux")
        );
        assert_eq!(
            terminal_from_chain(&chain(&[
                "claude",
                "-zsh",
                "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"
            ])),
            Some("Terminal")
        );
        assert_eq!(
            terminal_from_chain(&chain(&["claude", "-zsh", "sshd"])),
            None
        );
        assert_eq!(
            parse_ps_line("  4242 /bin/zsh\n"),
            Some((4242, "/bin/zsh".into()))
        );
        assert_eq!(parse_ps_line(""), None);
    }

    #[test]
    fn find_live_matches_the_session_and_skips_dead_and_non_interactive_entries() {
        let me = std::process::id();
        let entries = vec![
            entry(me, "a", "interactive"),
            entry(me, "b", "sdk"),
            entry(4_000_000, "c", "interactive"),
            entry(0, "d", ""),
        ];
        assert!(find_live(&entries, "a").is_some());
        assert!(find_live(&entries, "b").is_none(), "non-interactive");
        assert!(find_live(&entries, "c").is_none(), "pid is not running");
        assert!(
            find_live(&entries, "d").is_some(),
            "unknown pid counts as live"
        );
        assert!(find_live(&entries, "zzz").is_none());
    }

    #[test]
    fn mirror_info_serializes_with_the_contract_names() {
        let v = serde_json::to_value(MirrorInfo {
            place: "iTerm".into(),
            pid: 7,
            takeover_when_closed: true,
        })
        .unwrap();
        assert_eq!(
            v,
            json!({"where":"iTerm","pid":7,"takeoverWhenClosed":true})
        );
    }
}
