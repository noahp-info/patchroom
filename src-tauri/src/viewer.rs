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

use serde::Deserialize;
use serde_json::json;
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl};

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
    let win = app.get_window("main").ok_or("no main window")?;
    let (on_load, on_title) = (app.clone(), app.clone());
    let builder = WebviewBuilder::new(LABEL, WebviewUrl::External(u))
        .on_navigation(|u| matches!(u.scheme(), "http" | "https" | "about" | "blob" | "data"))
        .on_new_window(|u, _| {
            let _ = open_external(u.as_str());
            NewWindowResponse::Deny
        })
        .on_page_load(move |_, p| {
            let loading = p.event() == PageLoadEvent::Started;
            let _ = on_load.emit(
                "viewer:changed",
                json!({ "url": p.url().as_str(), "loading": loading }),
            );
        })
        .on_document_title_changed(move |_, title| {
            let _ = on_title.emit("viewer:title", json!({ "title": title }));
        });
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

#[cfg(test)]
mod tests {
    use super::*;

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
