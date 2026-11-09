//! Puts a launched program's windows on the monitor Vellum is on (`ctx.run(..., { sameMonitor:
//! true })`). An emulator such as PCSX2 reopens wherever its window was last time, fullscreen
//! included, and has no command-line option for a monitor; so after its windows appear, any on
//! another monitor is moved: a window filling its monitor (fullscreen) is made to fill Vellum's,
//! a smaller one keeps its size and its place relative to the work area.
//!
//! The watch lasts a few seconds after the first window appears (a program may show a window and
//! then go fullscreen), then stops, so a window the player moves later is left alone. A window
//! moved as fullscreen is held there during the watch: a Qt program (PCSX2) moved onto a monitor
//! with a different scale re-applies its old size once, which would leave it covering only part
//! of the screen.

use tauri::AppHandle;

/// Pure placement maths, testable anywhere. Rectangles are (left, top, right, bottom).
pub mod plan {
    pub type Rect = (i32, i32, i32, i32);

    fn size(r: Rect) -> (i32, i32) {
        (r.2 - r.0, r.3 - r.1)
    }

    /// Where `win` goes when moving from the monitor `from` (its full area and work area) to `to`.
    /// `framed`: it has a title bar, so even a window as big as its monitor isn't fullscreen.
    pub fn move_to(win: Rect, framed: bool, from_full: Rect, from_work: Rect, to_full: Rect, to_work: Rect) -> Rect {
        // Fullscreen: a frameless window covering its whole monitor.
        if !framed && win.0 <= from_full.0 && win.1 <= from_full.1 && win.2 >= from_full.2 && win.3 >= from_full.3 {
            return to_full;
        }
        let (w, h) = size(win);
        let (tw, th) = size(to_work);
        let (w, h) = (w.min(tw), h.min(th));
        // Keep its place: the same share of the free space on either side.
        let (fw, fh) = size(from_work);
        let share = |offset: i32, free: i32| if free > 0 { (offset.clamp(0, free) as f64) / free as f64 } else { 0.5 };
        let sx = share(win.0 - from_work.0, fw - size(win).0);
        let sy = share(win.1 - from_work.1, fh - size(win).1);
        let x = to_work.0 + ((tw - w) as f64 * sx).round() as i32;
        let y = to_work.1 + ((th - h) as f64 * sy).round() as i32;
        (x, y, x + w, y + h)
    }
}

#[cfg(windows)]
pub fn follow(app: &AppHandle, pid: u32) {
    use tauri::Manager;
    let Some(win) = app.get_webview_window("main") else { return };
    let Ok(hwnd) = win.hwnd() else { return };
    let vellum = hwnd.0 as isize;
    let _ = std::thread::Builder::new().name(format!("place-{pid}")).spawn(move || imp::watch(vellum, pid));
}

#[cfg(not(windows))]
pub fn follow(_app: &AppHandle, _pid: u32) {}

#[cfg(windows)]
mod imp {
    use std::time::{Duration, Instant};

    use windows_sys::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows_sys::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, HMONITOR, MONITORINFO, MONITOR_DEFAULTTONEAREST};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindow, GetWindowLongW, GetWindowRect, GetWindowThreadProcessId, IsWindowVisible, SetWindowPos, GWL_STYLE, GW_OWNER, SWP_NOACTIVATE,
        SWP_NOZORDER, WS_CAPTION,
    };

    use super::plan::{self, Rect};

    /// How long to wait for the first window (an emulator may take a while to start).
    const FIRST_WINDOW: Duration = Duration::from_secs(30);
    /// How long to keep correcting after it appears.
    const SETTLE: Duration = Duration::from_secs(6);
    const POLL: Duration = Duration::from_millis(120);

    fn rect(r: RECT) -> Rect {
        (r.left, r.top, r.right, r.bottom)
    }

    fn monitor(m: HMONITOR) -> Option<(Rect, Rect)> {
        let mut info: MONITORINFO = unsafe { std::mem::zeroed() };
        info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        (unsafe { GetMonitorInfoW(m, &mut info) } != 0).then(|| (rect(info.rcMonitor), rect(info.rcWork)))
    }

    /// The process's visible, unowned top-level windows.
    fn windows_of(pid: u32) -> Vec<HWND> {
        struct Find {
            pid: u32,
            found: Vec<HWND>,
        }
        unsafe extern "system" fn each(h: HWND, l: LPARAM) -> i32 {
            let f = unsafe { &mut *(l as *mut Find) };
            let mut owner_pid = 0u32;
            unsafe { GetWindowThreadProcessId(h, &mut owner_pid) };
            if owner_pid == f.pid && unsafe { IsWindowVisible(h) } != 0 && unsafe { GetWindow(h, GW_OWNER) }.is_null() {
                let mut r: RECT = unsafe { std::mem::zeroed() };
                if unsafe { GetWindowRect(h, &mut r) } != 0 && r.right - r.left > 64 && r.bottom - r.top > 64 {
                    f.found.push(h);
                }
            }
            1
        }
        let mut f = Find { pid, found: Vec::new() };
        unsafe { EnumWindows(Some(each), &mut f as *mut Find as LPARAM) };
        f.found
    }

    pub fn watch(vellum: isize, pid: u32) {
        let started = Instant::now();
        let mut first_seen: Option<Instant> = None;
        let mut moved = 0;
        // Windows moved as fullscreen, held to fill Vellum's monitor while the watch lasts.
        let mut held: Vec<isize> = Vec::new();
        loop {
            std::thread::sleep(POLL);
            let elapsed = first_seen.map_or(started.elapsed(), |t| t.elapsed());
            if (first_seen.is_none() && elapsed > FIRST_WINDOW) || (first_seen.is_some() && elapsed > SETTLE) {
                break;
            }
            let target = unsafe { MonitorFromWindow(vellum as HWND, MONITOR_DEFAULTTONEAREST) };
            let Some((to_full, to_work)) = monitor(target) else { break };
            for h in windows_of(pid) {
                first_seen.get_or_insert_with(Instant::now);
                let current = unsafe { MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST) };
                if current == target {
                    if held.contains(&(h as isize)) {
                        let mut r: RECT = unsafe { std::mem::zeroed() };
                        if unsafe { GetWindowRect(h, &mut r) } != 0 && rect(r) != to_full {
                            let (l, t, rr, b) = to_full;
                            unsafe { SetWindowPos(h, std::ptr::null_mut(), l, t, rr - l, b - t, SWP_NOZORDER | SWP_NOACTIVATE) };
                            tracing::info!(pid, was = ?rect(r), "held a launched program's fullscreen window to Vellum's monitor");
                        }
                    }
                    continue;
                }
                let Some((from_full, from_work)) = monitor(current) else { continue };
                let mut r: RECT = unsafe { std::mem::zeroed() };
                if unsafe { GetWindowRect(h, &mut r) } == 0 {
                    continue;
                }
                let framed = (unsafe { GetWindowLongW(h, GWL_STYLE) } as u32 & WS_CAPTION) == WS_CAPTION;
                let (l, t, rr, b) = plan::move_to(rect(r), framed, from_full, from_work, to_full, to_work);
                if (l, t, rr, b) == to_full && !held.contains(&(h as isize)) {
                    held.push(h as isize);
                }
                unsafe { SetWindowPos(h, std::ptr::null_mut(), l, t, rr - l, b - t, SWP_NOZORDER | SWP_NOACTIVATE) };
                moved += 1;
                tracing::info!(pid, from = ?rect(r), to = ?(l, t, rr, b), "moved a launched program's window to Vellum's monitor");
            }
        }
        if first_seen.is_none() {
            tracing::info!(pid, "no window appeared to place");
        } else if moved == 0 {
            tracing::info!(pid, "the launched program opened on Vellum's monitor");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::plan::move_to;

    const LEFT: (i32, i32, i32, i32) = (0, 0, 1920, 1200);
    const LEFT_WORK: (i32, i32, i32, i32) = (0, 0, 1920, 1152);
    const RIGHT: (i32, i32, i32, i32) = (1920, 0, 4480, 1440);
    const RIGHT_WORK: (i32, i32, i32, i32) = (1920, 0, 4480, 1392);

    #[test]
    fn fullscreen_fills_the_other_monitor() {
        assert_eq!(move_to(RIGHT, false, RIGHT, RIGHT_WORK, LEFT, LEFT_WORK), LEFT);
    }

    #[test]
    fn a_framed_window_as_big_as_its_monitor_is_a_window() {
        // PCSX2 restores a window nearly the size of the screen; with its frame it covers it all.
        let (l, t, r, b) = move_to(LEFT, true, LEFT, LEFT_WORK, RIGHT, RIGHT_WORK);
        assert_eq!((r - l, b - t), (1920, 1200), "it keeps its size, as it fits");
        assert_eq!((l, t), (2240, 96), "it had no room to be anywhere but the middle, so it's centred");
        assert!(b <= RIGHT_WORK.3);
    }

    #[test]
    fn a_window_keeps_its_size_and_place() {
        // Centred on the right monitor's work area: centred on the left one's.
        let w = (1920 + 640, 296, 1920 + 640 + 1280, 296 + 800);
        assert_eq!(move_to(w, true, RIGHT, RIGHT_WORK, LEFT, LEFT_WORK), (320, 176, 1600, 976));
        // In the top-left corner: top-left again.
        let corner = (1920, 0, 1920 + 800, 600);
        assert_eq!(move_to(corner, true, RIGHT, RIGHT_WORK, LEFT, LEFT_WORK), (0, 0, 800, 600));
    }

    #[test]
    fn a_window_too_big_for_the_other_monitor_shrinks_to_fit() {
        let big = (1920 + 10, 10, 1920 + 2500, 1380);
        let (l, t, r, b) = move_to(big, true, RIGHT, RIGHT_WORK, LEFT, LEFT_WORK);
        assert_eq!((r - l, b - t), (1920, 1152));
        assert_eq!((l, t), (0, 0));
    }
}
