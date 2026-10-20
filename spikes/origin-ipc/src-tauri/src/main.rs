// Phase 0 spike: can a Tauri 2 shell host a skin in an iframe on its own custom-scheme
// origin, with a strict CSP, no access to Tauri IPC, and a postMessage bridge?
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::borrow::Cow;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use tauri::http::{header, Request, Response, StatusCode};

const SKIN_CSP: &str = "default-src 'self'; img-src 'self' data: blob:; media-src 'self'; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-src 'none'";
const SDK_JS: &str = include_str!("../../sdk/sdk.js");

static PINGS: AtomicUsize = AtomicUsize::new(0);

#[tauri::command]
fn ping(msg: String) -> String {
    let n = PINGS.fetch_add(1, Ordering::SeqCst) + 1;
    println!("[ping #{n}] {msg}");
    format!("pong #{n}: {msg}")
}

#[tauri::command]
fn report(app: tauri::AppHandle, results: serde_json::Value) {
    println!("SPIKE_REPORT {}", serde_json::to_string_pretty(&results).unwrap());
    println!("SPIKE_PINGS {}", PINGS.load(Ordering::SeqCst));
    if std::env::var_os("SPIKE_AUTOEXIT").is_some() {
        app.exit(0);
    }
}

fn spike_dir(sub: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join(sub)
}

fn percent_decode(s: &str) -> Option<String> {
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

fn content_type(p: &Path) -> &'static str {
    match p.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

fn respond(status: StatusCode, ctype: &str, body: Vec<u8>) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, ctype)
        .header("Content-Security-Policy", SKIN_CSP)
        .header("X-Content-Type-Options", "nosniff")
        .body(Cow::Owned(body))
        .unwrap()
}

/// Serves files only from `root`, plus reserved `/__vellum/*` paths embedded in the exe.
fn serve(root: &Path, req: &Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let raw = req.uri().path();
    let Some(path) = percent_decode(raw) else {
        return respond(StatusCode::BAD_REQUEST, "text/plain", b"bad path".to_vec());
    };
    println!("[protocol] {} {}", req.uri().host().unwrap_or("?"), path);

    if path == "/__vellum/sdk.js" {
        return respond(StatusCode::OK, "text/javascript; charset=utf-8", SDK_JS.as_bytes().to_vec());
    }

    let rel = Path::new(path.trim_start_matches('/'));
    if rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return respond(StatusCode::FORBIDDEN, "text/plain", b"forbidden".to_vec());
    }
    let rel = if rel.as_os_str().is_empty() { Path::new("index.html") } else { rel };

    let (Ok(root), Ok(full)) = (root.canonicalize(), root.join(rel).canonicalize()) else {
        return respond(StatusCode::NOT_FOUND, "text/plain", b"not found".to_vec());
    };
    // Canonicalize resolves symlinks/junctions, so this also catches link escapes.
    if !full.starts_with(&root) {
        return respond(StatusCode::FORBIDDEN, "text/plain", b"forbidden".to_vec());
    }
    match std::fs::read(&full) {
        Ok(bytes) => respond(StatusCode::OK, content_type(&full), bytes),
        Err(_) => respond(StatusCode::NOT_FOUND, "text/plain", b"not found".to_vec()),
    }
}

fn main() {
    let skin_root = spike_dir("skin");
    let module_root = spike_dir("module");
    tauri::Builder::default()
        .register_uri_scheme_protocol("skin", move |_ctx, req| serve(&skin_root, &req))
        .register_uri_scheme_protocol("vmod0", move |_ctx, req| serve(&module_root, &req))
        .invoke_handler(tauri::generate_handler![ping, report])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
