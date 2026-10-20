//! Tauri commands. Only the shell's origin may call these (see capabilities/default.json);
//! skins and modules reach the backend solely through the shell's validated bridge.

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::library::Entry;
use crate::plugins::{PluginKind, PluginRecord, API_VERSION};
use crate::scanner::{self, Action, ActionResult, Notice, ProviderStatus};
use crate::userdata::games::GameUserData;
use crate::userdata::settings::{Settings, UiSettings};
use crate::skins::{self, SkinInfo};
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
    /// Icon file inside the plugin folder, if the manifest names one.
    icon: Option<String>,
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
        icon: m.and_then(|m| m.icon.clone()),
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

#[tauri::command(async)]
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
    if kind == PluginKind::Provider {
        if enabled {
            scanner::spawn_scan(&app, id.clone());
        } else {
            scanner::deactivate(&app, &id);
        }
    }
    let _ = app.emit(EVENT_PLUGINS_CHANGED, ());
    Ok(())
}

#[tauri::command]
pub fn activate_skin(app: AppHandle, state: State<AppState>, id: String) -> Result<(), String> {
    find_valid(&state, PluginKind::Skin, &id)?;
    state.settings.update(|s| s.active_skin = id.clone());
    *state.skins.fallback.lock().unwrap() = None;
    tracing::info!(%id, "skin activated");
    let _ = app.emit(EVENT_PLUGINS_CHANGED, ());
    skins::skin_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn reload_plugins(app: AppHandle, state: State<AppState>) {
    state.rescan_plugins();
    let _ = app.emit(EVENT_PLUGINS_CHANGED, ());
    skins::skin_changed(&app);
    scanner::scan_all(&app);
}

#[tauri::command(async)]
pub fn library_entries(state: State<AppState>) -> Vec<Entry> {
    state.entries()
}

#[tauri::command(async)]
pub fn provider_statuses(state: State<AppState>) -> Vec<ProviderStatus> {
    state.provider_statuses()
}

#[tauri::command(async)]
pub fn notices(state: State<AppState>) -> Vec<Notice> {
    state.notices()
}

#[tauri::command]
pub fn dismiss_notice(app: AppHandle, id: String) {
    scanner::dismiss_notice(&app, &id);
}

/// The user picked a folder for a provider location (Browse in a notice, or Re-locate).
/// The error is a sentence such as "This folder has no steamapps/libraryfolders.vdf."
#[tauri::command]
pub fn set_location(app: AppHandle, provider: String, key: String, path: String) -> Result<(), String> {
    scanner::set_location(&app, &provider, &key, &path)
}

#[tauri::command]
pub fn refresh_library(app: AppHandle) {
    scanner::scan_all(&app);
}

/// Launch, install, uninstall or open the store page. Runs off the main thread: a provider
/// call can take up to its timeout.
#[tauri::command(async)]
pub fn run_action(app: AppHandle, entry_id: String, action: Action, provider: Option<String>) -> Result<ActionResult, String> {
    scanner::run_action(&app, &entry_id, provider.as_deref(), action)
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

// ---- per-game user data -------------------------------------------------------------------

/// Applies a change to one game's user data and returns the updated entry. The shell pushes
/// that entry to the skin itself, so no full library reload is needed.
fn update_game(state: &AppState, entry_id: &str, f: impl FnOnce(&mut GameUserData)) -> Result<Entry, String> {
    if state.entry(entry_id).is_none() {
        return Err("That game is no longer in the library.".into());
    }
    state.userdata.update(|ud| f(ud.games.entry(entry_id.to_string()).or_default()));
    state.entry(entry_id).ok_or_else(|| "That game is no longer in the library.".into())
}

#[tauri::command(async)]
pub fn set_favorite(state: State<AppState>, entry_id: String, favorite: bool) -> Result<Entry, String> {
    update_game(&state, &entry_id, |g| g.favorite = favorite)
}

#[tauri::command(async)]
pub fn set_hidden(state: State<AppState>, entry_id: String, hidden: bool) -> Result<Entry, String> {
    update_game(&state, &entry_id, |g| g.hidden = Some(hidden))
}

/// Tags are trimmed, de-duplicated case-insensitively, at most 40 characters, 32 per game.
#[tauri::command(async)]
pub fn set_tags(state: State<AppState>, entry_id: String, tags: Vec<String>) -> Result<Entry, String> {
    update_game(&state, &entry_id, |g| g.tags = clean_tags(tags))
}

pub fn clean_tags(tags: Vec<String>) -> Vec<String> {
    let mut clean: Vec<String> = Vec::new();
    for t in tags {
        let t: String = t.trim().chars().take(40).collect();
        if !t.is_empty() && !clean.iter().any(|c| c.eq_ignore_ascii_case(&t)) {
            clean.push(t);
        }
    }
    clean.truncate(32);
    clean
}

#[tauri::command]
pub fn open_install_folder(state: State<AppState>, entry_id: String) -> Result<(), String> {
    let entry = state.entry(&entry_id).ok_or("That game is no longer in the library.")?;
    let dir = entry.sources.iter().find_map(|s| s.install_dir.clone()).ok_or("This game has no install folder.")?;
    let dir = std::path::PathBuf::from(dir);
    if !dir.is_dir() {
        return Err(format!("The install folder doesn't exist: {}", dir.display()));
    }
    platform::open_folder(&dir).map_err(|e| e.to_string())
}

// ---- skins and UI settings -----------------------------------------------------------------

#[tauri::command(async)]
pub fn skin_info(state: State<AppState>) -> Option<SkinInfo> {
    state.skin_info()
}

#[tauri::command]
pub fn set_skin_option(app: AppHandle, state: State<AppState>, skin: String, key: String, value: Value) -> Result<(), String> {
    find_valid(&state, PluginKind::Skin, &skin)?;
    if key.len() > 64 || value.to_string().len() > 4096 {
        return Err("Option key or value is too large.".into());
    }
    state.settings.update(|s| {
        s.plugins.skins.entry(skin.clone()).or_default().values.insert(key, value);
    });
    let _ = app.emit(skins::EVENT_SKIN_CHANGED, ());
    Ok(())
}

#[tauri::command]
pub fn reset_skin_options(app: AppHandle, state: State<AppState>, skin: String) {
    state.settings.update(|s| {
        if let Some(e) = s.plugins.skins.get_mut(&skin) {
            e.values.clear();
        }
    });
    let _ = app.emit(skins::EVENT_SKIN_CHANGED, ());
}

/// The active skin failed to load: show the default skin for the rest of the session.
#[tauri::command]
pub fn use_fallback_skin(app: AppHandle, state: State<AppState>, reason: String) {
    let failed = state.settings.read(|s| s.active_skin.clone());
    if failed == crate::userdata::settings::DEFAULT_SKIN || state.skins.fallback.lock().unwrap().is_some() {
        return;
    }
    tracing::error!(skin = %failed, %reason, "skin failed to load; falling back to the default skin");
    *state.skins.fallback.lock().unwrap() = Some(failed);
    skins::skin_changed(&app);
}

#[tauri::command(async)]
pub fn ui_settings(state: State<AppState>) -> UiSettings {
    state.settings.read(|s| s.ui.clone())
}

#[tauri::command]
pub fn update_ui_settings(app: AppHandle, state: State<AppState>, patch: Value) -> Result<UiSettings, String> {
    let before = state.dev_mode();
    let next = state.settings.update(|s| {
        let mut ui = s.ui.clone();
        ui.apply_patch(&patch)?;
        s.ui = ui.clone();
        Ok::<_, String>(ui)
    })?;
    if state.dev_mode() != before {
        tracing::info!(dev = state.dev_mode(), "developer mode changed");
        skins::update_dev_watch(&app);
        let _ = app.emit(skins::EVENT_SKIN_CHANGED, ());
    }
    Ok(next)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    maximized: bool,
    fullscreen: bool,
}

/// Window actions skins request through the SDK (frameless skins draw their own controls).
#[tauri::command]
pub fn window_action(app: AppHandle, action: String) -> Result<WindowInfo, String> {
    let win = app.get_webview_window("main").ok_or("no main window")?;
    let r = match action.as_str() {
        "minimize" => win.minimize(),
        "toggleMaximize" => {
            if win.is_maximized().unwrap_or(false) {
                win.unmaximize()
            } else {
                win.maximize()
            }
        }
        "close" => win.close(),
        "startDrag" => win.start_dragging(),
        "toggleFullscreen" => win.set_fullscreen(!win.is_fullscreen().unwrap_or(false)),
        "info" => Ok(()),
        other => return Err(format!("unknown window action {other}")),
    };
    r.map_err(|e| e.to_string())?;
    Ok(WindowInfo { maximized: win.is_maximized().unwrap_or(false), fullscreen: win.is_fullscreen().unwrap_or(false) })
}

/// DevTools for the shell and the skin; developer mode only.
#[tauri::command]
pub fn open_devtools(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    if !state.dev_mode() {
        return Err("Turn on developer mode first (Settings → Developer).".into());
    }
    app.get_webview_window("main").ok_or("no main window")?.open_devtools();
    Ok(())
}

#[tauri::command]
pub fn open_logs_folder(state: State<AppState>) -> Result<(), String> {
    let dir = state.paths.logs_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    platform::open_folder(&dir).map_err(|e| e.to_string())
}

/// Writes a structure-only diagnostics report into the logs folder and returns its path.
#[tauri::command(async)]
pub fn run_diagnostics(state: State<AppState>) -> Result<String, String> {
    let (report, _summary) = crate::diagnose::report(&state.paths, &crate::providers::locations::SystemRegistry);
    let dir = state.paths.logs_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = crate::util::now_iso().replace([':', '.'], "-");
    let path = dir.join(format!("diagnostics-{stamp}.json"));
    std::fs::write(&path, serde_json::to_string_pretty(&report).unwrap()).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::clean_tags;

    #[test]
    fn tags_are_cleaned() {
        let t = clean_tags(vec![" Co-op ".into(), "co-op".into(), "".into(), "x".repeat(50), "Backlog".into()]);
        assert_eq!(t, ["Co-op".to_string(), "x".repeat(40), "Backlog".to_string()]);
    }
}

/// A skin's preview image as a data URL (the skin origin only serves the active skin).
#[tauri::command(async)]
pub fn skin_preview(state: State<AppState>, id: String) -> Option<String> {
    let (dir, preview) = {
        let plugins = state.plugins.read().unwrap();
        let rec = plugins.iter().find(|p| p.kind == PluginKind::Skin && p.id == id && p.is_valid())?;
        (rec.dir.clone(), rec.manifest.as_ref()?.section.get("preview")?.as_str()?.to_string())
    };
    let full = dir.join(&preview).canonicalize().ok()?;
    if !full.starts_with(dir.canonicalize().ok()?) {
        return None;
    }
    let bytes = std::fs::read(&full).ok().filter(|b| b.len() <= 4 * 1024 * 1024)?;
    Some(format!("data:{};base64,{}", crate::protocols::content_type(&full), crate::util::base64(&bytes)))
}
