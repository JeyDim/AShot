//! Tray icon: left click opens the panel, right click shows a compact menu.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::image::Image;
use tauri::menu::{IconMenuItem, Menu, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Manager, PhysicalPosition, Position, Wry};

use crate::flow;
use crate::state::{AppState, CaptureMode};
use crate::ui;

fn physical(p: &Position) -> PhysicalPosition<i32> {
    match p {
        Position::Physical(p) => *p,
        Position::Logical(l) => PhysicalPosition::new(l.x as i32, l.y as i32),
    }
}

/// The menu was built for the dark mode (it is rebuilt when Windows switches).
static DARK: AtomicBool = AtomicBool::new(false);

/// The tray menu follows the Windows mode for apps (dark / light), not the theme setting.
#[cfg(windows)]
fn menu_is_dark() -> bool {
    use windows::Win32::System::Registry::{HKEY_CURRENT_USER, RRF_RT_REG_DWORD, RegGetValueW};
    use windows::core::w;
    let mut light: u32 = 1;
    let mut size = std::mem::size_of::<u32>() as u32;
    let found = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            w!(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"),
            w!("AppsUseLightTheme"),
            RRF_RT_REG_DWORD,
            None,
            Some(&mut light as *mut u32 as *mut _),
            Some(&mut size),
        )
    };
    found.is_ok() && light == 0
}

#[cfg(not(windows))]
fn menu_is_dark() -> bool {
    false
}

/// Icon of a menu item: a 16 px mask (`npm run menu-icons`; the menu draws its icons at
/// 16 × 16) in the color of the menu text.
fn icon(id: &str, dark: bool) -> Option<Image<'static>> {
    let png: &[u8] = match id {
        "region" => include_bytes!("../icons/menu/region.png"),
        "window" => include_bytes!("../icons/menu/window.png"),
        "fullscreen" => include_bytes!("../icons/menu/fullscreen.png"),
        "scroll" => include_bytes!("../icons/menu/scroll.png"),
        "panel" => include_bytes!("../icons/menu/panel.png"),
        "settings" => include_bytes!("../icons/menu/settings.png"),
        "about" => include_bytes!("../icons/menu/about.png"),
        "quit" => include_bytes!("../icons/menu/quit.png"),
        _ => return None,
    };
    let mut mask = image::load_from_memory_with_format(png, image::ImageFormat::Png).ok()?.into_rgba8();
    let color = if dark { [0xFF, 0xFF, 0xFF] } else { [0x11, 0x11, 0x11] };
    for p in mask.pixels_mut() {
        p.0[..3].copy_from_slice(&color);
    }
    let (w, h) = mask.dimensions();
    Some(Image::new_owned(mask.into_raw(), w, h))
}

/// The right-click menu; the scrolling capture is there when its experiment is on.
fn menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let dark = menu_is_dark();
    DARK.store(dark, Ordering::Relaxed);
    let item = |id: &str, text: &str| IconMenuItem::with_id(app, id, text, true, icon(id, dark), None::<&str>);
    let menu = Menu::with_items(app, &[&item("region", "Снимок области")?, &item("window", "Снимок окна")?, &item("fullscreen", "Весь экран")?])?;
    if app.state::<AppState>().settings().experimental.scroll_capture {
        menu.append(&item("scroll", "Снимок с прокруткой")?)?;
    }
    menu.append_items(&[
        &PredefinedMenuItem::separator(app)?,
        &item("panel", "Недавние снимки")?,
        &item("settings", "Настройки")?,
        &item("about", "О программе")?,
        &PredefinedMenuItem::separator(app)?,
        &item("quit", "Выход")?,
    ])?;
    Ok(menu)
}

/// Windows switched between the dark and light mode: icons in the other color.
pub fn theme_changed(app: &AppHandle) {
    if menu_is_dark() != DARK.load(Ordering::Relaxed) {
        refresh(app);
    }
}

/// Rebuilds the menu (the experiments or the Windows mode changed).
pub fn refresh(app: &AppHandle) {
    let Some(tray) = app.tray_by_id("main") else { return };
    match menu(app) {
        Ok(menu) => {
            let _ = tray.set_menu(Some(menu));
        }
        Err(e) => log::warn!("tray menu: {e}"),
    }
}

pub fn create(app: &App) -> tauri::Result<()> {
    let menu = menu(app.handle())?;
    let icon = app.default_window_icon().cloned().expect("bundle icon");
    TrayIconBuilder::with_id("main")
        .icon(icon)
        .tooltip(match crate::state::channel() {
            "" => "AShot — скриншоты".to_string(),
            channel => format!("AShot Dev — {channel}"),
        })
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
