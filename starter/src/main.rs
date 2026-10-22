//! The starter: the small `Vellum Game Launcher.exe` at the root of a managed install. It reads
//! `active.json` and launches `versions/<active>/Vellum Game Launcher.exe` with the same
//! arguments, then exits. It never changes, so shortcuts keep working across versions.
//!
//! A newly activated version is on trial (`trial: true`): each start counts as failed until the
//! version confirms itself on reaching its window (src-tauri/src/versions.rs). After two failed
//! starts the starter goes back to the previous version and records `rolledBackFrom`.
//!
//! Vellum draws its interface with Microsoft's WebView2 runtime. Windows 11 includes it and
//! nearly every Windows 10 PC has it through Edge; where it is missing, the starter says so and
//! offers Microsoft's download page instead of letting the app fail with an obscure error.
#![cfg_attr(windows, windows_subsystem = "windows")]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

const ACTIVE_FILE: &str = "active.json";
const EXE_NAME: &str = "Vellum Game Launcher.exe";
const MAX_FAILED_STARTS: u32 = 2;
const WEBVIEW2_DOWNLOAD: &str = "https://developer.microsoft.com/microsoft-edge/webview2/";

#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
struct Active {
    active: String,
    previous: Option<String>,
    trial: bool,
    failed_starts: u32,
    rolled_back_from: Option<String>,
}

fn exe_of(root: &Path, version: &str) -> PathBuf {
    root.join("versions").join(version).join(EXE_NAME)
}

/// Installed versions, newest first.
fn installed(root: &Path) -> Vec<String> {
    let key = |s: &str| -> Vec<u64> { s.split(['.', '-']).map(|p| p.parse().unwrap_or(0)).collect() };
    let mut v: Vec<String> = fs::read_dir(root.join("versions"))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .filter(|name| !name.starts_with('.') && exe_of(root, name).is_file())
        .collect();
    v.sort_by(|a, b| key(b).cmp(&key(a)));
    v
}

/// Which version to start, updating `a` (trial counting, fallback). Pure, for tests.
fn choose(root: &Path, a: &mut Active) -> Option<String> {
    if a.trial {
        let fallback = a.previous.clone().filter(|p| exe_of(root, p).is_file());
        if a.failed_starts >= MAX_FAILED_STARTS && fallback.is_some() {
            a.rolled_back_from = Some(std::mem::take(&mut a.active));
            a.active = fallback.unwrap();
            a.previous = None;
            a.trial = false;
            a.failed_starts = 0;
        } else {
            a.failed_starts += 1;
        }
    }
    if exe_of(root, &a.active).is_file() {
        return Some(a.active.clone());
    }
    // The active version is gone: the newest installed one instead.
    let newest = installed(root).into_iter().next()?;
    a.active = newest.clone();
    a.trial = false;
    a.failed_starts = 0;
    Some(newest)
}

/// A WebView2 runtime version as the registry records it: missing, empty or 0.0.0.0 means
/// not installed (the updater leaves 0.0.0.0 behind after an uninstall).
fn is_installed_version(pv: Option<&str>) -> bool {
    pv.map(str::trim).is_some_and(|v| !v.is_empty() && v != "0.0.0.0")
}

/// Whether a WebView2 runtime is installed, per Microsoft's documented registry check (per-machine
/// on 64- and 32-bit views, then per-user). A fixed-version runtime chosen through
/// WEBVIEW2_BROWSER_EXECUTABLE_FOLDER counts too.
#[cfg(windows)]
fn webview2_installed() -> bool {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
    if std::env::var_os("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER").is_some() {
        return true;
    }
    const CLIENT: &str = r"Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let read = |hive: HKEY, key: &str| -> Option<String> {
        let (key, name) = (wide(key), wide("pv"));
        let mut buf = [0u16; 64];
        let mut len = (buf.len() * 2) as u32;
        let ok = unsafe { RegGetValueW(hive, key.as_ptr(), name.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), buf.as_mut_ptr().cast(), &mut len) } == 0;
        ok.then(|| String::from_utf16_lossy(&buf[..(len as usize / 2).saturating_sub(1)]))
    };
    [
        (HKEY_LOCAL_MACHINE, format!(r"SOFTWARE\WOW6432Node\{CLIENT}")),
        (HKEY_LOCAL_MACHINE, format!(r"SOFTWARE\{CLIENT}")),
        (HKEY_CURRENT_USER, format!(r"Software\{CLIENT}")),
    ]
    .iter()
    .any(|(hive, key)| is_installed_version(read(*hive, key).as_deref()))
}

#[cfg(not(windows))]
fn webview2_installed() -> bool {
    true
}

/// No WebView2: explain, and offer Microsoft's download page.
fn missing_webview2() -> ! {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, IDYES, MB_ICONWARNING, MB_YESNO, SW_SHOWNORMAL};
        let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
        let text = wide(
            "Vellum needs the Microsoft Edge WebView2 Runtime, which isn't installed on this PC.\n\n\
             It's a free component from Microsoft (Windows 11 already includes it). Open the download page now?\n\n\
             On that page, choose \"Evergreen Bootstrapper\", run it, then start Vellum again.",
        );
        let title = wide("Vellum Game Launcher");
        let answer = unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), MB_YESNO | MB_ICONWARNING) };
        if answer == IDYES {
            let (verb, url) = (wide("open"), wide(WEBVIEW2_DOWNLOAD));
            unsafe { ShellExecuteW(std::ptr::null_mut(), verb.as_ptr(), url.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL) };
        }
    }
    #[cfg(not(windows))]
    eprintln!("Vellum needs the Microsoft Edge WebView2 Runtime: {WEBVIEW2_DOWNLOAD}");
    std::process::exit(1);
}

fn fail(msg: &str) -> ! {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
        let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
        let (text, title) = (wide(msg), wide("Vellum Game Launcher"));
        unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), MB_OK | MB_ICONERROR) };
    }
    #[cfg(not(windows))]
    eprintln!("{msg}");
    std::process::exit(1);
}

fn main() {
    if !webview2_installed() {
        missing_webview2();
    }
    let exe = std::env::current_exe().unwrap_or_else(|e| fail(&format!("Can't locate the starter: {e}")));
    let root = exe.parent().unwrap_or(Path::new(".")).to_path_buf();
    let path = root.join(ACTIVE_FILE);
    let mut active: Active = fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str(t.trim_start_matches('\u{feff}')).ok())
        .unwrap_or_default();
    let before = active.clone();
    let Some(version) = choose(&root, &mut active) else {
        fail("No installed version of Vellum was found in the versions folder.\n\nDownload Vellum again from its GitHub releases page.");
    };
    if active != before {
        let _ = fs::write(&path, serde_json::to_vec_pretty(&active).unwrap());
    }
    let dir = root.join("versions").join(&version);
    if let Err(e) = Command::new(dir.join(EXE_NAME)).args(std::env::args_os().skip(1)).current_dir(&dir).spawn() {
        fail(&format!("Vellum {version} couldn't be started: {e}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn install(root: &Path, v: &str) {
        fs::create_dir_all(root.join("versions").join(v)).unwrap();
        fs::write(exe_of(root, v), "").unwrap();
    }

    #[test]
    fn webview2_versions() {
        assert!(is_installed_version(Some("130.0.2849.80")));
        assert!(!is_installed_version(Some("0.0.0.0")));
        assert!(!is_installed_version(Some("")));
        assert!(!is_installed_version(None));
    }

    #[test]
    fn webview2_is_found_on_this_pc() {
        assert!(webview2_installed());
    }

    #[test]
    fn a_trial_version_that_keeps_failing_falls_back() {
        let tmp = std::env::temp_dir().join(format!("vellum-starter-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        install(&tmp, "0.2.0");
        install(&tmp, "0.3.0");
        let mut a = Active { active: "0.3.0".into(), previous: Some("0.2.0".into()), trial: true, ..Default::default() };
        assert_eq!(choose(&tmp, &mut a).as_deref(), Some("0.3.0"));
        assert_eq!(choose(&tmp, &mut a).as_deref(), Some("0.3.0"));
        assert_eq!(a.failed_starts, 2);
        assert_eq!(choose(&tmp, &mut a).as_deref(), Some("0.2.0"), "two failed starts: back to the previous version");
        assert_eq!(a.rolled_back_from.as_deref(), Some("0.3.0"));
        assert!(!a.trial);
        // A missing active version falls to the newest installed one.
        let mut b = Active { active: "0.9.0".into(), ..Default::default() };
        assert_eq!(choose(&tmp, &mut b).as_deref(), Some("0.3.0"));
        let _ = fs::remove_dir_all(&tmp);
    }
}
