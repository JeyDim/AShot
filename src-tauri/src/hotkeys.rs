//! Global hotkeys (PrintScreen by default).

use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};

use crate::state::{AppState, CaptureMode};

/// (Re)registers hotkeys from the settings. Returns human-readable errors for
/// combinations that could not be registered (taken by another application).
pub fn apply(app: &AppHandle) -> Vec<String> {
    let state = app.state::<AppState>();
    let hk = state.settings().hotkeys;
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let mut map = state.hotkeys.lock().unwrap();
    map.clear();
    let mut errors = Vec::new();
    let entries = [
        (CaptureMode::Region, hk.region, "Снимок области"),
        (CaptureMode::Window, hk.window, "Снимок окна"),
        (CaptureMode::Fullscreen, hk.fullscreen, "Весь экран"),
        (CaptureMode::LastRegion, hk.last_region, "Последняя область"),
    ];
    for (mode, accel, title) in entries {
        let accel = accel.trim();
        if accel.is_empty() {
            continue;
        }
        match accel.parse::<Shortcut>() {
            Ok(shortcut) => {
                if map.contains_key(&shortcut.id()) {
                    errors.push(format!("{title}: сочетание {accel} уже назначено другому действию"));
                    continue;
                }
                match gs.register(shortcut) {
                    Ok(()) => {
                        map.insert(shortcut.id(), mode);
                    }
                    Err(e) => errors.push(format!("{title}: {accel} занято другой программой ({e})")),
                }
            }
            Err(e) => errors.push(format!("{title}: не удалось разобрать «{accel}» ({e})")),
        }
    }
    for e in &errors {
        log::warn!("hotkey: {e}");
    }
    errors
}

pub fn suspend(app: &AppHandle) {
    let _ = app.global_shortcut().unregister_all();
    app.state::<AppState>().hotkeys.lock().unwrap().clear();
}

pub fn handle(app: &AppHandle, shortcut: &Shortcut, event: ShortcutEvent) {
    if event.state() != ShortcutState::Pressed {
        return;
    }
    let mode = app.state::<AppState>().hotkeys.lock().unwrap().get(&shortcut.id()).copied();
    if let Some(mode) = mode {
        crate::flow::start(app, mode);
    }
}
