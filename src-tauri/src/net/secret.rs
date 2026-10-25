//! The SteamGridDB key lives in Windows Credential Manager (a generic credential named
//! `Vellum/SteamGridDB`), never in settings.json, so copying the data folder never copies it.
//! `VELLUM_SGDB_KEY` overrides it, for tests and development.

pub const TARGET: &str = "Vellum/SteamGridDB";

pub fn get() -> Option<String> {
    if let Ok(k) = std::env::var("VELLUM_SGDB_KEY") {
        return Some(k).filter(|k| !k.trim().is_empty());
    }
    imp::read(TARGET).filter(|k| !k.trim().is_empty())
}

pub fn set(key: Option<&str>) -> Result<(), String> {
    match key.map(str::trim).filter(|k| !k.is_empty()) {
        Some(k) => imp::write(TARGET, k),
        None => imp::delete(TARGET),
    }
}

#[cfg(windows)]
mod imp {
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_NOT_FOUND};
    use windows_sys::Win32::Security::Credentials::{
        CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    pub fn read(target: &str) -> Option<String> {
        let name = wide(target);
        let mut cred: *mut CREDENTIALW = std::ptr::null_mut();
        // SAFETY: `name` is NUL-terminated; on success `cred` points at a block freed below.
        unsafe {
            if CredReadW(name.as_ptr(), CRED_TYPE_GENERIC, 0, &mut cred) == 0 || cred.is_null() {
                return None;
            }
            let c = &*cred;
            let bytes = std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize).to_vec();
            CredFree(cred as *const _);
            String::from_utf8(bytes).ok()
        }
    }

    pub fn write(target: &str, secret: &str) -> Result<(), String> {
        let mut name = wide(target);
        let mut user = wide("SteamGridDB API key");
        let mut blob = secret.as_bytes().to_vec();
        // SAFETY: every pointer refers to a live local buffer for the duration of the call.
        unsafe {
            let mut c: CREDENTIALW = std::mem::zeroed();
            c.Type = CRED_TYPE_GENERIC;
            c.TargetName = name.as_mut_ptr();
            c.UserName = user.as_mut_ptr();
            c.CredentialBlobSize = blob.len() as u32;
            c.CredentialBlob = blob.as_mut_ptr();
            c.Persist = CRED_PERSIST_LOCAL_MACHINE;
            if CredWriteW(&c, 0) == 0 {
                return Err(format!("Windows couldn't save the key (error {}).", GetLastError()));
            }
        }
        Ok(())
    }

    pub fn delete(target: &str) -> Result<(), String> {
        let name = wide(target);
        // SAFETY: `name` is NUL-terminated.
        unsafe {
            if CredDeleteW(name.as_ptr(), CRED_TYPE_GENERIC, 0) == 0 && GetLastError() != ERROR_NOT_FOUND {
                return Err(format!("Windows couldn't remove the key (error {}).", GetLastError()));
            }
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn read(_target: &str) -> Option<String> {
        None
    }
    pub fn write(_target: &str, _secret: &str) -> Result<(), String> {
        Err("Saving keys is only supported on Windows.".into())
    }
    pub fn delete(_target: &str) -> Result<(), String> {
        Ok(())
    }
}
