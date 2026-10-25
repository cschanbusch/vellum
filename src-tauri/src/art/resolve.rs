//! The art resolution chain (spec: "Resolution order"). For each entry and kind the first hit
//! wins:
//!
//! 1. the user's override (a file they chose, or a remote image they picked);
//! 2. the provider's candidates, in the provider's order (local files and store URLs);
//! 3. SteamGridDB, when the user has entered a key;
//! 4. a generated placeholder.
//!
//! Remote images count only once they are downloaded. Anything the chain passed over because
//! it isn't downloaded or looked up yet is returned as a `Want`, so the caller can fetch it
//! and the entry upgrades when it arrives.

use std::path::PathBuf;

use serde_json::{Map, Value};

use super::ArtCandidate;
use crate::providers::model::Metadata;

/// What the network side knows about one remote image.
#[derive(Debug, Clone, PartialEq)]
pub enum RemoteState {
    /// Downloaded: the cached original.
    Ready { file: PathBuf, mtime: u64, size: u64 },
    /// Known to be missing (or failing) for now.
    Missing,
    /// Not tried yet, or the last miss is older than the retry period.
    Unknown,
}

/// SteamGridDB results for one entry and kind.
#[derive(Debug, Clone, PartialEq)]
pub enum LookupState {
    /// No key entered: SteamGridDB isn't used.
    Off,
    /// Not looked up yet, or the lookup has expired.
    Unknown,
    /// Image URLs, best first (possibly none).
    Found(Vec<String>),
}

/// The backend's view of downloads and lookups; `NoNetwork` for plain local resolution.
pub trait ArtSources {
    fn remote(&self, url: &str) -> RemoteState;
    fn lookup(&self, entry_id: &str, kind: &str) -> LookupState;
    /// Whether provider URLs (store CDNs) may be downloaded.
    fn store_downloads(&self) -> bool;
    /// Folder holding images the user chose from disk (`{ "custom": "<name>" }` overrides).
    fn custom_dir(&self) -> Option<PathBuf>;
    /// Fetched store details for a game record, if any.
    fn details(&self, _record_id: &str) -> Option<Metadata> {
        None
    }
}

pub struct NoNetwork;

impl ArtSources for NoNetwork {
    fn remote(&self, _: &str) -> RemoteState {
        RemoteState::Unknown
    }
    fn lookup(&self, _: &str, _: &str) -> LookupState {
        LookupState::Off
    }
    fn store_downloads(&self) -> bool {
        false
    }
    fn custom_dir(&self) -> Option<PathBuf> {
        None
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Want {
    Download(String),
    Lookup,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Origin {
    Override,
    Local,
    Remote,
    Placeholder,
}

#[derive(Debug, Clone)]
pub struct Resolved {
    /// The served file as a candidate (path, mtime and size key the variant cache).
    pub candidate: Option<ArtCandidate>,
    pub origin: Origin,
    pub wants: Vec<Want>,
}

impl Resolved {
    /// `artStatus`: "local", "remote" or "placeholder".
    pub fn status(&self) -> &'static str {
        match (&self.origin, &self.candidate) {
            (Origin::Placeholder, _) | (_, None) => "placeholder",
            (Origin::Remote, _) => "remote",
            (Origin::Override, Some(c)) if c.url.is_some() => "remote",
            _ => "local",
        }
    }
}

fn file_candidate(kind: &str, file: PathBuf, mtime: u64, size: u64, url: Option<&str>) -> ArtCandidate {
    ArtCandidate {
        kind: kind.to_string(),
        file: Some(file.to_string_lossy().into_owned()),
        url: url.map(str::to_string),
        mtime: Some(mtime),
        size: Some(size),
    }
}

fn custom_file(dir: &std::path::Path, name: &str) -> Option<(PathBuf, u64, u64)> {
    // Names are ours (a hash and an extension); anything else is ignored.
    if name.is_empty() || name.contains(['/', '\\']) || name.starts_with('.') {
        return None;
    }
    let p = dir.join(name);
    let m = std::fs::metadata(&p).ok().filter(|m| m.is_file())?;
    Some((p, super::mtime_ms(&m), m.len()))
}

/// Resolves one kind for one entry. `overrides` is the game's `artOverrides` object.
pub fn resolve(entry_id: &str, kind: &str, cands: &[ArtCandidate], overrides: Option<&Map<String, Value>>, src: &dyn ArtSources) -> Resolved {
    let mut wants = Vec::new();
    let done = |candidate: ArtCandidate, origin: Origin, wants: Vec<Want>| Resolved { candidate: Some(candidate), origin, wants };

    // 1. The user's choice.
    if let Some(o) = overrides.and_then(|o| o.get(kind)) {
        if let (Some(name), Some(dir)) = (o.get("custom").and_then(Value::as_str), src.custom_dir()) {
            if let Some((p, mtime, size)) = custom_file(&dir, name) {
                return done(file_candidate(kind, p, mtime, size, None), Origin::Override, wants);
            }
        }
        if let Some(url) = o.get("url").and_then(Value::as_str) {
            match src.remote(url) {
                RemoteState::Ready { file, mtime, size } => {
                    return done(file_candidate(kind, file, mtime, size, Some(url)), Origin::Override, wants)
                }
                RemoteState::Unknown => wants.push(Want::Download(url.to_string())),
                RemoteState::Missing => {}
            }
        }
    }

    // 2. The provider's candidates, in its order.
    for c in cands.iter().filter(|c| c.kind == kind) {
        if c.file.is_some() {
            return done(c.clone(), Origin::Local, wants);
        }
        if let Some(url) = c.url.as_deref().filter(|_| src.store_downloads()) {
            match src.remote(url) {
                RemoteState::Ready { file, mtime, size } => return done(file_candidate(kind, file, mtime, size, Some(url)), Origin::Remote, wants),
                RemoteState::Unknown => wants.push(Want::Download(url.to_string())),
                RemoteState::Missing => {}
            }
        }
    }

    // 3. SteamGridDB: the best few results, in order.
    match src.lookup(entry_id, kind) {
        LookupState::Off => {}
        LookupState::Unknown => wants.push(Want::Lookup),
        LookupState::Found(urls) => {
            for url in urls.iter().take(3) {
                match src.remote(url) {
                    RemoteState::Ready { file, mtime, size } => return done(file_candidate(kind, file, mtime, size, Some(url)), Origin::Remote, wants),
                    RemoteState::Unknown => {
                        // Fetch one at a time: the next is only needed if this one misses.
                        wants.push(Want::Download(url.clone()));
                        break;
                    }
                    RemoteState::Missing => {}
                }
            }
        }
    }

    Resolved { candidate: None, origin: Origin::Placeholder, wants }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    #[derive(Default)]
    struct Fake {
        remote: HashMap<String, RemoteState>,
        lookup: Option<LookupState>,
        custom: Option<PathBuf>,
        store: bool,
    }

    impl ArtSources for Fake {
        fn remote(&self, url: &str) -> RemoteState {
            self.remote.get(url).cloned().unwrap_or(RemoteState::Unknown)
        }
        fn lookup(&self, _: &str, _: &str) -> LookupState {
            self.lookup.clone().unwrap_or(LookupState::Off)
        }
        fn store_downloads(&self) -> bool {
            self.store
        }
        fn custom_dir(&self) -> Option<PathBuf> {
            self.custom.clone()
        }
    }

    fn file(kind: &str, f: &str) -> ArtCandidate {
        ArtCandidate { kind: kind.into(), file: Some(f.into()), url: None, mtime: Some(1), size: Some(2) }
    }
    fn url(kind: &str, u: &str) -> ArtCandidate {
        ArtCandidate { kind: kind.into(), file: None, url: Some(u.into()), mtime: None, size: None }
    }
    fn ready(f: &str) -> RemoteState {
        RemoteState::Ready { file: PathBuf::from(f), mtime: 3, size: 4 }
    }

    #[test]
    fn first_local_file_wins_and_nothing_is_wanted() {
        let src = Fake { store: true, ..Default::default() };
        let r = resolve("steam:1", "cover", &[file("cover", "a.png"), url("cover", "https://x/a")], None, &src);
        assert_eq!(r.status(), "local");
        assert!(r.wants.is_empty());
    }

    #[test]
    fn a_url_before_a_file_is_wanted_until_downloaded_then_wins() {
        let cands = [url("cover", "https://cdn/c.jpg"), file("cover", "capsule.jpg")];
        let mut src = Fake { store: true, ..Default::default() };
        let r = resolve("steam:1", "cover", &cands, None, &src);
        assert_eq!(r.candidate.unwrap().file.as_deref(), Some("capsule.jpg"));
        assert_eq!(r.wants, [Want::Download("https://cdn/c.jpg".into())]);

        src.remote.insert("https://cdn/c.jpg".into(), ready("orig/c.jpg"));
        let r = resolve("steam:1", "cover", &cands, None, &src);
        assert_eq!(r.status(), "remote");
        assert_eq!(r.candidate.unwrap().file.as_deref(), Some("orig/c.jpg"));

        src.remote.insert("https://cdn/c.jpg".into(), RemoteState::Missing);
        let r = resolve("steam:1", "cover", &cands, None, &src);
        assert_eq!((r.status(), r.wants.len()), ("local", 0));
    }

    #[test]
    fn store_downloads_off_skips_provider_urls() {
        let src = Fake { store: false, lookup: Some(LookupState::Unknown), ..Default::default() };
        let r = resolve("steam:1", "hero", &[url("hero", "https://cdn/h.jpg")], None, &src);
        assert_eq!(r.wants, [Want::Lookup]);
        assert_eq!(r.status(), "placeholder");
    }

    #[test]
    fn steamgriddb_only_after_provider_misses_and_one_download_at_a_time() {
        let cands = [url("hero", "https://cdn/h.jpg")];
        let mut src = Fake { store: true, lookup: Some(LookupState::Unknown), ..Default::default() };
        src.remote.insert("https://cdn/h.jpg".into(), RemoteState::Missing);
        assert_eq!(resolve("e", "hero", &cands, None, &src).wants, [Want::Lookup]);

        src.lookup = Some(LookupState::Found(vec!["https://sg/1".into(), "https://sg/2".into()]));
        assert_eq!(resolve("e", "hero", &cands, None, &src).wants, [Want::Download("https://sg/1".into())]);
        src.remote.insert("https://sg/1".into(), RemoteState::Missing);
        src.remote.insert("https://sg/2".into(), ready("o/2.png"));
        let r = resolve("e", "hero", &cands, None, &src);
        assert_eq!((r.status(), r.candidate.unwrap().url.as_deref()), ("remote", Some("https://sg/2")));

        src.lookup = Some(LookupState::Found(vec![]));
        let r = resolve("e", "hero", &cands, None, &src);
        assert_eq!((r.status(), r.wants.len()), ("placeholder", 0));
    }

    #[test]
    fn overrides_beat_everything_and_fall_through_when_unusable() {
        let t = tempfile::tempdir().unwrap();
        std::fs::write(t.path().join("abc.png"), b"x").unwrap();
        let mut src = Fake { store: true, custom: Some(t.path().to_path_buf()), ..Default::default() };
        let cands = [file("cover", "steam.png")];

        let o = json!({ "cover": { "custom": "abc.png" } });
        let r = resolve("e", "cover", &cands, o.as_object(), &src);
        assert_eq!(r.origin, Origin::Override);
        assert_eq!(r.status(), "local");
        assert!(r.candidate.unwrap().file.unwrap().ends_with("abc.png"));

        for evil in ["../abc.png", "..\\abc.png", "", "gone.png"] {
            let o = json!({ "cover": { "custom": evil } });
            assert_eq!(resolve("e", "cover", &cands, o.as_object(), &src).origin, Origin::Local, "{evil}");
        }

        let o = json!({ "cover": { "url": "https://sg/pick" } });
        let r = resolve("e", "cover", &cands, o.as_object(), &src);
        assert_eq!((r.origin.clone(), r.wants.clone()), (Origin::Local, vec![Want::Download("https://sg/pick".into())]));
        src.remote.insert("https://sg/pick".into(), ready("o/p.png"));
        let r = resolve("e", "cover", &cands, o.as_object(), &src);
        assert_eq!((r.origin.clone(), r.status()), (Origin::Override, "remote"));
    }
}
