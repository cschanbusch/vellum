use std::os::windows::ffi::OsStrExt;

use windows_sys::Win32::UI::Shell::ShellExecuteW;
use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};
use winreg::RegKey;

use super::{Hive, PlatformError};

fn open_key(hive: Hive, key: &str) -> Option<RegKey> {
    let root = RegKey::predef(match hive {
        Hive::CurrentUser => HKEY_CURRENT_USER,
        Hive::LocalMachine => HKEY_LOCAL_MACHINE,
    });
    root.open_subkey_with_flags(key, KEY_READ).ok()
}

pub fn registry_get(hive: Hive, key: &str, value: &str) -> Option<String> {
    let k = open_key(hive, key)?;
    k.get_value::<String, _>(value)
        .ok()
        .or_else(|| k.get_value::<u32, _>(value).ok().map(|n| n.to_string()))
        .or_else(|| k.get_value::<u64, _>(value).ok().map(|n| n.to_string()))
}

pub fn registry_subkeys(hive: Hive, key: &str) -> Vec<String> {
    open_key(hive, key)
        .map(|k| k.enum_keys().filter_map(Result::ok).collect())
        .unwrap_or_default()
}

/// Release builds have no console; attach to the terminal that started us so CLI flags
/// such as `--diagnose` can print.
pub fn attach_parent_console() {
    use windows_sys::Win32::System::Console::{AttachConsole, ATTACH_PARENT_PROCESS};
    // SAFETY: plain Win32 call; failure (no parent console) is harmless.
    unsafe {
        AttachConsole(ATTACH_PARENT_PROCESS);
    }
}

fn wide(s: &str) -> Vec<u16> {
    std::ffi::OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

pub fn shell_open(target: &str) -> Result<(), PlatformError> {
    let verb = wide("open");
    let file = wide(target);
    // SAFETY: all pointers are valid NUL-terminated UTF-16 buffers that outlive the call.
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    // ShellExecuteW returns a value greater than 32 on success.
    if result as isize > 32 {
        Ok(())
    } else {
        Err(PlatformError::Open { target: target.to_string(), reason: format!("ShellExecute error {}", result as isize) })
    }
}
