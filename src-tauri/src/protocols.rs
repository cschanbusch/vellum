//! The `skin` custom protocol (`http://skin.localhost` on Windows): serves the active skin's
//! folder and the reserved `/__vellum/*` paths from inside the exe, always with a strict CSP.
//! Verified by the Phase 0 origin spike (docs/decisions.md).

use std::borrow::Cow;
use std::path::{Component, Path, PathBuf};

use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager, UriSchemeResponder};

use crate::plugins::PluginKind;
use crate::userdata::settings::DEFAULT_SKIN;
use crate::{art, AppState};

pub const SKIN_SCHEME: &str = "skin";

pub const SKIN_CSP: &str = "default-src 'self'; img-src 'self' data: blob:; media-src 'self'; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-src 'none'";

const SDK_JS: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/sdk.js"));
const SDK_CSS: &[u8] = include_bytes!("../../sdk/src/sdk.css");
const FONT_INTER: &[u8] = include_bytes!("../../sdk/assets/fonts/InterVariable.woff2");

type Resp = Response<Cow<'static, [u8]>>;

fn respond(status: StatusCode, ctype: &str, body: Cow<'static, [u8]>) -> Resp {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, ctype)
        .header("Content-Security-Policy", SKIN_CSP)
        .header("X-Content-Type-Options", "nosniff")
        .header(header::CACHE_CONTROL, "no-cache")
        .body(body)
        .unwrap()
}

fn text(status: StatusCode, msg: &'static str) -> Resp {
    respond(status, "text/plain; charset=utf-8", Cow::Borrowed(msg.as_bytes()))
}

pub fn content_type(p: &Path) -> &'static str {
    match p.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("html" | "htm") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("ttf") => "font/ttf",
        Some("otf") => "font/otf",
        _ => "application/octet-stream",
    }
}

pub fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Serves `path` from inside `root` only: no `..`, no absolute paths, and the canonical
/// target (after symlinks/junctions) must still be inside the root.
pub fn serve_file(root: &Path, path: &str) -> Resp {
    let Some(decoded) = percent_decode(path) else {
        return text(StatusCode::BAD_REQUEST, "bad path");
    };
    let rel = Path::new(decoded.trim_start_matches('/'));
    if rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return text(StatusCode::FORBIDDEN, "forbidden");
    }
    let rel = if rel.as_os_str().is_empty() { Path::new("index.html") } else { rel };
    let (Ok(root_c), Ok(full)) = (root.canonicalize(), root.join(rel).canonicalize()) else {
        return text(StatusCode::NOT_FOUND, "not found");
    };
    if !full.starts_with(&root_c) {
        return text(StatusCode::FORBIDDEN, "forbidden");
    }
    match std::fs::read(&full) {
        Ok(bytes) => respond(StatusCode::OK, content_type(&full), Cow::Owned(bytes)),
        Err(_) => text(StatusCode::NOT_FOUND, "not found"),
    }
}

/// The active skin's folder; falls back to the default skin when the active one is invalid.
pub fn active_skin_dir(state: &AppState) -> Option<PathBuf> {
    let active = state.active_skin_id();
    let plugins = state.plugins.read().unwrap();
    let find = |id: &str| plugins.iter().find(|p| p.kind == PluginKind::Skin && p.id == id && p.is_valid()).map(|p| p.dir.clone());
    find(&active).or_else(|| find(DEFAULT_SKIN))
}

fn with_cache(mut r: Resp, value: &'static str) -> Resp {
    r.headers_mut().insert(header::CACHE_CONTROL, header::HeaderValue::from_static(value));
    r
}

const IMMUTABLE: &str = "public, max-age=31536000, immutable";

/// Everything on the skin origin. Art is decoded and resized on the art worker pool; all
/// other requests are answered immediately.
pub fn handle_skin(app: &AppHandle, req: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let path = req.uri().path().to_string();
    let query = req.uri().query().map(str::to_string);
    if let Some(rest) = path.strip_prefix("/__vellum/art/") {
        let Some((id, kind, width)) = art::parse_route(rest, query.as_deref()) else {
            return responder.respond(text(StatusCode::NOT_FOUND, "not found"));
        };
        let state = app.state::<AppState>();
        let Some(mut request) = state.art_request(&id, &kind, width) else {
            return responder.respond(text(StatusCode::NOT_FOUND, "no such entry"));
        };
        request.style = art::parse_style(query.as_deref());
        let cache_dir = art::variants_dir(&state.paths.data_dir);
        let versioned = query.as_deref().is_some_and(|q| q.split('&').any(|p| p.starts_with("v=")));
        art::spawn(move || {
            let out = art::serve(&request, &cache_dir);
            let r = respond(StatusCode::OK, out.content_type, out.body);
            responder.respond(if versioned { with_cache(r, IMMUTABLE) } else { r });
        });
        return;
    }
    responder.respond(handle_sync(app, &path));
}

fn handle_sync(app: &AppHandle, path: &str) -> Resp {
    if let Some(reserved) = path.strip_prefix("/__vellum/") {
        return match reserved {
            "sdk.js" => respond(StatusCode::OK, "text/javascript; charset=utf-8", Cow::Borrowed(SDK_JS)),
            "sdk.css" => respond(StatusCode::OK, "text/css; charset=utf-8", Cow::Borrowed(SDK_CSS)),
            "fonts/InterVariable.woff2" => with_cache(respond(StatusCode::OK, "font/woff2", Cow::Borrowed(FONT_INTER)), IMMUTABLE),
            _ => match reserved.strip_prefix("provider-icon/") {
                Some(id) => provider_icon(app, id),
                None => text(StatusCode::NOT_FOUND, "not found"),
            },
        };
    }
    let state = app.state::<AppState>();
    match active_skin_dir(&state) {
        Some(dir) => serve_file(&dir, path),
        None => text(StatusCode::NOT_FOUND, "no skin installed"),
    }
}

/// A provider's manifest icon, for source badges and filters.
fn provider_icon(app: &AppHandle, id: &str) -> Resp {
    let state = app.state::<AppState>();
    let plugins = state.plugins.read().unwrap();
    let found = plugins
        .iter()
        .find(|p| p.kind == PluginKind::Provider && p.id == id && p.is_valid())
        .and_then(|p| Some((p.dir.clone(), p.manifest.as_ref()?.icon.clone()?)));
    drop(plugins);
    match found {
        Some((dir, icon)) => serve_file(&dir, &icon),
        None => text(StatusCode::NOT_FOUND, "no icon"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serves_only_inside_the_root() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().join("skin");
        std::fs::create_dir_all(root.join("css")).unwrap();
        std::fs::write(root.join("index.html"), "<p>hi").unwrap();
        std::fs::write(root.join("css/a b.css"), "x").unwrap();
        std::fs::write(t.path().join("secret.txt"), "s").unwrap();

        let r = serve_file(&root, "/");
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(r.headers()["content-security-policy"], SKIN_CSP);
        assert_eq!(serve_file(&root, "/css/a%20b.css").status(), StatusCode::OK);
        for evil in ["/../secret.txt", "/%2e%2e/secret.txt", "/..%5csecret.txt", "/..%2fsecret.txt", "/C:%5cWindows%5cwin.ini"] {
            let s = serve_file(&root, evil).status();
            assert!(s == StatusCode::FORBIDDEN || s == StatusCode::NOT_FOUND, "{evil} -> {s}");
        }
        assert_eq!(serve_file(&root, "/missing.js").status(), StatusCode::NOT_FOUND);
    }
}
