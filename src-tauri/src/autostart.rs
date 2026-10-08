//! Autostart through tauri-plugin-autostart (the user's `Run` registry entry "AShot").

use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt;

/// Turns the OS autostart entry on or off.
pub fn set(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let launcher = app.autolaunch();
    if enabled { launcher.enable() } else { launcher.disable() }.map_err(|e| e.to_string())
}

/// Brings the entry in line with the setting at startup and removes what other versions
/// left behind.
pub fn sync(app: &AppHandle, enabled: bool) {
    legacy::remove_old_entries();
    if enabled != app.autolaunch().is_enabled().unwrap_or(false) {
        if let Err(e) = set(app, enabled) {
            log::warn!("autostart: {e}");
        }
    }
}

#[cfg(windows)]
mod legacy {
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::{FOLDERID_Startup, KF_FLAG_DEFAULT, SHGetKnownFolderPath};
    use windows::core::w;

    /// * Versions before the rename registered autostart as "AdvantShoter".
    /// * One build used a shortcut in the Startup folder instead; with it the app would
    ///   start twice.
    pub fn remove_old_entries() {
        use windows::Win32::System::Registry::{HKEY_CURRENT_USER, RegDeleteKeyValueW};
        for key in [
            w!(r"Software\Microsoft\Windows\CurrentVersion\Run"),
            w!(r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"),
        ] {
            let _ = unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, key, w!("AdvantShoter")) };
        }
        let startup = unsafe {
            SHGetKnownFolderPath(&FOLDERID_Startup, KF_FLAG_DEFAULT, None).ok().map(|dir| {
                let path = dir.to_string().ok();
                CoTaskMemFree(Some(dir.0 as *const _));
                path
            })
        };
        if let Some(dir) = startup.flatten() {
            let _ = std::fs::remove_file(std::path::Path::new(&dir).join("AShot.lnk"));
        }
    }
}

#[cfg(not(windows))]
mod legacy {
    pub fn remove_old_entries() {}
}
