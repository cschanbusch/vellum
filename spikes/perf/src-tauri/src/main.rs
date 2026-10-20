// Phase 0 spike: virtualized cover grid scroll performance inside a sandboxed skin iframe.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::borrow::Cow;
use std::path::{Component, Path, PathBuf};

use tauri::http::{header, Request, Response, StatusCode};

const SKIN_CSP: &str = "default-src 'self'; img-src 'self' data: blob:; media-src 'self'; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-src 'none'";

#[tauri::command]
fn report(app: tauri::AppHandle, results: serde_json::Value) {
    println!("SPIKE_REPORT {}", serde_json::to_string_pretty(&results).unwrap());
    if std::env::var_os("SPIKE_AUTOEXIT").is_some() {
        app.exit(0);
    }
}

fn content_type(p: &Path) -> &'static str {
    match p.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "jpg" => "image/jpeg",
        _ => "application/octet-stream",
    }
}

fn serve(root: &Path, req: &Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let rel = Path::new(req.uri().path().trim_start_matches('/'));
    let not_found = || Response::builder().status(StatusCode::NOT_FOUND).body(Cow::Borrowed(&b""[..])).unwrap();
    if rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return not_found();
    }
    let full = root.join(rel);
    match std::fs::read(&full) {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, content_type(&full))
            .header(header::CACHE_CONTROL, "max-age=31536000, immutable")
            .header("Content-Security-Policy", SKIN_CSP)
            .body(Cow::Owned(bytes))
            .unwrap(),
        Err(_) => not_found(),
    }
}

fn main() {
    let skin_root: PathBuf = Path::new(env!("CARGO_MANIFEST_DIR")).join("../skin");
    tauri::Builder::default()
        .register_uri_scheme_protocol("skin", move |_ctx, req| serve(&skin_root, &req))
        .invoke_handler(tauri::generate_handler![report])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
