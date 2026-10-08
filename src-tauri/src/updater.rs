//! Self-update from the manifest `latest.json` of the latest release: on an own server
//! (`SHOTER_UPDATE_URL`, e.g. IIS mirroring the releases) or on GitHub (`SHOTER_UPDATE_REPO`,
//! set by CI). An installed copy runs the new NSIS installer in update mode (it closes the
//! app and starts it again); a portable exe is replaced in place.

use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use shoter_core::updates::{self, InstallKind, Manifest};
use tauri::{AppHandle, Emitter, Manager};

use crate::state::AppState;
use crate::ui::{self, Toast};

const FIRST_CHECK: Duration = Duration::from_secs(30);
const CHECK_EVERY: Duration = Duration::from_secs(6 * 3600);
/// While something is open, an automatic install waits this long between attempts.
const IDLE_RETRY: Duration = Duration::from_secs(10 * 60);

/// Where `latest.json` comes from: the own server if the build has one, otherwise the
/// GitHub releases of the repository the build came from. Local builds have neither.
static MANIFEST_URL: LazyLock<Option<String>> = LazyLock::new(|| {
    option_env!("SHOTER_UPDATE_URL")
        .and_then(updates::manifest_url)
        .or_else(|| option_env!("SHOTER_UPDATE_REPO").filter(|r| !r.trim().is_empty()).map(|r| updates::github_manifest_url(r.trim())))
});

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "phase", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum UpdateState {
    /// Local build without an update source.
    Disabled,
    Idle,
    Checking,
    UpToDate,
    Available { version: String, notes: String, url: String },
    Downloading { version: String, downloaded: u64, total: u64 },
    Installing { version: String },
    Error { message: String },
}

static STATE: LazyLock<Mutex<UpdateState>> =
    LazyLock::new(|| Mutex::new(if MANIFEST_URL.is_some() { UpdateState::Idle } else { UpdateState::Disabled }));
static LATEST: Mutex<Option<Manifest>> = Mutex::new(None);
static BUSY: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub fn state() -> UpdateState {
    STATE.lock().unwrap().clone()
}

fn set_state(app: &AppHandle, s: UpdateState) {
    *STATE.lock().unwrap() = s.clone();
    let _ = app.emit("update:state", s);
}

fn current_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Reads the manifest of the latest release.
pub async fn check(app: &AppHandle) -> UpdateState {
    let Some(url) = MANIFEST_URL.as_deref() else { return UpdateState::Disabled };
    let Ok(_busy) = BUSY.try_lock() else { return state() };
    set_state(app, UpdateState::Checking);
    let next = match updates::fetch_manifest(&shoter_core::boxapi::http_client(), url).await {
        Ok(manifest) if updates::is_newer(&manifest.version, &current_version(app)) => {
            let s = UpdateState::Available { version: manifest.version.clone(), notes: manifest.notes.clone(), url: manifest.url.clone() };
            *LATEST.lock().unwrap() = Some(manifest);
            s
        }
        Ok(_) | Err(updates::UpdateError::NoReleases) => UpdateState::UpToDate,
        Err(e) => {
            log::warn!("update check failed ({url}): {e}");
            UpdateState::Error { message: format!("Не удалось проверить обновления: {e}") }
        }
    };
    set_state(app, next.clone());
    next
}

/// Downloads and starts installing the version found by [`check`]; the app then exits
/// and is started again by the installer (or by the new portable exe).
pub async fn install(app: &AppHandle) -> Result<(), String> {
    if LATEST.lock().unwrap().is_none() {
        check(app).await;
    }
    let manifest = LATEST.lock().unwrap().clone().ok_or("обновлений нет")?;
    let _busy = BUSY.lock().await;
    let result = download_and_run(app, &manifest).await;
    if let Err(e) = &result {
        log::error!("update failed: {e}");
        set_state(app, UpdateState::Error { message: format!("Не удалось обновить: {e}") });
    }
    result
}

async fn download_and_run(app: &AppHandle, manifest: &Manifest) -> Result<(), String> {
    let version = manifest.version.clone();
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let kind = install_kind(&exe);
    let entry = manifest.file(kind).ok_or("в обновлении нет файла для этой установки")?.clone();
    if kind == InstallKind::Portable && !dir_writable(exe.parent().unwrap_or(Path::new("."))) {
        return Err("нет прав на запись в папку программы — скачайте новую версию вручную".into());
    }
    let url = updates::file_url(MANIFEST_URL.as_deref().unwrap_or_default(), &entry).map_err(|e| e.to_string())?;
    let name = url.rsplit('/').next().filter(|n| n.to_ascii_lowercase().ends_with(".exe")).unwrap_or("AShot-update.exe");

    let dir = std::env::temp_dir().join("AShot-update");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(name);
    set_state(app, UpdateState::Downloading { version: version.clone(), downloaded: 0, total: entry.size });
    let mut last_emit = Instant::now();
    updates::download(&shoter_core::boxapi::http_client(), &url, &entry, &file, |downloaded, total| {
        if last_emit.elapsed() > Duration::from_millis(150) || downloaded == total {
            last_emit = Instant::now();
            set_state(app, UpdateState::Downloading { version: version.clone(), downloaded, total });
        }
    })
    .await
    .map_err(|e| e.to_string())?;

    set_state(app, UpdateState::Installing { version: version.clone() });
    log::info!("installing update {version} ({kind:?}) from {url}");
    match kind {
        // Passive install over the current one; /R starts the app again afterwards.
        InstallKind::Installer => {
            std::process::Command::new(&file).args(["/P", "/UPDATE", "/R"]).spawn().map_err(|e| e.to_string())?;
        }
        InstallKind::Portable => {
            replace_exe(&exe, &file)?;
            // The new process waits for this one to exit (single-instance lock).
            std::process::Command::new(&exe)
                .args(["--wait-pid", &std::process::id().to_string()])
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }
    app.exit(0);
    Ok(())
}

/// NSIS installs put `uninstall.exe` next to the program.
fn install_kind(exe: &Path) -> InstallKind {
    match exe.parent() {
        Some(dir) if dir.join("uninstall.exe").exists() => InstallKind::Installer,
        _ => InstallKind::Portable,
    }
}

fn dir_writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".ashot-write-{}", std::process::id()));
    let ok = std::fs::write(&probe, b"").is_ok();
    let _ = std::fs::remove_file(&probe);
    ok
}

fn old_exe_path(exe: &Path) -> PathBuf {
    let stem = exe.file_stem().and_then(|s| s.to_str()).unwrap_or("AShot");
    exe.with_file_name(format!("{stem}.old.exe"))
}

/// A running exe cannot be overwritten on Windows, but it can be renamed: move it aside,
/// put the new one in its place (the old file is deleted on the next start).
fn replace_exe(exe: &Path, new: &Path) -> Result<(), String> {
    let old = old_exe_path(exe);
    let _ = std::fs::remove_file(&old);
    std::fs::rename(exe, &old).map_err(|e| format!("не удалось переименовать программу: {e}"))?;
    if let Err(e) = std::fs::copy(new, exe) {
        let _ = std::fs::rename(&old, exe);
        return Err(format!("не удалось записать новую версию: {e}"));
    }
    let _ = std::fs::remove_file(new);
    Ok(())
}

/// Removes leftovers of a previous update.
pub fn cleanup() {
    if let Ok(exe) = std::env::current_exe() {
        let _ = std::fs::remove_file(old_exe_path(&exe));
    }
    let _ = std::fs::remove_dir_all(std::env::temp_dir().join("AShot-update"));
}

/// `--wait-pid <pid>`: wait until the previous instance has exited (portable update).
pub fn wait_for_previous_instance(args: &[String]) {
    let Some(pid) = args.iter().position(|a| a == "--wait-pid").and_then(|i| args.get(i + 1)).and_then(|p| p.parse::<u32>().ok())
    else {
        return;
    };
    wait_for_process(pid, Duration::from_secs(15));
}

#[cfg(windows)]
fn wait_for_process(pid: u32, timeout: Duration) {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE};
    unsafe {
        if let Ok(handle) = OpenProcess(PROCESS_SYNCHRONIZE, false, pid) {
            let _ = WaitForSingleObject(handle, timeout.as_millis() as u32);
            let _ = CloseHandle(handle);
        }
    }
}

#[cfg(not(windows))]
fn wait_for_process(_pid: u32, _timeout: Duration) {
    std::thread::sleep(Duration::from_secs(1));
}

/// Nothing the user works with is open: no panel, overlay, editor or settings.
fn is_idle(app: &AppHandle) -> bool {
    app.webview_windows().values().all(|w| w.label() == ui::TOAST || !w.is_visible().unwrap_or(false))
}

/// "Updated to …" after a restart, then periodic checks; with auto-update on, a new
/// version is installed as soon as nothing is open.
pub fn start(app: &AppHandle) {
    let state = app.state::<AppState>();
    let version = current_version(app);
    let previous = state.settings().last_version;
    if previous != version {
        if !previous.is_empty() && updates::is_newer(&version, &previous) {
            ui::toast(app, Toast::success("AShot обновлён").message(format!("Версия {version}")).timeout(6000));
        }
        state.update_settings(|s| s.last_version = version.clone());
    }
    if MANIFEST_URL.is_none() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        loop {
            if let UpdateState::Available { version, .. } = check(&app).await {
                auto_install(&app, &version).await;
            }
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}

async fn auto_install(app: &AppHandle, version: &str) {
    if !app.state::<AppState>().settings().auto_update {
        ui::toast(
            app,
            Toast::info(format!("Доступна версия AShot {version}")).message("Обновить: Настройки → О программе").timeout(9000),
        );
        return;
    }
    // Don't restart the app under the user's hands: wait until nothing is open.
    for _ in 0..(CHECK_EVERY.as_secs() / IDLE_RETRY.as_secs()) {
        if !app.state::<AppState>().settings().auto_update {
            return;
        }
        if is_idle(app) {
            ui::toast(app, Toast::progress(format!("Обновление до {version}")).message("AShot перезапустится через пару секунд"));
            if install(app).await.is_err() {
                ui::toast(app, Toast::error("Не удалось обновить AShot", "Подробности — в «Настройки → О программе»"));
            }
            return;
        }
        tokio::time::sleep(IDLE_RETRY).await;
    }
}
