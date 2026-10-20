use super::{Hive, PlatformError};

pub fn registry_get(_hive: Hive, _key: &str, _value: &str) -> Option<String> {
    None
}

pub fn registry_subkeys(_hive: Hive, _key: &str) -> Vec<String> {
    Vec::new()
}

pub fn shell_open(_target: &str) -> Result<(), PlatformError> {
    Err(PlatformError::Unsupported)
}
