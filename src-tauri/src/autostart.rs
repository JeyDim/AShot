//! Autostart: a shortcut in the user's Startup folder (`shell:startup`). Windows lists it
//! in Settings → Apps → Startup and in Task Manager; no admin rights and no registry `Run`
//! key (antivirus software flags those).

/// Command-line flag of the shortcut: start quietly in the tray.
pub const ARG: &str = "--autostart";

/// Creates (or points to the current exe) or removes the shortcut.
pub fn set(enabled: bool) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    imp::set(enabled, &exe)
}

/// Brings the shortcut in line with the setting at startup (the exe may have moved) and
/// removes the registry entries that earlier versions created.
pub fn sync(enabled: bool) {
    imp::remove_legacy_registry_entries();
    if let Err(e) = set(enabled) {
        log::warn!("autostart: {e}");
    }
}

#[cfg(windows)]
mod imp {
    use std::path::{Path, PathBuf};

    use windows::Win32::System::Com::{
        CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize,
        IPersistFile,
    };
    use windows::Win32::UI::Shell::{FOLDERID_Startup, IShellLinkW, KF_FLAG_DEFAULT, SHGetKnownFolderPath, ShellLink};
    use windows::core::{HSTRING, Interface, w};

    const SHORTCUT: &str = "AShot.lnk";

    fn shortcut_path() -> Result<PathBuf, String> {
        unsafe {
            let dir = SHGetKnownFolderPath(&FOLDERID_Startup, KF_FLAG_DEFAULT, None).map_err(|e| e.to_string())?;
            let path = dir.to_string().map_err(|e| e.to_string());
            CoTaskMemFree(Some(dir.0 as *const _));
            Ok(PathBuf::from(path?).join(SHORTCUT))
        }
    }

    pub fn set(enabled: bool, exe: &Path) -> Result<(), String> {
        let path = shortcut_path()?;
        if !enabled {
            return match std::fs::remove_file(&path) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
                _ => Ok(()),
            };
        }
        // COM on a short-lived thread of its own: works from any caller thread.
        let exe = exe.to_path_buf();
        std::thread::spawn(move || unsafe {
            let initialized = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
            let result = create_shortcut(&path, &exe);
            if initialized {
                CoUninitialize();
            }
            result
        })
        .join()
        .map_err(|_| "сбой при создании ярлыка".to_string())?
    }

    unsafe fn create_shortcut(path: &Path, exe: &Path) -> Result<(), String> {
        let e = |e: windows::core::Error| format!("не удалось создать ярлык автозапуска: {e}");
        unsafe {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).map_err(e)?;
            link.SetPath(&HSTRING::from(exe.as_os_str())).map_err(e)?;
            link.SetArguments(&HSTRING::from(super::ARG)).map_err(e)?;
            if let Some(dir) = exe.parent() {
                link.SetWorkingDirectory(&HSTRING::from(dir.as_os_str())).map_err(e)?;
            }
            link.SetIconLocation(&HSTRING::from(exe.as_os_str()), 0).map_err(e)?;
            link.SetDescription(w!("AShot — скриншоты из трея")).map_err(e)?;
            link.cast::<IPersistFile>().map_err(e)?.Save(&HSTRING::from(path.as_os_str()), true).map_err(e)
        }
    }

    /// Earlier versions (tauri-plugin-autostart) used the `Run` registry key, also under the
    /// old name "AdvantShoter". Only deletes values — nothing is written to the registry.
    pub fn remove_legacy_registry_entries() {
        use windows::Win32::System::Registry::{HKEY_CURRENT_USER, RegDeleteKeyValueW};
        for key in [
            w!(r"Software\Microsoft\Windows\CurrentVersion\Run"),
            w!(r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"),
        ] {
            for name in [w!("AShot"), w!("AdvantShoter")] {
                let _ = unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, key, name) };
            }
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn set(_enabled: bool, _exe: &std::path::Path) -> Result<(), String> {
        Ok(())
    }

    pub fn remove_legacy_registry_entries() {}
}
