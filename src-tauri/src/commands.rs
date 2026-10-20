//! Tauri commands. Only the shell's origin may call these (see capabilities/default.json);
//! skins and modules reach the backend solely through the shell's validated bridge.

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use crate::plugins::{PluginKind, PluginRecord, API_VERSION};
use crate::userdata::settings::Settings;
use crate::{platform, AppState, APP_NAME, APP_VERSION, EVENT_PLUGINS_CHANGED};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    name: &'static str,
    version: &'static str,
    api_version: u32,
    data_dir: String,
    portable: bool,
    plugins_dir: String,
    dev_plugins_dir: Option<String>,
}

#[tauri::command]
pub fn app_info(state: State<AppState>) -> AppInfo {
    let p = &state.paths;
    AppInfo {
        name: APP_NAME,
        version: APP_VERSION,
        api_version: API_VERSION,
        data_dir: p.data_dir.display().to_string(),
        portable: p.portable,
        plugins_dir: p.plugins_dir.display().to_string(),
        dev_plugins_dir: p.dev_plugins_dir.as_ref().map(|d| d.display().to_string()),
    }
}

/// What the Plugins page shows for one plugin.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginView {
    id: String,
    kind: PluginKind,
    name: String,
    version: Option<String>,
    author: Option<String>,
    description: Option<String>,
    folder: String,
    enabled: bool,
    /// "ok", "warning" or "error".
    status: &'static str,
    errors: Vec<String>,
    warnings: Vec<String>,
    /// The manifest's type section; the page derives declared permissions from it.
    section: Value,
}

fn view(rec: &PluginRecord, settings: &Settings) -> PluginView {
    let m = rec.manifest.as_ref();
    PluginView {
        id: rec.id.clone(),
        kind: rec.kind,
        name: rec.name.clone(),
        version: rec.version.clone(),
        author: m.and_then(|m| m.author.clone()),
        description: m.and_then(|m| m.description.clone()),
        folder: rec.dir.display().to_string(),
        enabled: rec.is_valid() && settings.plugin_enabled(rec.kind, &rec.id),
        status: if !rec.errors.is_empty() {
            "error"
        } else if !rec.warnings.is_empty() {
            "warning"
        } else {
            "ok"
        },
        errors: rec.errors.clone(),
        warnings: rec.warnings.clone(),
        section: m.map(|m| m.section.clone()).unwrap_or(Value::Null),
    }
}

#[tauri::command]
pub fn list_plugins(state: State<AppState>) -> Vec<PluginView> {
    let plugins = state.plugins.read().unwrap();
    state.settings.read(|s| plugins.iter().map(|p| view(p, s)).collect())
}

fn find_valid(state: &AppState, kind: PluginKind, id: &str) -> Result<(), String> {
    let plugins = state.plugins.read().unwrap();
    match plugins.iter().find(|p| p.kind == kind && p.id == id && p.is_valid()) {
        Some(_) => Ok(()),
        None => Err(format!("No valid {} plugin with id \"{id}\".", kind.as_str())),
    }
}

#[tauri::command]
pub fn set_plugin_enabled(
    app: AppHandle,
    state: State<AppState>,
    kind: PluginKind,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    if kind == PluginKind::Skin {
        return Err("Skins are activated, not enabled; use activate_skin.".into());
    }
    if enabled {
        find_valid(&state, kind, &id)?;
    }
    state.settings.update(|s| s.set_plugin_enabled(kind, &id, enabled));
    tracing::info!(kind = kind.as_str(), %id, enabled, "plugin toggled");
    let _ = app.emit(EVENT_PLUGINS_CHANGED, ());
    Ok(())
}

#[tauri::command]
pub fn activate_skin(app: AppHandle, state: State<AppState>, id: String) -> Result<(), String> {
    find_valid(&state, PluginKind::Skin, &id)?;
    state.settings.update(|s| s.active_skin = id.clone());
    tracing::info!(%id, "skin activated");
    let _ = app.emit(EVENT_PLUGINS_CHANGED, ());
    Ok(())
}

#[tauri::command]
pub fn reload_plugins(app: AppHandle, state: State<AppState>) {
    state.rescan_plugins();
    let _ = app.emit(EVENT_PLUGINS_CHANGED, ());
}

#[tauri::command]
pub fn open_plugins_folder(state: State<AppState>) -> Result<(), String> {
    let dir = &state.paths.plugins_dir;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    platform::open_folder(dir).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_data_folder(state: State<AppState>) -> Result<(), String> {
    platform::open_folder(&state.paths.data_dir).map_err(|e| e.to_string())
}
