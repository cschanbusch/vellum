//! Downloaded art originals: `cache/art/originals/<hash>.<ext>`, indexed by source URL in
//! `cache/art/remote.json`. A URL that answered "not found" (or with something that isn't an
//! image) is recorded as a miss and not asked for again until the retry period has passed.
//! Network failures are not misses: Vellum may simply be offline, so those are only held
//! back for the rest of the session's backoff, in memory.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::art::resolve::RemoteState;

pub const SCHEMA_VERSION: u32 = 1;
/// The most one original may weigh.
pub const MAX_BYTES: u64 = 30 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RemoteIndex {
    pub schema_version: u32,
    pub urls: BTreeMap<String, RemoteRecord>,
}

impl Default for RemoteIndex {
    fn default() -> Self {
        RemoteIndex { schema_version: SCHEMA_VERSION, urls: BTreeMap::new() }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RemoteRecord {
    /// File name in the originals folder, once downloaded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    /// Unix seconds of the download.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fetched_at: Option<u64>,
    /// Unix seconds of the last miss (404, or not an image).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub missed_at: Option<u64>,
}

/// The cache is disposable: anything unreadable starts empty.
pub fn load(_path: &Path, bytes: Option<Vec<u8>>) -> RemoteIndex {
    bytes
        .and_then(|b| serde_json::from_slice::<RemoteIndex>(&b).ok())
        .filter(|s| s.schema_version == SCHEMA_VERSION)
        .unwrap_or_default()
}

/// Whether a miss recorded at `missed_at` still holds. `retry_days` 0 means misses are kept
/// until the user asks to retry.
pub fn miss_holds(missed_at: u64, now: u64, retry_days: u32) -> bool {
    retry_days == 0 || now.saturating_sub(missed_at) < retry_days as u64 * 86_400
}

impl RemoteIndex {
    pub fn state(&self, url: &str, originals: &Path, now: u64, retry_days: u32) -> RemoteState {
        let Some(r) = self.urls.get(url) else { return RemoteState::Unknown };
        if let Some(name) = &r.file {
            let p = originals.join(name);
            if let Ok(m) = std::fs::metadata(&p) {
                return RemoteState::Ready { mtime: crate::art::mtime_ms(&m), size: m.len(), file: p };
            }
            // The file was deleted (cache cleared by hand): fetch it again.
            return RemoteState::Unknown;
        }
        match r.missed_at {
            Some(t) if miss_holds(t, now, retry_days) => RemoteState::Missing,
            _ => RemoteState::Unknown,
        }
    }

    /// Forgets every miss, so everything is tried again. Returns how many were cleared.
    pub fn clear_misses(&mut self) -> usize {
        let before = self.urls.len();
        self.urls.retain(|_, r| r.file.is_some());
        before - self.urls.len()
    }

    pub fn counts(&self) -> (usize, usize, u64) {
        let ok = self.urls.values().filter(|r| r.file.is_some()).count();
        let bytes = self.urls.values().filter_map(|r| r.size).sum();
        (ok, self.urls.len() - ok, bytes)
    }
}

/// Folder for downloaded originals.
pub fn originals_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("cache").join("art").join("originals")
}

pub fn hash_hex(bytes: &[u8], len: usize) -> String {
    let d = Sha256::digest(bytes);
    d.iter().map(|b| format!("{b:02x}")).collect::<String>()[..len].to_string()
}

/// How one download ended.
#[derive(Debug)]
pub enum Outcome {
    Saved(RemoteRecord),
    /// The server says there is no such image, or sent something that isn't one.
    Miss(String),
    /// Couldn't reach the server, a timeout or a server error: try again later.
    Failed(String),
}

/// Checks that `bytes` are an image Vellum can show and returns its format and size.
pub fn sniff(bytes: &[u8]) -> Option<(image::ImageFormat, u32, u32)> {
    let fmt = image::guess_format(bytes).ok()?;
    if !matches!(fmt, image::ImageFormat::Png | image::ImageFormat::Jpeg | image::ImageFormat::WebP | image::ImageFormat::Gif) {
        return None;
    }
    let (w, h) = image::ImageReader::with_format(std::io::Cursor::new(bytes), fmt).into_dimensions().ok()?;
    (w > 0 && h > 0).then_some((fmt, w, h))
}

pub fn extension(fmt: image::ImageFormat) -> &'static str {
    match fmt {
        image::ImageFormat::Png => "png",
        image::ImageFormat::WebP => "webp",
        image::ImageFormat::Gif => "gif",
        _ => "jpg",
    }
}

/// Downloads `url` into `originals`. The file is named by a hash of the URL, so the same
/// source always lands in the same place and a re-download replaces it.
pub fn download(agent: &ureq::Agent, url: &str, originals: &Path, now: u64) -> Outcome {
    let mut resp = match agent.get(url).header("User-Agent", super::USER_AGENT).header("Accept", "image/*").call() {
        Ok(r) => r,
        Err(e) => return Outcome::Failed(e.to_string()),
    };
    let status = resp.status().as_u16();
    if matches!(status, 404 | 410 | 403 | 400) {
        return Outcome::Miss(format!("HTTP {status}"));
    }
    if status != 200 {
        return Outcome::Failed(format!("HTTP {status}"));
    }
    let bytes = match resp.body_mut().with_config().limit(MAX_BYTES).read_to_vec() {
        Ok(b) => b,
        Err(e) => return Outcome::Failed(e.to_string()),
    };
    let Some((fmt, w, h)) = sniff(&bytes) else {
        return Outcome::Miss("not an image".into());
    };
    let name = format!("{}.{}", hash_hex(url.as_bytes(), 32), extension(fmt));
    if let Err(e) = crate::userdata::atomic::write(&originals.join(&name), &bytes) {
        return Outcome::Failed(e.to_string());
    }
    Outcome::Saved(RemoteRecord {
        file: Some(name),
        size: Some(bytes.len() as u64),
        width: Some(w),
        height: Some(h),
        fetched_at: Some(now),
        missed_at: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::testserver::{png_bytes, serve};

    #[test]
    fn misses_expire_after_the_retry_period() {
        let day = 86_400;
        assert!(miss_holds(0, 6 * day, 7));
        assert!(!miss_holds(0, 7 * day, 7));
        assert!(miss_holds(0, 1000 * day, 0), "0 = never retry automatically");
        assert!(!miss_holds(0, day, 1));
    }

    #[test]
    fn states_follow_the_index_and_the_disk() {
        let t = tempfile::tempdir().unwrap();
        let mut idx = RemoteIndex::default();
        assert_eq!(idx.state("u", t.path(), 0, 7), RemoteState::Unknown);
        idx.urls.insert("m".into(), RemoteRecord { missed_at: Some(100), ..Default::default() });
        assert_eq!(idx.state("m", t.path(), 200, 7), RemoteState::Missing);
        assert_eq!(idx.state("m", t.path(), 100 + 8 * 86_400, 7), RemoteState::Unknown);
        idx.urls.insert("f".into(), RemoteRecord { file: Some("f.png".into()), ..Default::default() });
        assert_eq!(idx.state("f", t.path(), 0, 7), RemoteState::Unknown, "file deleted by hand");
        std::fs::write(t.path().join("f.png"), b"x").unwrap();
        assert!(matches!(idx.state("f", t.path(), 0, 7), RemoteState::Ready { size: 1, .. }));
        assert_eq!(idx.clear_misses(), 1);
        assert_eq!(idx.counts().0, 1);
    }

    #[test]
    fn downloads_save_images_and_classify_failures() {
        let png = png_bytes(4, 6);
        let base = serve(vec![
            ("/ok.png", 200, png.clone()),
            ("/gone.png", 404, b"nope".to_vec()),
            ("/html", 200, b"<html>".to_vec()),
            ("/boom", 503, Vec::new()),
        ]);
        let t = tempfile::tempdir().unwrap();
        let agent = crate::net::agent();
        match download(&agent, &format!("{base}/ok.png"), t.path(), 5) {
            Outcome::Saved(r) => {
                assert_eq!((r.width, r.height, r.size), (Some(4), Some(6), Some(png.len() as u64)));
                assert!(t.path().join(r.file.unwrap()).exists());
            }
            o => panic!("{o:?}"),
        }
        assert!(matches!(download(&agent, &format!("{base}/gone.png"), t.path(), 5), Outcome::Miss(_)));
        assert!(matches!(download(&agent, &format!("{base}/html"), t.path(), 5), Outcome::Miss(_)));
        assert!(matches!(download(&agent, &format!("{base}/boom"), t.path(), 5), Outcome::Failed(_)));
        assert!(matches!(download(&agent, "http://127.0.0.1:9/x.png", t.path(), 5), Outcome::Failed(_)));
    }
}
