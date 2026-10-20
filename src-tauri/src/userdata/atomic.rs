use std::io::Write;
use std::path::{Path, PathBuf};

/// Writes `bytes` to `path` so readers only ever see the old or the new file, never a
/// partial one: write a sibling temp file, flush it to disk, then rename over the target.
pub fn write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = sibling(path, "tmp");
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    // std::fs::rename replaces an existing target on Windows (MoveFileEx with REPLACE_EXISTING).
    std::fs::rename(&tmp, path)
}

/// Drops a UTF-8 byte-order mark, which Windows editors add when users hand-edit files.
pub fn strip_bom(bytes: &[u8]) -> &[u8] {
    bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes)
}

/// `settings.json` + `bak` -> `settings.json.bak`.
pub fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".");
    name.push(suffix);
    path.with_file_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_existing_file_and_leaves_no_temp() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("nested").join("a.json");
        write(&p, b"one").unwrap();
        write(&p, b"two").unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"two");
        assert!(!sibling(&p, "tmp").exists());
    }
}
