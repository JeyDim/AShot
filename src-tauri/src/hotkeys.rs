//! Global hotkeys (PrintScreen by default).

use shoter_core::settings::hotkey_label;
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};

use crate::state::{AppState, CaptureMode};

/// (Re)registers hotkeys from the settings. Returns human-readable errors for
/// combinations that could not be registered (taken by another application).
pub fn apply(app: &AppHandle) -> Vec<String> {
    let state = app.state::<AppState>();
    let settings = state.settings();
    let hk = settings.hotkeys;
    let gs = app.global_shortcut();
    // Registration runs on the main thread and blocks this one, so never hold the
    // `hotkeys` lock here (the hotkey handler on the main thread takes it).
    state.hotkeys.lock().unwrap().clear();
    let _ = gs.unregister_all();
    let mut map = std::collections::HashMap::new();
    let mut errors = Vec::new();
    let entries = [
        (CaptureMode::Region, hk.region, "Снимок области"),
        (CaptureMode::WindowPick, hk.window, "Снимок окна"),
        (CaptureMode::Fullscreen, hk.fullscreen, "Весь экран"),
        // An experiment: only when turned on in Settings.
        (CaptureMode::Scroll, if settings.experimental.scroll_capture { hk.scroll } else { String::new() }, "Снимок с прокруткой"),
    ];
    for (mode, accel, title) in entries {
        let accel = accel.trim();
        if accel.is_empty() {
            continue;
        }
        let label = hotkey_label(accel);
        match accel.parse::<Shortcut>() {
            Ok(shortcut) => {
                if map.contains_key(&shortcut.id()) {
                    errors.push(format!("{title}: сочетание {label} уже назначено другому действию"));
                    continue;
                }
                match gs.register(shortcut) {
                    Ok(()) => {
                        map.insert(shortcut.id(), mode);
                    }
                    Err(e) => errors.push(format!("{title}: {label} занято другой программой ({e})")),
                }
            }
            Err(e) => errors.push(format!("{title}: не удалось разобрать «{label}» ({e})")),
        }
    }
    *state.hotkeys.lock().unwrap() = map;
    for e in &errors {
        log::warn!("hotkey: {e}");
    }
    errors
}

pub fn suspend(app: &AppHandle) {
    app.state::<AppState>().hotkeys.lock().unwrap().clear();
    let _ = app.global_shortcut().unregister_all();
}

pub fn handle(app: &AppHandle, shortcut: &Shortcut, event: ShortcutEvent) {
    if event.state() != ShortcutState::Pressed {
        return;
    }
    // Esc is registered only while a scrolling capture runs: it stops it.
    if crate::scroll::is_stop_key(shortcut) {
        crate::scroll::stop(app);
        return;
    }
    let mode = app.state::<AppState>().hotkeys.lock().unwrap().get(&shortcut.id()).copied();
    if let Some(mode) = mode {
        crate::flow::start(app, mode);
    }
}
