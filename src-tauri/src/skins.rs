//! The active skin: which one, its option values, its window settings, and developer mode's
//! file watching. The shell computes views from the skin's manifest section (sdk/src/view-order.ts).

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::art::{self, ArtRequest, Variant};
use crate::library;
use crate::plugins::PluginKind;
use crate::userdata::settings::DEFAULT_SKIN;
use crate::AppState;

/// Payload: `{ path }` relative to the skin folder, with forward slashes.
pub const EVENT_SKIN_FILE_CHANGED: &str = "vellum://skin-file-changed";
/// The active skin's options or identity changed; the shell re-fetches `skin_info`.
pub const EVENT_SKIN_CHANGED: &str = "vellum://skin-changed";

#[derive(Default)]
pub struct SkinRuntime {
    /// Session-only override after the active skin failed to load (spec: fall back to basis).
    pub fallback: Mutex<Option<String>>,
    watcher: Mutex<Option<Debouncer<RecommendedWatcher>>>,
}

/// What the shell needs to host the active skin.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkinInfo {
    pub id: String,
    pub name: String,
    /// The manifest's `skin` section (views, styles, overrides, options, window, defaultView).
    pub section: Value,
    /// Saved option values (defaults are applied by the shell from `section.options`).
    pub values: Map<String, Value>,
    /// Set when the user's chosen skin failed and the default is shown instead.
    pub fallback_from: Option<String>,
    pub dev: bool,
}

impl AppState {
    /// The skin to show: the saved choice unless it failed this session.
    pub fn active_skin_id(&self) -> String {
        if self.skins.fallback.lock().unwrap().is_some() {
            return DEFAULT_SKIN.to_string();
        }
        self.settings.read(|s| s.active_skin.clone())
    }

    pub fn dev_mode(&self) -> bool {
        self.dev_flag || self.settings.read(|s| s.ui.dev_mode)
    }

    pub fn skin_info(&self) -> Option<SkinInfo> {
        let wanted = self.active_skin_id();
        let plugins = self.plugins.read().unwrap();
        let valid = |id: &str| plugins.iter().find(|p| p.kind == PluginKind::Skin && p.id == id && p.is_valid());
        let rec = valid(&wanted).or_else(|| valid(DEFAULT_SKIN))?;
        let m = rec.manifest.as_ref()?;
        let values = self.settings.read(|s| s.plugins.skins.get(&rec.id).map(|e| e.values.clone()).unwrap_or_default());
        Some(SkinInfo {
            id: rec.id.clone(),
            name: rec.name.clone(),
            section: m.section.clone(),
            values,
            fallback_from: self.skins.fallback.lock().unwrap().clone(),
            dev: self.dev_mode(),
        })
    }

    fn active_skin_dir(&self) -> Option<PathBuf> {
        crate::protocols::active_skin_dir(self)
    }

    /// Looks up what to serve for an entry's art; `None` when the entry isn't shown.
    pub fn art_request(&self, entry_id: &str, kind: &str, width: Variant) -> Option<ArtRequest> {
        let active = self.active_providers();
        self.library.read(|snap| {
            let (pid, recs, g) = library::find(snap, entry_id)?;
            if !active.contains(pid) {
                return None;
            }
            let candidate = recs.art.get(&g.source_id).and_then(|c| art::pick(c, kind)).cloned();
            Some(ArtRequest { kind: kind.to_string(), width, title: g.title.clone(), candidate })
        })
    }
}

/// Applies the active skin's `window` section: frame, minimum size and background color.
pub fn apply_window(app: &AppHandle) {
    let state = app.state::<AppState>();
    let Some(info) = state.skin_info() else { return };
    let Some(win) = app.get_webview_window("main") else { return };
    let w = info.section.get("window").cloned().unwrap_or(Value::Null);
    let frameless = w.get("frameless").and_then(Value::as_bool).unwrap_or(false);
    let _ = win.set_decorations(!frameless);
    let min_w = w.get("minWidth").and_then(Value::as_f64).unwrap_or(960.0).max(640.0);
    let min_h = w.get("minHeight").and_then(Value::as_f64).unwrap_or(600.0).max(400.0);
    let _ = win.set_min_size(Some(tauri::LogicalSize::new(min_w, min_h)));
    if let Some(bg) = w.get("background").and_then(Value::as_str).and_then(parse_hex_color) {
        let _ = win.set_background_color(Some(bg));
    }
}

/// `#rgb` or `#rrggbb`.
pub fn parse_hex_color(s: &str) -> Option<tauri::window::Color> {
    let h = s.strip_prefix('#')?;
    let px = |i: usize, n: usize| u8::from_str_radix(&h[i..i + n], 16).ok().map(|v| if n == 1 { v * 17 } else { v });
    match h.len() {
        3 => Some(tauri::window::Color(px(0, 1)?, px(1, 1)?, px(2, 1)?, 255)),
        6 => Some(tauri::window::Color(px(0, 2)?, px(2, 2)?, px(4, 2)?, 255)),
        _ => None,
    }
}

/// Developer mode: watch the active skin's folder and tell the shell what changed, so CSS can
/// be swapped live and anything else reloads the skin (the shell keeps its state).
pub fn update_dev_watch(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mut slot = state.skins.watcher.lock().unwrap();
    *slot = None;
    if !state.dev_mode() {
        return;
    }
    let Some(dir) = state.active_skin_dir() else { return };
    let root = dir.canonicalize().unwrap_or(dir.clone());
    let handle = app.clone();
    let debouncer = new_debouncer(Duration::from_millis(150), move |res: DebounceEventResult| {
        let Ok(events) = res else { return };
        let mut seen = std::collections::BTreeSet::new();
        for e in events {
            let p = e.path.canonicalize().unwrap_or(e.path.clone());
            if let Ok(rel) = p.strip_prefix(&root) {
                seen.insert(rel.to_string_lossy().replace('\\', "/"));
            }
        }
        if seen.contains("plugin.json") {
            // New options or views: re-read the manifests before the shell asks for them.
            handle.state::<AppState>().rescan_plugins();
        }
        for path in seen {
            tracing::debug!(%path, "skin file changed");
            let _ = handle.emit(EVENT_SKIN_FILE_CHANGED, serde_json::json!({ "path": path }));
        }
    });
    match debouncer {
        Ok(mut d) => {
            if let Err(e) = d.watcher().watch(&dir, RecursiveMode::Recursive) {
                tracing::warn!(error = %e, "cannot watch the skin folder");
                return;
            }
            tracing::info!(dir = %dir.display(), "developer mode: watching the skin folder");
            *slot = Some(d);
        }
        Err(e) => tracing::warn!(error = %e, "file watcher unavailable"),
    }
}

/// After the active skin changes (activation, fallback, reload): window, watcher, event.
pub fn skin_changed(app: &AppHandle) {
    apply_window(app);
    update_dev_watch(app);
    let _ = app.emit(EVENT_SKIN_CHANGED, ());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_colors() {
        assert_eq!(parse_hex_color("#0b0d12"), Some(tauri::window::Color(11, 13, 18, 255)));
        assert_eq!(parse_hex_color("#fff"), Some(tauri::window::Color(255, 255, 255, 255)));
        assert_eq!(parse_hex_color("0b0d12"), None);
        assert_eq!(parse_hex_color("#12345"), None);
        assert_eq!(parse_hex_color("#zzzzzz"), None);
    }
}
