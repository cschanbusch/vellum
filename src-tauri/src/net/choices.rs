//! The Change art dialog: every candidate for one entry and kind (the provider's files and
//! URLs, SteamGridDB's results, the user's own file), small previews, and saving a choice as
//! an override in userdata.json. Option ids are `file:<path>`, `url:<url>` or `custom:<name>`;
//! only ids this module offered are accepted back.

use std::path::Path;

use serde::Serialize;
use serde_json::{json, Value};

use super::{remote, NetView};
use crate::art::resolve::{self, ArtSources, LookupState, RemoteState};
use crate::art::{self, ArtCandidate, Variant};
use crate::library::{self, Entry};
use crate::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtOption {
    pub id: String,
    /// Where it comes from: the provider's name, "SteamGridDB" or "Your file".
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    /// "ready", "missing" or "unknown" (not downloaded yet).
    pub state: &'static str,
    /// The user's current override.
    pub chosen: bool,
    /// What the entry shows now.
    pub in_use: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtChoices {
    pub kind: String,
    pub options: Vec<ArtOption>,
    /// No override: the resolution chain picks.
    pub automatic: bool,
    /// "off" (no key), "on", or "rejected" (the key was refused).
    pub steamgriddb: &'static str,
}

struct Context {
    provider_name: String,
    cands: Vec<ArtCandidate>,
    overrides: serde_json::Map<String, Value>,
    title: String,
    is_steam: bool,
    source_id: String,
}

fn context(state: &AppState, entry_id: &str) -> Result<Context, String> {
    let active = state.active_providers();
    let found = state.library.read(|snap| {
        let (pid, recs, g) = library::find(snap, entry_id)?;
        active.contains(pid).then(|| Context {
            provider_name: recs.provider_name.clone(),
            cands: recs.art.get(&g.source_id).cloned().unwrap_or_default(),
            overrides: Default::default(),
            title: g.title.clone(),
            is_steam: pid == "steam",
            source_id: g.source_id.clone(),
        })
    });
    let mut c = found.ok_or("That game is no longer in the library.")?;
    c.overrides = state.userdata.read(|ud| ud.games.get(entry_id).map(|u| u.art_overrides.clone()).unwrap_or_default());
    Ok(c)
}

fn check_kind(kind: &str) -> Result<(), String> {
    if library::entry::ART_KINDS.contains(&kind) {
        Ok(())
    } else {
        Err(format!("Unknown art kind {kind:?}."))
    }
}

/// Looks the entry up on SteamGridDB now if that hasn't happened yet (the dialog waits).
fn ensure_lookup(state: &AppState, entry_id: &str, kind: &str, c: &Context) {
    if NetView::new(state).lookup(entry_id, kind) != LookupState::Unknown {
        return;
    }
    let target = if c.is_steam { super::LookupTarget::Steam(c.source_id.clone()) } else { super::LookupTarget::Title(c.title.clone()) };
    let job = super::LookupJob { entry_id: entry_id.to_string(), target, kinds: vec![kind.to_string()] };
    super::run_lookup(&state.net, &super::agent(), &job);
}

fn state_name(s: &RemoteState) -> &'static str {
    match s {
        RemoteState::Ready { .. } => "ready",
        RemoteState::Missing => "missing",
        RemoteState::Unknown => "unknown",
    }
}

pub fn choices(state: &AppState, entry_id: &str, kind: &str) -> Result<ArtChoices, String> {
    check_kind(kind)?;
    let c = context(state, entry_id)?;
    if state.net.sgdb_on() {
        ensure_lookup(state, entry_id, kind, &c);
    }
    let view = NetView::new(state);
    let in_use = resolve::resolve(entry_id, kind, &c.cands, Some(&c.overrides), &view).candidate;
    let used = |file: Option<&str>, url: Option<&str>| {
        in_use.as_ref().is_some_and(|u| match url {
            Some(url) => u.url.as_deref() == Some(url),
            None => u.url.is_none() && u.file.as_deref() == file,
        })
    };
    let current = c.overrides.get(kind);
    let chosen_id = current.and_then(|o| {
        o.get("custom").and_then(Value::as_str).map(|n| format!("custom:{n}")).or_else(|| o.get("url").and_then(Value::as_str).map(|u| format!("url:{u}")))
    });
    let dims = |url: &str| state.net.remote.read(|r| r.urls.get(url).map(|x| (x.width, x.height))).unwrap_or((None, None));

    let mut options: Vec<ArtOption> = Vec::new();
    let mut push = |o: ArtOption| {
        if !options.iter().any(|x| x.id == o.id) {
            options.push(o);
        }
    };
    if let Some(name) = current.and_then(|o| o.get("custom")).and_then(Value::as_str) {
        let file = state.net.custom.join(name);
        let file_s = file.to_string_lossy().into_owned();
        let (w, h) = image::image_dimensions(&file).map_or((None, None), |(w, h)| (Some(w), Some(h)));
        push(ArtOption {
            id: format!("custom:{name}"),
            source: "Your file".into(),
            width: w,
            height: h,
            state: if file.exists() { "ready" } else { "missing" },
            chosen: true,
            in_use: used(Some(&file_s), None),
        });
    }
    for cand in c.cands.iter().filter(|x| x.kind == kind) {
        if let Some(f) = &cand.file {
            let (w, h) = image::image_dimensions(f).map_or((None, None), |(w, h)| (Some(w), Some(h)));
            push(ArtOption { id: format!("file:{f}"), source: c.provider_name.clone(), width: w, height: h, state: "ready", chosen: false, in_use: used(Some(f), None) });
        } else if let Some(u) = &cand.url {
            let (w, h) = dims(u);
            let id = format!("url:{u}");
            push(ArtOption {
                chosen: chosen_id.as_deref() == Some(id.as_str()),
                id,
                source: c.provider_name.clone(),
                width: w,
                height: h,
                state: state_name(&view.remote(u)),
                in_use: used(None, Some(u)),
            });
        }
    }
    let sg = state.net.sgdb.read(|s| s.entries.get(entry_id).and_then(|e| e.kinds.get(kind)).map(|k| k.images.clone()).unwrap_or_default());
    for img in sg {
        let id = format!("url:{}", img.url);
        push(ArtOption {
            chosen: chosen_id.as_deref() == Some(id.as_str()),
            id,
            source: "SteamGridDB".into(),
            width: Some(img.width).filter(|w| *w > 0),
            height: Some(img.height).filter(|h| *h > 0),
            state: state_name(&view.remote(&img.url)),
            in_use: used(None, Some(&img.url)),
        });
    }
    if let Some(u) = current.and_then(|o| o.get("url")).and_then(Value::as_str) {
        let (w, h) = dims(u);
        push(ArtOption { id: format!("url:{u}"), source: "Chosen earlier".into(), width: w, height: h, state: state_name(&view.remote(u)), chosen: true, in_use: used(None, Some(u)) });
    }
    Ok(ArtChoices {
        kind: kind.to_string(),
        options,
        automatic: current.is_none(),
        steamgriddb: if state.net.key_rejected() {
            "rejected"
        } else if state.net.sgdb_on() {
            "on"
        } else {
            "off"
        },
    })
}

/// The URLs this entry and kind may be set to: the provider's, SteamGridDB's, and the
/// current override's.
fn allowed_url(state: &AppState, entry_id: &str, kind: &str, c: &Context, url: &str) -> bool {
    c.cands.iter().any(|x| x.kind == kind && x.url.as_deref() == Some(url))
        || c.overrides.get(kind).and_then(|o| o.get("url")).and_then(Value::as_str) == Some(url)
        || state.net.sgdb.read(|s| s.entries.get(entry_id).and_then(|e| e.kinds.get(kind)).is_some_and(|k| k.images.iter().any(|i| i.url == url)))
}

fn sgdb_thumb(state: &AppState, entry_id: &str, kind: &str, url: &str) -> Option<String> {
    state.net.sgdb.read(|s| s.entries.get(entry_id)?.kinds.get(kind)?.images.iter().find(|i| i.url == url).map(|i| i.thumb.clone()))
}

/// A small preview of one option as a data URL (`None` when it can't be had).
pub fn thumb(state: &AppState, entry_id: &str, kind: &str, id: &str) -> Result<Option<String>, String> {
    check_kind(kind)?;
    let c = context(state, entry_id)?;
    let file = if let Some(name) = id.strip_prefix("custom:") {
        Some(state.net.custom.join(name)).filter(|p| p.is_file() && !name.contains(['/', '\\']))
    } else if let Some(f) = id.strip_prefix("file:") {
        if !c.cands.iter().any(|x| x.kind == kind && x.file.as_deref() == Some(f)) {
            return Err("That isn't one of this game's images.".into());
        }
        Some(Path::new(f).to_path_buf())
    } else if let Some(u) = id.strip_prefix("url:") {
        if !allowed_url(state, entry_id, kind, &c, u) {
            return Err("That isn't one of this game's images.".into());
        }
        // SteamGridDB has small thumbnails; store images are fetched whole (they're needed anyway).
        let source = match NetView::new(state).remote(u) {
            RemoteState::Ready { .. } => u.to_string(),
            _ => sgdb_thumb(state, entry_id, kind, u).unwrap_or_else(|| u.to_string()),
        };
        match super::fetch_now(state, &source) {
            RemoteState::Ready { file, .. } => Some(file),
            _ => None,
        }
    } else {
        return Err("Unknown option.".into());
    };
    let Some(file) = file else { return Ok(None) };
    let meta = std::fs::metadata(&file).map_err(|e| e.to_string())?;
    let cand = ArtCandidate {
        kind: kind.to_string(),
        file: Some(file.to_string_lossy().into_owned()),
        url: None,
        mtime: Some(art::mtime_ms(&meta)),
        size: Some(meta.len()),
    };
    let width = if kind == "icon" { Variant::Px(160) } else { Variant::Px(320) };
    match art::resized(&file, &cand, width, &art::variants_dir(&state.paths.data_dir)) {
        Ok(r) => Ok(Some(format!("data:{};base64,{}", r.content_type, crate::util::base64(&r.body)))),
        Err(e) => {
            tracing::warn!(file = %file.display(), error = %e, "art preview failed");
            Ok(None)
        }
    }
}

/// Copies an image the user picked into the custom art folder; returns its stored name.
pub fn import_file(state: &AppState, path: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("Couldn't read that file: {e}"))?;
    if meta.len() > remote::MAX_BYTES {
        return Err("That image is too large (30 MB at most).".into());
    }
    let bytes = std::fs::read(path).map_err(|e| format!("Couldn't read that file: {e}"))?;
    let (fmt, _, _) = remote::sniff(&bytes).ok_or("That file isn't a PNG, JPEG, WebP or GIF image.")?;
    let name = format!("{}.{}", remote::hash_hex(&bytes, 24), remote::extension(fmt));
    let dest = state.net.custom.join(&name);
    if !dest.exists() {
        crate::userdata::atomic::write(&dest, &bytes).map_err(|e| format!("Couldn't save the image: {e}"))?;
    }
    Ok(name)
}

fn save(state: &AppState, entry_id: &str, kind: &str, value: Option<Value>) -> Result<Entry, String> {
    state.userdata.update(|ud| {
        let g = ud.games.entry(entry_id.to_string()).or_default();
        match value {
            Some(v) => {
                g.art_overrides.insert(kind.to_string(), v);
            }
            None => {
                g.art_overrides.remove(kind);
            }
        }
    });
    tracing::info!(entry = entry_id, kind, "art override changed");
    state.entry(entry_id).ok_or_else(|| "That game is no longer in the library.".into())
}

/// Sets (or with `None` clears) the override for one kind to an offered option.
pub fn set(state: &AppState, entry_id: &str, kind: &str, id: Option<&str>) -> Result<Entry, String> {
    check_kind(kind)?;
    let c = context(state, entry_id)?;
    let value = match id {
        None => None,
        Some(id) => Some(if let Some(name) = id.strip_prefix("custom:") {
            if name.contains(['/', '\\']) || !state.net.custom.join(name).is_file() {
                return Err("That image is gone.".into());
            }
            json!({ "custom": name })
        } else if let Some(f) = id.strip_prefix("file:") {
            if !c.cands.iter().any(|x| x.kind == kind && x.file.as_deref() == Some(f)) {
                return Err("That isn't one of this game's images.".into());
            }
            // A copy, so the choice survives the store replacing its own file.
            json!({ "custom": import_file(state, Path::new(f))? })
        } else if let Some(u) = id.strip_prefix("url:") {
            if !allowed_url(state, entry_id, kind, &c, u) {
                return Err("That isn't one of this game's images.".into());
            }
            if let RemoteState::Missing = super::fetch_now(state, u) {
                return Err("That image couldn't be downloaded. Try another one.".into());
            }
            json!({ "url": u })
        } else {
            return Err("Unknown option.".into());
        }),
    };
    save(state, entry_id, kind, value)
}

/// Uses an image file from disk for one kind.
pub fn set_file(state: &AppState, entry_id: &str, kind: &str, path: &str) -> Result<Entry, String> {
    check_kind(kind)?;
    context(state, entry_id)?;
    let name = import_file(state, Path::new(path))?;
    save(state, entry_id, kind, Some(json!({ "custom": name })))
}

