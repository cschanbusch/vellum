//! Every Windows-only call lives behind this module. Other platforms get stubs that return
//! empty results, so everything else can be developed and tested anywhere.

use std::path::Path;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
use self::windows as imp;

#[cfg(not(windows))]
mod stub;
#[cfg(not(windows))]
use self::stub as imp;

#[derive(Debug, thiserror::Error)]
pub enum PlatformError {
    #[error("not supported on this platform")]
    Unsupported,
    #[error("could not open {target}: {reason}")]
    Open { target: String, reason: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Hive {
    #[serde(rename = "HKCU")]
    CurrentUser,
    #[serde(rename = "HKLM")]
    LocalMachine,
}

impl std::str::FromStr for Hive {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, String> {
        match s {
            "HKCU" | "HKEY_CURRENT_USER" => Ok(Hive::CurrentUser),
            "HKLM" | "HKEY_LOCAL_MACHINE" => Ok(Hive::LocalMachine),
            _ => Err(format!("unknown registry hive: {s}")),
        }
    }
}

/// Reads a string (REG_SZ / REG_EXPAND_SZ) or number value; `None` if absent.
pub fn registry_get(hive: Hive, key: &str, value: &str) -> Option<String> {
    imp::registry_get(hive, key, value)
}

/// Names of the direct subkeys of `key`; empty if absent.
pub fn registry_subkeys(hive: Hive, key: &str) -> Vec<String> {
    imp::registry_subkeys(hive, key)
}

/// Opens a URI with its registered handler (store client URIs such as `steam://`).
pub fn open_uri(uri: &str) -> Result<(), PlatformError> {
    imp::shell_open(uri)
}

/// Opens a folder in the system file manager.
pub fn open_folder(path: &Path) -> Result<(), PlatformError> {
    imp::shell_open(&path.to_string_lossy())
}

/// Expands `%NAME%` environment variables, as Windows does. Unknown names are left as-is,
/// so an unexpanded default path simply fails validation rather than becoming garbage.
pub fn expand_env(s: &str) -> String {
    expand_with(s, |name| std::env::var(name).ok())
}

fn expand_with(s: &str, lookup: impl Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) if end > 0 => {
                let name = &after[..end];
                match lookup(name) {
                    Some(v) => out.push_str(&v),
                    None => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            _ => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake(name: &str) -> Option<String> {
        match name {
            "ProgramFiles(x86)" => Some("C:\\Program Files (x86)".into()),
            "ProgramData" => Some("C:\\ProgramData".into()),
            _ => None,
        }
    }

    #[test]
    fn expands_known_variables() {
        assert_eq!(expand_with("%ProgramFiles(x86)%\\Steam", fake), "C:\\Program Files (x86)\\Steam");
        assert_eq!(
            expand_with("%ProgramData%\\Epic\\%ProgramData%", fake),
            "C:\\ProgramData\\Epic\\C:\\ProgramData"
        );
    }

    #[test]
    fn leaves_unknown_and_stray_percents() {
        assert_eq!(expand_with("%NOPE%\\x", fake), "%NOPE%\\x");
        assert_eq!(expand_with("100% sure", fake), "100% sure");
        assert_eq!(expand_with("a%%b", fake), "a%%b");
    }

    #[test]
    fn hive_names() {
        assert_eq!("HKCU".parse::<Hive>().unwrap(), Hive::CurrentUser);
        assert_eq!("HKEY_LOCAL_MACHINE".parse::<Hive>().unwrap(), Hive::LocalMachine);
        assert!("HKCR".parse::<Hive>().is_err());
    }
}
