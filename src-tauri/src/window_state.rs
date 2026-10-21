//! Remembers the main window's place between runs: its normal (restored) position and size, and
//! whether it was maximized. Kept in `window.json` in the data folder, so a portable copy keeps
//! its own. The window starts hidden and is shown once it has been put back where it was.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow, WindowEvent};

use crate::userdata::atomic;

pub const FILE: &str = "window.json";

/// Physical pixels, as Windows reports them; `maximized` restores on top of the normal bounds,
/// so un-maximizing returns to where the window was before.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Placement {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// How much of the window's top strip must land on a monitor for the saved position to be used:
/// enough to grab it: `GRAB` px of its width, and `GRIP` px of the top `TITLE` px. Otherwise (a
/// monitor was unplugged) the window opens centred, at the saved size.
const GRAB: i32 = 80;
const TITLE: i32 = 40;
const GRIP: i32 = 24;

/// True when the top strip of `p` overlaps some monitor enough to grab.
pub fn reachable(p: &Placement, monitors: &[Rect]) -> bool {
    monitors.iter().any(|m| {
        let left = p.x.max(m.x);
        let right = (p.x + p.width as i32).min(m.x + m.width as i32);
        let top = p.y.max(m.y);
        let bottom = (p.y + TITLE).min(m.y + m.height as i32);
        right - left >= GRAB && bottom - top >= GRIP
    })
}

pub fn load(path: &Path) -> Option<Placement> {
    let bytes = std::fs::read(path).ok()?;
    let p: Placement = serde_json::from_slice(atomic::strip_bom(&bytes)).ok()?;
    (p.width >= 200 && p.height >= 150).then_some(p)
}

/// The window's live placement, updated as it moves and resizes, written on exit.
pub struct Tracker {
    path: PathBuf,
    current: Mutex<Option<Placement>>,
}

impl Tracker {
    pub fn new(data_dir: &Path) -> Self {
        let path = data_dir.join(FILE);
        let current = Mutex::new(load(&path));
        Tracker { path, current }
    }

    /// Records the window's state. While maximized or minimized only the flag changes, so the
    /// normal bounds are kept for when it is restored.
    pub fn observe(&self, win: &WebviewWindow) {
        if win.is_minimized().unwrap_or(false) {
            return;
        }
        let maximized = win.is_maximized().unwrap_or(false);
        let mut cur = self.current.lock().unwrap_or_else(|e| e.into_inner());
        if maximized || win.is_fullscreen().unwrap_or(false) {
            if let Some(p) = cur.as_mut() {
                p.maximized = maximized;
            }
            return;
        }
        let (Ok(pos), Ok(size)) = (win.outer_position(), win.inner_size()) else { return };
        *cur = Some(Placement { x: pos.x, y: pos.y, width: size.width, height: size.height, maximized: false });
    }

    pub fn save(&self) {
        let cur = *self.current.lock().unwrap_or_else(|e| e.into_inner());
        let Some(p) = cur else { return };
        match serde_json::to_vec_pretty(&p) {
            Ok(bytes) => {
                if let Err(e) = atomic::write(&self.path, &bytes) {
                    tracing::warn!(error = %e, "could not save the window placement");
                }
            }
            Err(e) => tracing::warn!(error = %e, "could not encode the window placement"),
        }
    }

    /// Puts the window back where it was last time, then shows it.
    pub fn restore(&self, win: &WebviewWindow) {
        let saved = *self.current.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(p) = saved {
            let monitors: Vec<Rect> = win
                .available_monitors()
                .unwrap_or_default()
                .iter()
                .map(|m| Rect { x: m.position().x, y: m.position().y, width: m.size().width, height: m.size().height })
                .collect();
            let _ = win.set_size(PhysicalSize::new(p.width, p.height));
            if reachable(&p, &monitors) {
                let _ = win.set_position(PhysicalPosition::new(p.x, p.y));
            } else {
                let _ = win.center();
            }
            if p.maximized {
                let _ = win.maximize();
            }
        }
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Window events that change the placement.
pub fn on_event(app: &AppHandle, win: &tauri::Window, event: &WindowEvent) {
    if win.label() != "main" {
        return;
    }
    let Some(tracker) = app.try_state::<Tracker>() else { return };
    match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            if let Some(w) = app.get_webview_window("main") {
                tracker.observe(&w);
            }
        }
        WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed => tracker.save(),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PRIMARY: Rect = Rect { x: 0, y: 0, width: 1920, height: 1200 };
    const RIGHT: Rect = Rect { x: 1920, y: 0, width: 2560, height: 1440 };

    fn at(x: i32, y: i32) -> Placement {
        Placement { x, y, width: 1280, height: 800, maximized: false }
    }

    #[test]
    fn a_window_on_a_monitor_is_reachable() {
        assert!(reachable(&at(100, 100), &[PRIMARY]));
        assert!(reachable(&at(2200, 50), &[PRIMARY, RIGHT]));
        // Mostly off the right edge, but its title strip can still be grabbed.
        assert!(reachable(&at(1800, 100), &[PRIMARY]));
        // Windows' maximized frame overhangs each edge by a few pixels.
        assert!(reachable(&at(-8, -8), &[PRIMARY]));
    }

    #[test]
    fn a_window_on_an_unplugged_monitor_is_not() {
        assert!(!reachable(&at(2200, 50), &[PRIMARY]));
        assert!(!reachable(&at(100, 1190), &[PRIMARY]), "title strip below the screen");
        assert!(!reachable(&at(100, -700), &[PRIMARY]), "title strip above the screen");
        assert!(!reachable(&at(-1250, 100), &[PRIMARY]), "only 30 px showing");
    }

    #[test]
    fn saves_and_loads_and_rejects_nonsense() {
        let dir = tempfile::tempdir().unwrap();
        let t = Tracker::new(dir.path());
        assert!(t.current.lock().unwrap().is_none());
        *t.current.lock().unwrap() = Some(Placement { x: -8, y: -8, width: 1936, height: 1176, maximized: true });
        t.save();
        assert_eq!(load(&dir.path().join(FILE)), Some(Placement { x: -8, y: -8, width: 1936, height: 1176, maximized: true }));
        std::fs::write(dir.path().join(FILE), r#"{"x":0,"y":0,"width":20,"height":10,"maximized":false}"#).unwrap();
        assert_eq!(load(&dir.path().join(FILE)), None);
        std::fs::write(dir.path().join(FILE), "not json").unwrap();
        assert_eq!(load(&dir.path().join(FILE)), None);
    }
}
