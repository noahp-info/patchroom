//! Tauri app shell. Thin: window setup and command wiring only. Logic lives in
//! `patchroom-core`.

/// Build and run the Tauri application.
///
/// # Panics
/// Panics if the Tauri runtime fails to start.
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running Patchroom");
}
