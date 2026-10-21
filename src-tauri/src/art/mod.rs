//! Art v0: provider file candidates, generated placeholders, and resized variants.
//!
//! Skins request `/__vellum/art/<entryId>/<kind>?v=<version>&w=<width>` on their own origin.
//! For each entry and kind the first usable local candidate wins; otherwise a placeholder SVG
//! is served. Widths snap up to 160/320/640/1280/1920; `full` (or anything wider) returns the
//! original bytes. Resized variants are cached in `cache/art/variants/`, keyed by the source
//! file's path, size and modification time, so replacing a file invalidates its variants.
//! Remote candidates (Steam CDN, SteamGridDB) arrive in Phase 4.

pub mod placeholder;
mod resize;
pub mod style;

use std::borrow::Cow;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::library::entry::ART_KINDS;
use crate::providers::scope::{simplify, Scope};

pub use resize::{snap_width, Variant};
pub use style::ArtStyle;

/// One art candidate as a provider's `art()` returns it, validated by the host.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtCandidate {
    pub kind: String,
    /// Canonical path of a local file inside the provider's scope.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    /// A remote URL on one of the provider's `artHosts` (downloaded from Phase 4 on).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mtime: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif"];
const MAX_CANDIDATES: usize = 24;

fn mtime_ms(m: &std::fs::Metadata) -> u64 {
    m.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64)
}

/// Keeps the candidates that are safe to serve: a known kind, and either an existing image
/// file inside `scope` or an https URL on one of `art_hosts`. Returns them with problems.
pub fn validate_candidates(value: &Value, scope: &Scope, art_hosts: &[String]) -> (Vec<ArtCandidate>, Vec<String>) {
    let mut out = Vec::new();
    let mut problems = Vec::new();
    let Some(items) = value.as_array() else {
        if !value.is_null() {
            problems.push("art() must return an array".to_string());
        }
        return (out, problems);
    };
    for item in items.iter().take(MAX_CANDIDATES) {
        let kind = item.get("kind").and_then(Value::as_str).unwrap_or("");
        if !ART_KINDS.contains(&kind) {
            problems.push(format!("unknown art kind {kind:?}"));
            continue;
        }
        if let Some(file) = item.get("file").and_then(Value::as_str) {
            let ext_ok = Path::new(file)
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| IMAGE_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()));
            if !ext_ok {
                problems.push(format!("not an image file: {file}"));
                continue;
            }
            match scope.check(file) {
                Ok(c) => {
                    let Ok(meta) = std::fs::metadata(&c) else { continue };
                    if !meta.is_file() {
                        continue;
                    }
                    out.push(ArtCandidate {
                        kind: kind.to_string(),
                        file: Some(simplify(&c).to_string_lossy().into_owned()),
                        url: None,
                        mtime: Some(mtime_ms(&meta)),
                        size: Some(meta.len()),
                    });
                }
                Err(e) => problems.push(e.to_string()),
            }
        } else if let Some(url) = item.get("url").and_then(Value::as_str) {
            let host = url.strip_prefix("https://").and_then(|r| r.split(['/', '?', '#']).next()).unwrap_or("");
            if host.is_empty() || !art_hosts.iter().any(|h| h.eq_ignore_ascii_case(host)) {
                problems.push(format!("art URL host not in artHosts: {url}"));
                continue;
            }
            out.push(ArtCandidate { kind: kind.to_string(), file: None, url: Some(url.to_string()), mtime: None, size: None });
        } else {
            problems.push("art candidate needs a file or a url".to_string());
        }
    }
    (out, problems)
}

/// The candidate that will be served for `kind`, if any (local files only in v0).
pub fn pick<'a>(candidates: &'a [ArtCandidate], kind: &str) -> Option<&'a ArtCandidate> {
    candidates.iter().find(|c| c.kind == kind && c.file.is_some())
}

fn short_hash(h: impl Hash) -> String {
    let mut s = DefaultHasher::new();
    h.hash(&mut s);
    format!("{:012x}", s.finish() & 0xffff_ffff_ffff)
}

/// A token that changes whenever the served image would change, so art URLs can be cached
/// as immutable.
pub fn version(candidate: Option<&ArtCandidate>, title: &str) -> String {
    match candidate {
        Some(c) => short_hash((&c.file, c.mtime, c.size)),
        None => format!("p{:08x}", placeholder::hash_title(title)),
    }
}

/// `/__vellum/art/<id>/<kind>?v=<version>`, with the id percent-encoded.
pub fn url(entry_id: &str, kind: &str, version: &str) -> String {
    format!("/__vellum/art/{}/{kind}?v={version}", encode_segment(entry_id))
}

pub fn encode_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~:".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// What the art route needs to answer one request.
pub struct ArtRequest {
    pub kind: String,
    pub width: Variant,
    /// Redraw the art as a sketch or watercolor (placeholders are left as they are).
    pub style: Option<ArtStyle>,
    pub title: String,
    pub candidate: Option<ArtCandidate>,
}

/// A served image: bytes plus content type.
pub struct ArtResponse {
    pub content_type: &'static str,
    pub body: Cow<'static, [u8]>,
}

/// The `fx` query parameter: an art style.
pub fn parse_style(query: Option<&str>) -> Option<ArtStyle> {
    query.into_iter().flat_map(|q| q.split('&')).find_map(|p| p.strip_prefix("fx=")).and_then(ArtStyle::parse)
}

/// Parses `<id>/<kind>` and the `w` query parameter.
pub fn parse_route(rest: &str, query: Option<&str>) -> Option<(String, String, Variant)> {
    let (id, kind) = rest.rsplit_once('/')?;
    let id = crate::protocols::percent_decode(id)?;
    if id.is_empty() || !ART_KINDS.contains(&kind) {
        return None;
    }
    let w = query
        .into_iter()
        .flat_map(|q| q.split('&'))
        .find_map(|p| p.strip_prefix("w="))
        .map(snap_width)
        .unwrap_or(Variant::Full);
    Some((id, kind.to_string(), w))
}

/// Produces the image for a request, using and filling the variant cache under `cache_dir`.
pub fn serve(req: &ArtRequest, cache_dir: &Path) -> ArtResponse {
    if let Some(file) = req.candidate.as_ref().and_then(|c| c.file.as_deref()) {
        match resize::variant(Path::new(file), req.candidate.as_ref().unwrap(), req.width, req.style, cache_dir) {
            Ok(r) => return r,
            Err(e) => tracing::warn!(file, error = %e, "art file unusable; serving a placeholder"),
        }
    }
    ArtResponse { content_type: "image/svg+xml", body: Cow::Owned(placeholder::svg(&req.title, &req.kind).into_bytes()) }
}

/// A small fixed pool for decoding and resizing, so a screen of covers doesn't spawn a thread
/// (and a decoded 1200×1800 image) per request.
pub fn spawn(job: impl FnOnce() + Send + 'static) {
    static POOL: OnceLock<Mutex<Sender<Box<dyn FnOnce() + Send>>>> = OnceLock::new();
    let tx = POOL.get_or_init(|| {
        let (tx, rx) = channel::<Box<dyn FnOnce() + Send>>();
        let rx = std::sync::Arc::new(Mutex::new(rx));
        let n = std::thread::available_parallelism().map_or(4, |n| n.get()).clamp(2, 6);
        for i in 0..n {
            let rx = rx.clone();
            let _ = std::thread::Builder::new().name(format!("art-{i}")).spawn(move || loop {
                let job = match rx.lock().unwrap().recv() {
                    Ok(j) => j,
                    Err(_) => return,
                };
                // A panic in one job must not take the worker down with it.
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(job));
            });
        }
        Mutex::new(tx)
    });
    let _ = tx.lock().unwrap().send(Box::new(job));
}

/// Folder for resized variants.
pub fn variants_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("cache").join("art").join("variants")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn candidates_are_checked_against_scope_kind_and_hosts() {
        let t = tempfile::tempdir().unwrap();
        let inside = t.path().join("lib");
        std::fs::create_dir_all(&inside).unwrap();
        std::fs::write(inside.join("620p.png"), b"x").unwrap();
        std::fs::write(inside.join("notes.txt"), b"x").unwrap();
        std::fs::write(t.path().join("outside.png"), b"x").unwrap();
        let scope = Scope::new([inside.clone()], &[]);
        let p = |n: &str| inside.join(n).to_string_lossy().into_owned();
        let v = json!([
            { "kind": "cover", "file": p("620p.png") },
            { "kind": "cover", "file": p("notes.txt") },
            { "kind": "hero", "file": t.path().join("outside.png").to_string_lossy() },
            { "kind": "hero", "file": p("missing.png") },
            { "kind": "banner", "file": p("620p.png") },
            { "kind": "logo", "url": "https://cdn.example.com/a.png" },
            { "kind": "logo", "url": "https://evil.example.org/a.png" },
            { "kind": "logo", "url": "http://cdn.example.com/a.png" },
            { "kind": "icon" }
        ]);
        let (ok, problems) = validate_candidates(&v, &scope, &["cdn.example.com".to_string()]);
        assert_eq!(ok.len(), 2, "{ok:?}");
        assert_eq!(ok[0].kind, "cover");
        assert!(ok[0].mtime.is_some() && ok[0].size == Some(1));
        assert_eq!(ok[1].url.as_deref(), Some("https://cdn.example.com/a.png"));
        assert_eq!(problems.len(), 7, "{problems:?}");
        assert_eq!(pick(&ok, "cover").unwrap().kind, "cover");
        assert!(pick(&ok, "logo").is_none(), "remote candidates aren't served in v0");
    }

    #[test]
    fn routes_parse_and_ids_round_trip() {
        let u = url("mock:mock 1/é", "cover", "abc");
        assert_eq!(u, "/__vellum/art/mock:mock%201%2F%C3%A9/cover?v=abc");
        let rest = u.strip_prefix("/__vellum/art/").unwrap().split('?').next().unwrap();
        let (id, kind, w) = parse_route(rest, Some("v=abc&w=300")).unwrap();
        assert_eq!((id.as_str(), kind.as_str(), w), ("mock:mock 1/é", "cover", Variant::Px(320)));
        assert_eq!(parse_route("steam:620/hero", None).unwrap().2, Variant::Full);
        assert!(parse_route("steam:620/poster", None).is_none());
        assert!(parse_route("/cover", None).is_none());
        assert_eq!(parse_style(Some("v=1&w=320&fx=sketch")), Some(ArtStyle::Sketch));
        assert_eq!(parse_style(Some("fx=watercolor")), Some(ArtStyle::Watercolor));
        assert_eq!(parse_style(Some("fx=oil")), None);
        assert_eq!(parse_style(None), None);
    }

    #[test]
    fn versions_follow_the_file() {
        let c = ArtCandidate { kind: "cover".into(), file: Some("C:\\a.png".into()), url: None, mtime: Some(1), size: Some(2) };
        let mut d = c.clone();
        d.mtime = Some(5);
        assert_ne!(version(Some(&c), "X"), version(Some(&d), "X"));
        assert_eq!(version(None, "X"), version(None, "X"));
        assert!(version(None, "X").starts_with('p'));
    }
}
