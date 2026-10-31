//! Links: the in-app viewer and the system browser.
//!
//! The viewer is one child webview (label [`LABEL`]) laid over the right-hand pane of the main
//! window. The UI owns the pane and reports its rectangle; this module only places, navigates
//! and closes the webview.
//!
//! Safety:
//! - Only `http` and `https` URLs load, in the viewer and in the browser.
//! - The viewer gets no Patchroom IPC: capabilities name the `main` webview only, and remote
//!   pages never match a capability.
//! - A page that opens a new window (`target=_blank`, `window.open`) gets the system browser,
//!   never a new Patchroom window.
//! - The viewer keeps its own web storage (macOS 14+), apart from the app's. Signing in to
//!   claude.ai happens there, once, and Sign out clears only that storage. Patchroom never reads
//!   cookies: it infers sign-in from which claude.ai page loaded and its title.
//! - "Comment on selection" reads the page selection without giving the page any IPC. Patchroom
//!   evals a one-shot script that navigates to `patchroom-sel:<nonce>?t=...&u=...`. The
//!   navigation handler blocks that navigation and accepts it only with a nonce Patchroom issued
//!   in the last few seconds, once.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::json;
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl};

/// The scheme of the blocked hand-back navigation.
pub const SEL_SCHEME: &str = "patchroom-sel";
/// How long a selection nonce stays valid.
pub const NONCE_TTL: Duration = Duration::from_secs(4);
/// Longest selection carried back (characters). The composer caps quotes further.
pub const SEL_MAX: usize = 4000;

/// Viewer state shared by the commands and the webview callbacks.
#[derive(Debug, Default)]
pub struct ViewerShared {
    /// The viewer's own WebKit data store id, when the OS supports one.
    pub store_id: Option<[u8; 16]>,
    nonce: Mutex<Option<(String, Instant)>>,
    last_url: Mutex<String>,
}

impl ViewerShared {
    #[must_use]
    pub fn new(store_id: Option<[u8; 16]>) -> Self {
        Self {
            store_id,
            ..Self::default()
        }
    }

    /// Issue a fresh nonce for one selection read. Replaces any earlier one.
    pub fn issue(&self) -> String {
        let n = uuid::Uuid::new_v4().simple().to_string();
        if let Ok(mut g) = self.nonce.lock() {
            *g = Some((n.clone(), Instant::now()));
        }
        n
    }

    /// Accept `nonce` once, only if Patchroom issued it within [`NONCE_TTL`].
    pub fn redeem(&self, nonce: &str) -> bool {
        let Ok(mut g) = self.nonce.lock() else {
            return false;
        };
        match g.as_ref() {
            Some((n, at)) if n == nonce && at.elapsed() <= NONCE_TTL => {
                *g = None;
                true
            }
            _ => false,
        }
    }
}

/// What a blocked `patchroom-sel:` navigation carried: the selection and the page URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Selection {
    pub text: String,
    pub url: String,
}

/// Parse a hand-back URL. `None` unless it is `patchroom-sel:<nonce>?t=..&u=..` with a
/// redeemable nonce and an http(s) page URL.
#[must_use]
pub fn parse_selection(u: &Url, shared: &ViewerShared) -> Option<Selection> {
    if u.scheme() != SEL_SCHEME {
        return None;
    }
    let nonce = u.path();
    if nonce.is_empty() || !shared.redeem(nonce) {
        return None;
    }
    let mut text = String::new();
    let mut page = String::new();
    for (k, v) in u.query_pairs() {
        match k.as_ref() {
            "t" => text = v.chars().take(SEL_MAX).collect(),
            "u" => page = v.into_owned(),
            _ => {}
        }
    }
    let page = web_url(&page).ok()?;
    if text.trim().is_empty() {
        return None;
    }
    Some(Selection {
        text,
        url: page.to_string(),
    })
}

/// claude.ai sign-in state from a loaded page: `Some(false)` on a sign-in screen, `Some(true)`
/// on a page only a signed-in user reaches, `None` when the page says nothing either way.
#[must_use]
pub fn claude_signed_in(url: &str, title: &str) -> Option<bool> {
    let u = Url::parse(url).ok()?;
    let host = u.host_str()?;
    if host != "claude.ai" && !host.ends_with(".claude.ai") {
        return None;
    }
    let path = u.path();
    let t = title.trim();
    if ["/login", "/logout", "/magic-link"]
        .iter()
        .any(|p| path.starts_with(p))
        || t.starts_with("Sign in")
        || t.starts_with("Log in")
    {
        return Some(false);
    }
    if [
        "/new",
        "/chat/",
        "/recents",
        "/projects",
        "/project/",
        "/settings",
    ]
    .iter()
    .any(|p| path.starts_with(p))
    {
        return Some(true);
    }
    None
}

fn note_account(app: &AppHandle, url: &str, title: &str) {
    if let Some(signed_in) = claude_signed_in(url, title) {
        let _ = app.emit(
            "viewer:account",
            json!({ "service": "claude.ai", "signedIn": signed_in, "url": url }),
        );
    }
}

fn shared(app: &AppHandle) -> Option<tauri::State<'_, ViewerShared>> {
    app.try_state::<ViewerShared>()
}

/// The viewer webview's label.
pub const LABEL: &str = "viewer";

/// The pane's rectangle in CSS pixels of the main window.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// An `http(s)` URL, or why not.
pub fn web_url(s: &str) -> Result<Url, String> {
    let u = Url::parse(s.trim()).map_err(|e| format!("not a link: {e}"))?;
    match u.scheme() {
        "http" | "https" => Ok(u),
        other => Err(format!("only http and https links open, not {other}:")),
    }
}

/// Open `url` in the system default browser.
pub fn open_external(url: &str) -> Result<(), String> {
    let u = web_url(url)?;
    let ok = std::process::Command::new("/usr/bin/open")
        .arg(u.as_str())
        .status()
        .map_err(|e| e.to_string())?
        .success();
    ok.then_some(())
        .ok_or_else(|| "the browser did not open".into())
}

/// Show `url` in the viewer at `r`, creating the webview the first time.
pub fn show(app: &AppHandle, url: &str, r: Rect) -> Result<(), String> {
    let u = web_url(url)?;
    if let Some(w) = app.get_webview(LABEL) {
        w.navigate(u).map_err(|e| e.to_string())?;
        place(app, r)?;
        return w.show().map_err(|e| e.to_string());
    }
    create(app, u, r)
}

/// Build the viewer webview over `r`, loading `u`.
fn create(app: &AppHandle, u: Url, r: Rect) -> Result<(), String> {
    let win = app.get_window("main").ok_or("no main window")?;
    let (on_nav, on_load, on_title) = (app.clone(), app.clone(), app.clone());
    #[allow(unused_mut)]
    let mut builder = WebviewBuilder::new(LABEL, WebviewUrl::External(u))
        .on_navigation(move |u| {
            if u.scheme() == SEL_SCHEME {
                // Always blocked. Carried back only with a nonce Patchroom just issued.
                if let Some(sel) = shared(&on_nav).and_then(|s| parse_selection(u, &s)) {
                    let _ = on_nav.emit(
                        "viewer:selection",
                        json!({ "text": sel.text, "url": sel.url }),
                    );
                }
                return false;
            }
            matches!(u.scheme(), "http" | "https" | "about" | "blob" | "data")
        })
        .on_new_window(|u, _| {
            let _ = open_external(u.as_str());
            NewWindowResponse::Deny
        })
        .on_page_load(move |_, p| {
            let loading = p.event() == PageLoadEvent::Started;
            let url = p.url().as_str().to_owned();
            if let Some(s) = shared(&on_load) {
                if let Ok(mut g) = s.last_url.lock() {
                    g.clone_from(&url);
                }
            }
            if !loading {
                note_account(&on_load, &url, "");
            }
            let _ = on_load.emit("viewer:changed", json!({ "url": url, "loading": loading }));
        })
        .on_document_title_changed(move |_, title| {
            let url = shared(&on_title)
                .and_then(|s| s.last_url.lock().ok().map(|g| g.clone()))
                .unwrap_or_default();
            note_account(&on_title, &url, &title);
            let _ = on_title.emit("viewer:title", json!({ "title": title }));
        });
    #[cfg(target_os = "macos")]
    if let Some(id) = shared(app).and_then(|s| s.store_id) {
        builder = builder.data_store_identifier(id);
    }
    win.add_child(
        builder,
        LogicalPosition::new(r.x, r.y),
        LogicalSize::new(r.width, r.height),
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Move and size the viewer to the pane.
pub fn place(app: &AppHandle, r: Rect) -> Result<(), String> {
    let Some(w) = app.get_webview(LABEL) else {
        return Ok(());
    };
    w.set_position(LogicalPosition::new(r.x, r.y))
        .and_then(|()| w.set_size(LogicalSize::new(r.width.max(1.0), r.height.max(1.0))))
        .map_err(|e| e.to_string())
}

/// Hide the viewer (it keeps its page, so reopening is instant).
pub fn hide(app: &AppHandle) -> Result<(), String> {
    app.get_webview(LABEL)
        .map_or(Ok(()), |w| w.hide().map_err(|e| e.to_string()))
}

/// Back, forward or reload.
pub fn go(app: &AppHandle, action: &str) -> Result<(), String> {
    let Some(w) = app.get_webview(LABEL) else {
        return Ok(());
    };
    match action {
        "back" => w.eval("history.back()"),
        "forward" => w.eval("history.forward()"),
        "reload" => w.reload(),
        other => return Err(format!("unknown action {other:?}")),
    }
    .map_err(|e| e.to_string())
}

/// Show the viewer again over `r` without navigating (an overlay closed).
pub fn reveal(app: &AppHandle, r: Rect) -> Result<(), String> {
    let Some(w) = app.get_webview(LABEL) else {
        return Ok(());
    };
    place(app, r)?;
    w.show().map_err(|e| e.to_string())
}

/// A PNG data URL of the viewer's pixels under `r`, read from the window. The viewer stays as
/// it is: the UI shows the picture first, then hides the viewer, so nothing flashes blank.
pub fn snapshot(app: &AppHandle, r: Rect) -> Result<Option<String>, String> {
    if app.get_webview(LABEL).is_none() {
        return Ok(None);
    }
    let frame = crate::capture::window_rgba(app)?;
    let Some(c) = frame.crop(r) else {
        return Ok(None);
    };
    Ok(Some(crate::capture::data_url(&crate::capture::encode_png(
        &c,
    )?)))
}

/// Ask the viewer page for its selection. The answer arrives as a `viewer:selection` event,
/// or not at all (no selection, no viewer, a page that blocks scripts).
pub fn request_selection(app: &AppHandle) -> Result<bool, String> {
    let (Some(w), Some(s)) = (app.get_webview(LABEL), shared(app)) else {
        return Ok(false);
    };
    let nonce = s.issue();
    w.eval(selection_script(&nonce))
        .map_err(|e| e.to_string())?;
    Ok(true)
}

/// The one-shot script: read the selection, hand it back through a blocked navigation.
#[must_use]
pub fn selection_script(nonce: &str) -> String {
    format!(
        "(function(){{try{{var t=String(window.getSelection()||'').slice(0,{SEL_MAX});\
         if(!t.trim())return;\
         var h=location.href.split('#')[0];\
         location.href='{SEL_SCHEME}:{nonce}?t='+encodeURIComponent(t)+'&u='+encodeURIComponent(h);\
         }}catch(e){{}}}})();"
    )
}

/// Find `text` on the viewer page and scroll to it (a comment line's jump back).
pub fn find_text(app: &AppHandle, text: &str) -> Result<(), String> {
    let Some(w) = app.get_webview(LABEL) else {
        return Ok(());
    };
    let lit = serde_json::to_string(text).map_err(|e| e.to_string())?;
    w.eval(find_script(&lit)).map_err(|e| e.to_string())
}

/// Select the first text node holding `lit` (a JSON string literal) and scroll it into view.
/// A tree walk, not `window.find`, so it also works while the window is in the background.
#[must_use]
pub fn find_script(lit: &str) -> String {
    format!(
        "(function(){{var t={lit};try{{var w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);\
         for(var n=w.nextNode();n;n=w.nextNode()){{var i=n.data.indexOf(t);if(i<0)continue;\
         var r=document.createRange();r.setStart(n,i);r.setEnd(n,i+t.length);\
         var s=window.getSelection();s.removeAllRanges();s.addRange(r);\
         (n.parentElement||document.body).scrollIntoView({{block:'center'}});return;}}\
         window.find(t,false,false,true);}}catch(e){{}}}})();"
    )
}

/// Sign out of claude.ai in the viewer. With its own data store (macOS 14+) that store is
/// cleared: claude.ai and any other site signed in there. Without one (macOS 13) the store is
/// shared with the app, so only claude.ai's own sign-out page runs. Returns what happened.
pub fn sign_out(app: &AppHandle) -> Result<&'static str, String> {
    let separate = shared(app).is_some_and(|s| s.store_id.is_some()) && custom_store_os();
    if app.get_webview(LABEL).is_none() {
        if !separate {
            return Err("open a claude.ai page in the pane first".into());
        }
        // Not opened this run, but its store persists: open it blank and hidden to clear it.
        let blank = Url::parse("about:blank").map_err(|e| e.to_string())?;
        create(
            app,
            blank,
            Rect {
                x: 0.0,
                y: 0.0,
                width: 1.0,
                height: 1.0,
            },
        )?;
        hide(app)?;
    }
    let Some(w) = app.get_webview(LABEL) else {
        return Err("the pane did not open".into());
    };
    if separate {
        w.clear_all_browsing_data().map_err(|e| e.to_string())?;
        let _ = w.navigate(Url::parse("about:blank").map_err(|e| e.to_string())?);
        Ok("cleared")
    } else {
        w.navigate(Url::parse("https://claude.ai/logout").map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        Ok("logout")
    }
}

/// Whether WebKit supports a custom data store here (macOS 14 and later).
#[must_use]
pub fn custom_store_os() -> bool {
    if !cfg!(target_os = "macos") {
        return false;
    }
    static V: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *V.get_or_init(|| {
        std::process::Command::new("/usr/bin/sw_vers")
            .arg("-productVersion")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .and_then(|v| v.trim().split('.').next()?.parse::<u32>().ok())
            .is_some_and(|major| major >= 14)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_selection_needs_a_fresh_nonce_used_once() {
        let s = ViewerShared::default();
        let n = s.issue();
        let u = Url::parse(&format!(
            "patchroom-sel:{n}?t=Hello%20world&u=https%3A%2F%2Fclaude.ai%2Fartifact%2Fx"
        ))
        .unwrap();
        assert_eq!(
            parse_selection(&u, &s),
            Some(Selection {
                text: "Hello world".into(),
                url: "https://claude.ai/artifact/x".into()
            })
        );
        // Replayed: refused.
        assert_eq!(parse_selection(&u, &s), None);
        // Guessed or stale nonces: refused.
        let _ = s.issue();
        let bad = Url::parse("patchroom-sel:abc?t=x&u=https%3A%2F%2Fa.b%2F").unwrap();
        assert_eq!(parse_selection(&bad, &s), None);
        let n = s.issue();
        if let Ok(mut g) = s.nonce.lock() {
            g.as_mut().unwrap().1 = Instant::now().checked_sub(NONCE_TTL * 2).unwrap();
        }
        let old = Url::parse(&format!("patchroom-sel:{n}?t=x&u=https%3A%2F%2Fa.b%2F")).unwrap();
        assert_eq!(parse_selection(&old, &s), None);
    }

    #[test]
    fn a_selection_must_carry_text_and_a_web_page() {
        let s = ViewerShared::default();
        for q in [
            "t=&u=https%3A%2F%2Fa.b%2F",
            "t=x&u=file%3A%2F%2F%2Fetc",
            "t=x",
        ] {
            let n = s.issue();
            let u = Url::parse(&format!("patchroom-sel:{n}?{q}")).unwrap();
            assert_eq!(parse_selection(&u, &s), None, "{q}");
        }
        let n = s.issue();
        let long = "a".repeat(SEL_MAX + 50);
        let u = Url::parse(&format!(
            "patchroom-sel:{n}?t={long}&u=https%3A%2F%2Fa.b%2F"
        ))
        .unwrap();
        assert_eq!(parse_selection(&u, &s).unwrap().text.len(), SEL_MAX);
    }

    #[test]
    fn the_script_names_the_nonce_and_the_blocked_scheme() {
        let js = selection_script("n0nce");
        assert!(js.contains("patchroom-sel:n0nce?t="));
        assert!(js.contains("getSelection"));
    }

    #[test]
    fn claude_sign_in_state_comes_from_page_and_title() {
        assert_eq!(claude_signed_in("https://claude.ai/login", ""), Some(false));
        assert_eq!(
            claude_signed_in("https://claude.ai/artifact/abc", "Sign in · Claude"),
            Some(false)
        );
        assert_eq!(
            claude_signed_in("https://claude.ai/new", "Claude"),
            Some(true)
        );
        assert_eq!(
            claude_signed_in("https://claude.ai/artifact/abc", "Report"),
            None
        );
        assert_eq!(claude_signed_in("https://example.com/login", ""), None);
        assert_eq!(claude_signed_in("https://notclaude.ai/new", ""), None);
    }

    #[test]
    fn only_web_links_open() {
        assert!(web_url("https://claude.ai/artifact/CxWsf7").is_ok());
        assert!(web_url(" http://localhost:5173/ ").is_ok());
        for bad in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "mailto:a@b.c",
            "ftp://x",
            "nope",
        ] {
            assert!(web_url(bad).is_err(), "{bad}");
        }
    }
}
