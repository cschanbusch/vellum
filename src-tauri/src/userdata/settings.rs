use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::atomic;
use crate::plugins::PluginKind;

pub const SCHEMA_VERSION: u32 = 1;
pub const DEFAULT_SKIN: &str = "basis";

/// Each entry migrates a settings document from version `index` to `index + 1`.
const MIGRATIONS: &[fn(&mut Value)] = &[
    // 0 -> 1: pre-release files had no schemaVersion; the shape is unchanged.
    |_| {},
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub schema_version: u32,
    pub active_skin: String,
    pub plugins: PluginSettings,
    pub ui: UiSettings,
    /// Keys this version doesn't know (written by a newer Vellum) are kept, not dropped.
    #[serde(flatten)]
    pub other: Map<String, Value>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            schema_version: SCHEMA_VERSION,
            active_skin: DEFAULT_SKIN.into(),
            plugins: PluginSettings::default(),
            ui: UiSettings::default(),
            other: Map::new(),
        }
    }
}

/// Views, the remembered library state, shelves and developer mode. The shell owns the
/// shapes of the free-form parts (`last`, `views`, `shelves`); the backend only stores them.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct UiSettings {
    /// "last" (the last used view) or a view id.
    pub start_view: String,
    /// The library state when Vellum last ran: view, selectedId, sort, groupBy, filters.
    pub last: Value,
    /// `{ order: [viewId], hidden: [viewId] }`
    pub views: Value,
    /// `{ order: { <groupBy>: [label] }, collapsed: [key] }`
    pub shelves: Value,
    /// Skins whose `defaultView` has already been applied once.
    pub skins_seen: Vec<String>,
    pub dev_mode: bool,
    /// Music volume for skins' `vellum.music`, 0-1.
    pub music_volume: f64,
}

impl Default for UiSettings {
    fn default() -> Self {
        UiSettings {
            start_view: "last".into(),
            last: Value::Object(Map::new()),
            views: Value::Object(Map::new()),
            shelves: Value::Object(Map::new()),
            skins_seen: Vec::new(),
            dev_mode: false,
            music_volume: 0.7,
        }
    }
}

/// Keys of `UiSettings` the shell may patch, and the most JSON each may hold.
const UI_PATCH_LIMIT: usize = 256 * 1024;

impl UiSettings {
    /// Merges a shell-supplied patch (top-level keys only). Unknown keys and wrong types are
    /// rejected with a message.
    pub fn apply_patch(&mut self, patch: &Value) -> Result<(), String> {
        let obj = patch.as_object().ok_or("the patch must be an object")?;
        if patch.to_string().len() > UI_PATCH_LIMIT {
            return Err("the patch is too large".into());
        }
        let mut next = serde_json::to_value(&*self).map_err(|e| e.to_string())?;
        for (k, v) in obj {
            if next.get(k).is_none() {
                return Err(format!("unknown UI setting {k:?}"));
            }
            next[k] = v.clone();
        }
        *self = serde_json::from_value(next).map_err(|e| format!("invalid UI settings: {e}"))?;
        Ok(())
    }
}

/// Machine-specific plugin state, keyed by plugin id, so plugin folders stay portable.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PluginSettings {
    pub providers: BTreeMap<String, PluginEntry>,
    pub skins: BTreeMap<String, PluginEntry>,
    pub modules: BTreeMap<String, PluginEntry>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PluginEntry {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// Values for the options the plugin declares in its manifest `settings`.
    #[serde(skip_serializing_if = "Map::is_empty")]
    pub values: Map<String, Value>,
    /// Resolved location paths (providers), filled in Phase 2.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub locations: BTreeMap<String, String>,
}

impl PluginSettings {
    fn of(&self, kind: PluginKind) -> &BTreeMap<String, PluginEntry> {
        match kind {
            PluginKind::Provider => &self.providers,
            PluginKind::Skin => &self.skins,
            PluginKind::Module => &self.modules,
        }
    }

    fn of_mut(&mut self, kind: PluginKind) -> &mut BTreeMap<String, PluginEntry> {
        match kind {
            PluginKind::Provider => &mut self.providers,
            PluginKind::Skin => &mut self.skins,
            PluginKind::Module => &mut self.modules,
        }
    }
}

/// New providers and modules start enabled, except the mock provider.
pub fn default_enabled(kind: PluginKind, id: &str) -> bool {
    !(kind == PluginKind::Provider && id == "mock")
}

impl Settings {
    /// Skins are "enabled" only when active: exactly one skin runs at a time.
    pub fn plugin_enabled(&self, kind: PluginKind, id: &str) -> bool {
        if kind == PluginKind::Skin {
            return self.active_skin == id;
        }
        self.plugins
            .of(kind)
            .get(id)
            .and_then(|e| e.enabled)
            .unwrap_or_else(|| default_enabled(kind, id))
    }

    pub fn set_plugin_enabled(&mut self, kind: PluginKind, id: &str, enabled: bool) {
        self.plugins.of_mut(kind).entry(id.to_string()).or_default().enabled = Some(enabled);
    }
}

/// Loads settings, migrating old files and never failing: an unreadable file is set aside
/// as `settings.json.corrupt` and defaults are used.
pub fn load(path: &Path, bytes: Option<Vec<u8>>) -> Settings {
    let Some(bytes) = bytes else {
        return Settings::default();
    };
    match parse(&bytes) {
        Ok((settings, from)) => {
            if from > SCHEMA_VERSION {
                // Written by a newer Vellum: keep a copy before this version rewrites it.
                let bak = atomic::sibling(path, &format!("v{from}.bak"));
                let _ = std::fs::write(&bak, &bytes);
                tracing::warn!(from, "settings come from a newer version; backup kept at {}", bak.display());
            }
            settings
        }
        Err(e) => {
            let corrupt = atomic::sibling(path, "corrupt");
            let _ = std::fs::rename(path, &corrupt);
            tracing::error!(error = %e, "settings unreadable; moved to {} and using defaults", corrupt.display());
            Settings::default()
        }
    }
}

/// Returns the settings and the schema version the file was written with.
fn parse(bytes: &[u8]) -> Result<(Settings, u32), String> {
    let mut doc: Value = serde_json::from_slice(atomic::strip_bom(bytes)).map_err(|e| e.to_string())?;
    if !doc.is_object() {
        return Err("settings root is not an object".into());
    }
    let from = doc.get("schemaVersion").and_then(Value::as_u64).unwrap_or(0) as u32;
    for migrate in MIGRATIONS.iter().skip(from as usize) {
        migrate(&mut doc);
    }
    doc["schemaVersion"] = SCHEMA_VERSION.into();
    let settings = serde_json::from_value(doc).map_err(|e| e.to_string())?;
    Ok((settings, from))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_gives_defaults() {
        let s = load(Path::new("nowhere.json"), None);
        assert_eq!(s.active_skin, DEFAULT_SKIN);
        assert!(s.plugin_enabled(PluginKind::Provider, "steam"));
        assert!(!s.plugin_enabled(PluginKind::Provider, "mock"));
        assert!(s.plugin_enabled(PluginKind::Skin, "basis"));
        assert!(!s.plugin_enabled(PluginKind::Skin, "other"));
    }

    #[test]
    fn unversioned_file_is_migrated() {
        let s = load(Path::new("x"), Some(br#"{"activeSkin":"neon"}"#.to_vec()));
        assert_eq!(s.schema_version, SCHEMA_VERSION);
        assert_eq!(s.active_skin, "neon");
    }

    #[test]
    fn hand_edited_file_with_bom_loads() {
        let s = load(Path::new("x"), Some(b"\xEF\xBB\xBF{\"activeSkin\":\"neon\"}".to_vec()));
        assert_eq!(s.active_skin, "neon");
    }

    #[test]
    fn unknown_keys_survive_a_round_trip() {
        let s = load(Path::new("x"), Some(br#"{"schemaVersion":1,"futureThing":{"a":1}}"#.to_vec()));
        let out = serde_json::to_value(&s).unwrap();
        assert_eq!(out["futureThing"]["a"], 1);
    }

    #[test]
    fn enabled_state_round_trips() {
        let mut s = Settings::default();
        s.set_plugin_enabled(PluginKind::Provider, "mock", true);
        s.set_plugin_enabled(PluginKind::Module, "random-pick", false);
        let back = load(Path::new("x"), Some(serde_json::to_vec(&s).unwrap()));
        assert!(back.plugin_enabled(PluginKind::Provider, "mock"));
        assert!(!back.plugin_enabled(PluginKind::Module, "random-pick"));
    }

    #[test]
    fn ui_patches_merge_and_validate() {
        let mut ui = UiSettings::default();
        ui.apply_patch(&serde_json::json!({ "devMode": true, "views": { "hidden": ["list"] } })).unwrap();
        assert!(ui.dev_mode);
        assert_eq!(ui.views["hidden"][0], "list");
        assert_eq!(ui.start_view, "last", "untouched keys stay");
        assert!(ui.apply_patch(&serde_json::json!({ "devMode": "yes" })).is_err());
        assert!(ui.apply_patch(&serde_json::json!({ "nope": 1 })).is_err());
        assert!(ui.apply_patch(&serde_json::json!([1])).is_err());
        assert!(ui.dev_mode, "a rejected patch changes nothing");
    }

    #[test]
    fn corrupt_file_is_set_aside() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, b"{ not json").unwrap();
        let s = load(&path, std::fs::read(&path).ok());
        assert_eq!(s.active_skin, DEFAULT_SKIN);
        assert!(atomic::sibling(&path, "corrupt").exists());
        assert!(!path.exists());
    }

    #[test]
    fn newer_file_is_backed_up() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let s = load(&path, Some(br#"{"schemaVersion":99,"activeSkin":"x"}"#.to_vec()));
        assert_eq!(s.active_skin, "x");
        assert!(atomic::sibling(&path, "v99.bak").exists());
    }
}
