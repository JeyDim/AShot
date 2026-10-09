//! AShot — tray screenshot tool: region / window / full-screen capture with
//! window and UI-element highlighting, annotation editor, temporary history of recent
//! screenshots and publishing to Box.com with links on the custom proxy domain.

mod actions;
mod autostart;
mod capture;
mod clipboard;
mod commands;
mod flow;
mod hotkeys;
mod overlay;
mod protocol;
mod scroll;
mod secrets;
mod state;
mod tray;
mod ui;
#[cfg(windows)]
mod uiselect;
mod updater;

use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;

use state::{AppState, CaptureMode};
use ui::Toast;

/// Command line: `--capture region|window|fullscreen|scroll`, `--panel`, `--autostart`.
fn handle_args(app: &AppHandle, args: &[String], from_second_instance: bool) {
    let mut iter = args.iter().skip(1);
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--capture" => {
                let mode = match iter.next().map(String::as_str) {
                    Some("window") => CaptureMode::WindowPick,
                    Some("fullscreen") => CaptureMode::Fullscreen,
                    Some("scroll") => CaptureMode::Scroll,
                    _ => CaptureMode::Region,
                };
                flow::start(app, mode);
                return;
            }
            "--panel" => {
                ui::show_panel(app, None);
                return;
            }
            _ => {}
        }
    }
    if from_second_instance {
        // Launching the app again (Start menu, shortcut) opens the panel.
        ui::show_panel(app, None);
    }
}

pub fn run() {
    // After a portable self-update the new exe starts before the old one has exited.
    updater::wait_for_previous_instance(&std::env::args().collect::<Vec<_>>());
    tauri::Builder::default()
        // Must be the first plugin.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| handle_args(app, &argv, true)))
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .max_file_size(2_000_000)
                .target(tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir { file_name: None }))
                .build(),
        )
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(hotkeys::handle).build())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--autostart"])))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .register_asynchronous_uri_scheme_protocol("shot", protocol::handle)
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::settings_get,
            commands::settings_patch,
            commands::hotkeys_suspend,
            commands::capture,
            commands::overlay_pending,
            commands::overlay_ready,
            commands::overlay_save_path,
            commands::overlay_finish,
            commands::overlay_finish_annotated,
            commands::overlay_cancel,
            commands::overlay_hit_test,
            commands::overlay_scroll_target,
            commands::scroll_stop,
            commands::history_list,
            commands::history_get,
            commands::history_annotations,
            commands::history_delete,
            commands::history_clear,
            commands::history_open,
            commands::history_copy,
            commands::history_copy_link,
            commands::history_save,
            commands::history_save_as,
            commands::history_upload,
            commands::editor_commit,
            commands::watermark_pick,
            commands::watermark_clear,
            commands::open_settings,
            commands::ui_zoom,
            commands::panel_hide,
            commands::toast_current,
            commands::toast_hide,
            commands::quit,
            commands::copy_text,
            commands::open_url,
            commands::reveal_path,
            commands::open_folder,
            commands::pick_folder,
            commands::box_status,
            commands::box_set_secret,
            commands::box_test,
            commands::box_login,
            commands::box_logout,
            commands::link_preview,
            commands::update_state,
            commands::update_check,
            commands::update_install,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let state = AppState::new(&handle).map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
            app.manage(state);

            tray::create(app)?;
            // Pre-create hidden windows so the panel, toasts and overlays appear instantly.
            ui::create_panel(&handle)?;
            ui::create_toast(&handle)?;
            overlay::precreate(&handle, &capture::monitors());

            let problems = hotkeys::apply(&handle);
            let state = handle.state::<AppState>();
            let settings = state.settings();

            // Keep the OS autostart entry in sync with the setting.
            autostart::sync(&handle, settings.autostart);

            updater::cleanup();
            updater::start(&handle);

            if !problems.is_empty() {
                ui::toast(
                    &handle,
                    Toast::error("Горячие клавиши не назначены", problems.join("\n")).timeout(15000),
                );
            } else if !settings.welcomed {
                let hk = &settings.hotkeys;
                let scroll = settings.experimental.scroll_capture;
                let keys: Vec<String> = [(&hk.region, "область"), (&hk.window, "окно"), (&hk.fullscreen, "экран"), (&hk.scroll, "с прокруткой")]
                    .into_iter()
                    .filter(|(accel, what)| !accel.trim().is_empty() && (scroll || *what != "с прокруткой"))
                    .map(|(accel, what)| format!("{} — {what}", shoter_core::settings::hotkey_label(accel)))
                    .collect();
                let first = if keys.is_empty() { String::new() } else { format!("{}. ", keys.join(", ")) };
                ui::toast(
                    &handle,
                    Toast::info(format!("{} работает в трее", handle.package_info().name))
                        .message(format!("{first}Клик по иконке в трее — меню и последние снимки."))
                        .timeout(9000),
                );
                state.update_settings(|s| s.welcomed = true);
            }

            let args: Vec<String> = std::env::args().collect();
            handle_args(&handle, &args, false);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building AShot")
        .run(|app, event| match event {
            // Tray application: closing the last window must not quit.
            RunEvent::ExitRequested { code: None, api, .. } => api.prevent_exit(),
            // Windows switched dark / light (the overlays, always there, follow it).
            RunEvent::WindowEvent { event: WindowEvent::ThemeChanged(_), .. } => tray::theme_changed(app),
            _ => {}
        });
}
