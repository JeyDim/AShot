//! Tray icon: left click opens the panel, right click shows a compact menu.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, PhysicalPosition, Position};

use crate::flow;
use crate::state::CaptureMode;
use crate::ui;

fn physical(p: &Position) -> PhysicalPosition<i32> {
    match p {
        Position::Physical(p) => *p,
        Position::Logical(l) => PhysicalPosition::new(l.x as i32, l.y as i32),
    }
}

pub fn create(app: &App) -> tauri::Result<()> {
    let item = |id: &str, text: &str| MenuItem::with_id(app, id, text, true, None::<&str>);
    let menu = Menu::with_items(
        app,
        &[
            &item("region", "Снимок области")?,
            &item("window", "Снимок окна")?,
            &item("fullscreen", "Весь экран")?,
            &item("scroll", "Снимок с прокруткой")?,
            &PredefinedMenuItem::separator(app)?,
            &item("panel", "Недавние снимки")?,
            &item("settings", "Настройки")?,
            &item("about", "О программе")?,
            &PredefinedMenuItem::separator(app)?,
            &item("quit", "Выход")?,
        ],
    )?;
    let icon = app.default_window_icon().cloned().expect("bundle icon");
    TrayIconBuilder::with_id("main")
        .icon(icon)
        .tooltip("AShot — скриншоты")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app: &AppHandle, event| match event.id().as_ref() {
            "region" => flow::start(app, CaptureMode::Region),
            "window" => flow::start(app, CaptureMode::WindowPick),
            "fullscreen" => flow::start(app, CaptureMode::Fullscreen),
            "scroll" => flow::start(app, CaptureMode::Scroll),
            "panel" => ui::show_panel(app, None),
            "settings" => ui::open_settings(app, None),
            "about" => ui::open_about(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, rect, .. } => {
                let p = physical(&rect.position);
                let size = rect.size.to_physical::<i32>(1.0);
                ui::toggle_panel(tray.app_handle(), Some((p.x + size.width / 2, p.y + size.height / 2)));
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}
