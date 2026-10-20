//! `plugin.json` validation. Collects every problem with a plain-language message instead
//! of stopping at the first, so a plugin author can fix them all in one pass.

use std::collections::HashSet;
use std::path::{Component, Path};

use serde::Serialize;
use serde_json::{Map, Value};

use super::{PluginKind, API_VERSION, MIN_API_VERSION};

const PROVIDER_CAPABILITIES: &[&str] = &["launch", "install", "uninstall", "openStore", "watch"];
const OPTION_TYPES: &[&str] = &["color", "range", "select", "toggle", "font", "image"];

/// A manifest that passed validation.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: PluginKind,
    pub name: String,
    pub version: String,
    pub api_version: u32,
    pub author: Option<String>,
    pub description: Option<String>,
    pub entry: String,
    pub icon: Option<String>,
    /// Per-plugin settings options (same schema as skin options).
    pub settings: Vec<Value>,
    /// The type-specific section (`provider`, `skin` or `module`), validated but kept raw
    /// until the host for that type (Phase 2/3/6) gives it a typed form.
    pub section: Value,
}

#[derive(Debug, Default)]
pub struct Validation {
    /// Best-effort display fields, filled even when validation fails.
    pub id: Option<String>,
    pub name: Option<String>,
    pub version: Option<String>,
    pub manifest: Option<Manifest>,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

pub fn is_valid_id(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn is_option_id(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// `1.2.3`, optionally followed by `-pre` or `+build`.
fn is_version(v: &str) -> bool {
    let core = v.split(['-', '+']).next().unwrap_or("");
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

/// A relative path that stays inside the plugin folder.
fn is_safe_relative(p: &str) -> bool {
    let path = Path::new(p);
    !p.is_empty() && path.components().all(|c| matches!(c, Component::Normal(_) | Component::CurDir))
}

struct Checker<'a> {
    dir: &'a Path,
    errors: Vec<String>,
    warnings: Vec<String>,
}

impl Checker<'_> {
    fn err(&mut self, msg: impl Into<String>) {
        self.errors.push(msg.into());
    }

    fn warn(&mut self, msg: impl Into<String>) {
        self.warnings.push(msg.into());
    }

    fn required_str<'v>(&mut self, obj: &'v Map<String, Value>, key: &str, at: &str) -> Option<&'v str> {
        match obj.get(key) {
            Some(Value::String(s)) if !s.trim().is_empty() => Some(s),
            Some(Value::String(_)) => {
                self.err(format!("{at}\"{key}\" is empty."));
                None
            }
            Some(_) => {
                self.err(format!("{at}\"{key}\" must be a string."));
                None
            }
            None => {
                self.err(format!("{at}\"{key}\" is missing."));
                None
            }
        }
    }

    fn optional_str<'v>(&mut self, obj: &'v Map<String, Value>, key: &str, at: &str) -> Option<&'v str> {
        match obj.get(key) {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) => Some(s),
            Some(_) => {
                self.err(format!("{at}\"{key}\" must be a string."));
                None
            }
        }
    }

    fn optional_array<'v>(&mut self, obj: &'v Map<String, Value>, key: &str, at: &str) -> &'v [Value] {
        match obj.get(key) {
            None | Some(Value::Null) => &[],
            Some(Value::Array(a)) => a,
            Some(_) => {
                self.err(format!("{at}\"{key}\" must be an array."));
                &[]
            }
        }
    }

    fn string_list(&mut self, obj: &Map<String, Value>, key: &str, at: &str) -> Vec<String> {
        let items = self.optional_array(obj, key, at);
        let mut out = Vec::new();
        for (i, v) in items.iter().enumerate() {
            match v.as_str() {
                Some(s) => out.push(s.to_string()),
                None => self.err(format!("{at}\"{key}\"[{i}] must be a string.")),
            }
        }
        out
    }

    /// A file the manifest points at: must be a safe relative path that exists.
    fn file(&mut self, rel: &str, what: &str, missing_is_error: bool) {
        if !is_safe_relative(rel) {
            self.err(format!("{what} \"{rel}\" must be a relative path inside the plugin folder."));
        } else if !self.dir.join(rel).is_file() {
            let msg = format!("{what} \"{rel}\" does not exist in the plugin folder.");
            if missing_is_error {
                self.err(msg);
            } else {
                self.warn(msg);
            }
        }
    }

    /// Option schema shared by skin `options` and every plugin's `settings`.
    fn options(&mut self, items: &[Value], at: &str) {
        let mut ids = HashSet::new();
        for (i, item) in items.iter().enumerate() {
            let here = format!("{at}[{i}].");
            let Some(o) = item.as_object() else {
                self.err(format!("{at}[{i}] must be an object."));
                continue;
            };
            if let Some(id) = self.required_str(o, "id", &here) {
                if !is_option_id(id) {
                    self.err(format!("{here}\"id\" may only use letters, digits, - and _."));
                } else if !ids.insert(id.to_string()) {
                    self.err(format!("{here}\"id\" \"{id}\" is used twice."));
                }
            }
            self.required_str(o, "label", &here);
            let Some(ty) = self.required_str(o, "type", &here) else { continue };
            if !OPTION_TYPES.contains(&ty) {
                self.err(format!("{here}\"type\" \"{ty}\" is not one of: {}.", OPTION_TYPES.join(", ")));
                continue;
            }
            if ty == "range" {
                for k in ["min", "max"] {
                    if !o.get(k).is_some_and(Value::is_number) {
                        self.err(format!("{here}\"{k}\" must be a number for a range option."));
                    }
                }
            }
            if ty == "select" && !o.get("choices").is_some_and(|c| c.as_array().is_some_and(|a| !a.is_empty())) {
                self.err(format!("{here}\"choices\" must be a non-empty array for a select option."));
            }
            if !o.contains_key("default") {
                self.warn(format!("{here}has no \"default\"."));
            }
            if let Some(var) = self.optional_str(o, "cssVar", &here) {
                if !var.starts_with("--") {
                    self.err(format!("{here}\"cssVar\" must start with \"--\"."));
                }
            }
        }
    }

    fn provider_section(&mut self, s: &Map<String, Value>) {
        let at = "provider.";
        match s.get("locations") {
            None => {}
            Some(Value::Object(locs)) => {
                for (key, loc) in locs {
                    let here = format!("provider.locations.{key}.");
                    let Some(loc) = loc.as_object() else {
                        self.err(format!("provider.locations.{key} must be an object."));
                        continue;
                    };
                    self.required_str(loc, "label", &here);
                    if loc.get("required").is_some_and(|r| !r.is_boolean()) {
                        self.err(format!("{here}\"required\" must be true or false."));
                    }
                    for (i, hint) in self.optional_array(loc, "registry", &here).to_vec().iter().enumerate() {
                        let hat = format!("{here}registry[{i}].");
                        let Some(h) = hint.as_object() else {
                            self.err(format!("{here}registry[{i}] must be an object."));
                            continue;
                        };
                        if let Some(hive) = self.required_str(h, "hive", &hat) {
                            if hive.parse::<crate::platform::Hive>().is_err() {
                                self.err(format!("{hat}\"hive\" must be HKCU or HKLM."));
                            }
                        }
                        self.required_str(h, "key", &hat);
                        self.required_str(h, "value", &hat);
                    }
                    self.string_list(loc, "defaults", &here);
                    self.string_list(loc, "validate", &here);
                }
            }
            Some(_) => self.err("provider.\"locations\" must be an object."),
        }
        if s.get("derivedLocations").is_some_and(|d| !d.is_boolean()) {
            self.err("provider.\"derivedLocations\" must be true or false.");
        }
        self.string_list(s, "registryRead", at);
        self.string_list(s, "uriSchemes", at);
        self.string_list(s, "artHosts", at);
        self.string_list(s, "denyFiles", at);
        for cap in self.string_list(s, "capabilities", at) {
            if !PROVIDER_CAPABILITIES.contains(&cap.as_str()) {
                self.warn(format!("provider.\"capabilities\" has unknown entry \"{cap}\"; it will be ignored."));
            }
        }
    }

    fn skin_section(&mut self, s: &Map<String, Value>) {
        let at = "skin.";
        if let Some(p) = self.optional_str(s, "preview", at) {
            self.file(p, "skin.preview", false);
        }
        self.optional_str(s, "defaultView", at);
        if s.get("window").is_some_and(|w| !w.is_object()) {
            self.err("skin.\"window\" must be an object.");
        }
        for key in ["styles", "overrides"] {
            match s.get(key) {
                None => {}
                Some(Value::Object(m)) => {
                    for (view, file) in m {
                        match file.as_str() {
                            Some(f) => self.file(f, &format!("skin.{key}.{view}"), true),
                            None => self.err(format!("skin.{key}.{view} must be a file path.")),
                        }
                    }
                }
                Some(_) => self.err(format!("skin.\"{key}\" must be an object.")),
            }
        }
        let views = self.optional_array(s, "views", at).to_vec();
        let mut ids = HashSet::new();
        for (i, v) in views.iter().enumerate() {
            let here = format!("skin.views[{i}].");
            let Some(v) = v.as_object() else {
                self.err(format!("skin.views[{i}] must be an object."));
                continue;
            };
            if let Some(id) = self.required_str(v, "id", &here) {
                if !is_valid_id(id) {
                    self.err(format!("{here}\"id\" may only use lowercase letters, digits and hyphens."));
                } else if ["list", "covers", "spotlight"].contains(&id) || !ids.insert(id.to_string()) {
                    self.err(format!("{here}\"id\" \"{id}\" is already taken."));
                }
            }
            self.required_str(v, "name", &here);
            if let Some(entry) = self.required_str(v, "entry", &here) {
                self.file(entry, &format!("{here}entry"), true);
            }
        }
        let options = self.optional_array(s, "options", at).to_vec();
        self.options(&options, "skin.options");
    }

    fn module_section(&mut self, s: &Map<String, Value>) {
        let at = "module.";
        if let Some(o) = self.optional_str(s, "overlay", at) {
            self.file(o, "module.overlay", true);
        }
        let mut ids = HashSet::new();
        for (i, c) in self.optional_array(s, "commands", at).to_vec().iter().enumerate() {
            let here = format!("module.commands[{i}].");
            let Some(c) = c.as_object() else {
                self.err(format!("module.commands[{i}] must be an object."));
                continue;
            };
            if let Some(id) = self.required_str(c, "id", &here) {
                if !ids.insert(id.to_string()) {
                    self.err(format!("{here}\"id\" \"{id}\" is used twice."));
                }
            }
            self.required_str(c, "label", &here);
        }
        match s.get("globalHotkey") {
            None | Some(Value::Null) => {}
            Some(Value::Object(g)) => {
                if let Some(cmd) = self.required_str(g, "command", "module.globalHotkey.") {
                    if !ids.contains(cmd) {
                        self.err(format!("module.globalHotkey.\"command\" \"{cmd}\" is not one of the module's commands."));
                    }
                }
            }
            Some(_) => self.err("module.\"globalHotkey\" must be an object."),
        }
    }
}

/// Validates `plugin.json` text for a plugin in `dir`, found in the folder for `expected`.
pub fn validate(dir: &Path, expected: PluginKind, text: &str) -> Validation {
    let mut out = Validation::default();
    let root: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(e) => {
            out.errors.push(format!("plugin.json is not valid JSON: {e}."));
            return out;
        }
    };
    let Some(obj) = root.as_object() else {
        out.errors.push("plugin.json must contain a JSON object.".into());
        return out;
    };

    let mut c = Checker { dir, errors: Vec::new(), warnings: Vec::new() };

    let id = c.required_str(obj, "id", "").map(str::to_string);
    if let Some(id) = &id {
        if !is_valid_id(id) {
            c.err(format!("\"id\" \"{id}\" may only use lowercase letters, digits and hyphens."));
        }
        let folder = dir.file_name().unwrap_or_default().to_string_lossy();
        if folder != id.as_str() {
            c.warn(format!("Folder name \"{folder}\" differs from id \"{id}\"; the id is used."));
        }
    }
    out.id = id.clone();
    out.name = obj.get("name").and_then(Value::as_str).map(str::to_string);
    out.version = obj.get("version").and_then(Value::as_str).map(str::to_string);

    let kind = match c.required_str(obj, "type", "") {
        Some(t) => match PluginKind::parse(t) {
            Some(k) if k == expected => Some(k),
            Some(k) => {
                c.err(format!(
                    "This is a {} plugin, but it is in the plugins/{} folder. Move it to plugins/{}.",
                    k.as_str(),
                    expected.folder(),
                    k.folder()
                ));
                None
            }
            None => {
                c.err(format!("\"type\" \"{t}\" must be provider, skin or module."));
                None
            }
        },
        None => None,
    };

    let name = c.required_str(obj, "name", "").map(str::to_string);
    let version = c.required_str(obj, "version", "").map(str::to_string);
    if let Some(v) = &version {
        if !is_version(v) {
            c.err(format!("\"version\" \"{v}\" must look like 1.0.0."));
        }
    }

    let api_version = match obj.get("apiVersion") {
        Some(v) => match v.as_u64() {
            Some(n) if (MIN_API_VERSION as u64..=API_VERSION as u64).contains(&n) => Some(n as u32),
            Some(n) => {
                let supported = if MIN_API_VERSION == API_VERSION {
                    format!("version {API_VERSION}")
                } else {
                    format!("versions {MIN_API_VERSION}–{API_VERSION}")
                };
                c.err(format!("Targets host API version {n}, but this {} supports {supported}.", crate::APP_NAME));
                None
            }
            None => {
                c.err("\"apiVersion\" must be a whole number.");
                None
            }
        },
        None => {
            c.err("\"apiVersion\" is missing.");
            None
        }
    };

    let author = c.optional_str(obj, "author", "").map(str::to_string);
    let description = c.optional_str(obj, "description", "").map(str::to_string);
    let entry = c.required_str(obj, "entry", "").map(str::to_string);
    if let Some(e) = &entry {
        c.file(e, "\"entry\"", true);
    }
    let icon = c.optional_str(obj, "icon", "").map(str::to_string);
    if let Some(i) = &icon {
        c.file(i, "\"icon\"", false);
    }

    let settings = c.optional_array(obj, "settings", "").to_vec();
    c.options(&settings, "settings");

    let section = kind.map(|k| match obj.get(k.as_str()) {
        Some(Value::Object(s)) => {
            match k {
                PluginKind::Provider => c.provider_section(s),
                PluginKind::Skin => c.skin_section(s),
                PluginKind::Module => c.module_section(s),
            }
            Value::Object(s.clone())
        }
        Some(_) => {
            c.err(format!("\"{}\" must be an object.", k.as_str()));
            Value::Null
        }
        None => {
            c.err(format!("The \"{}\" section is missing.", k.as_str()));
            Value::Null
        }
    });

    out.errors = c.errors;
    out.warnings = c.warnings;
    if out.errors.is_empty() {
        out.manifest = Some(Manifest {
            id: id.unwrap(),
            kind: kind.unwrap(),
            name: name.unwrap(),
            version: version.unwrap(),
            api_version: api_version.unwrap(),
            author,
            description,
            entry: entry.unwrap(),
            icon,
            settings,
            section: section.unwrap(),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn dir_with(files: &[&str]) -> tempfile::TempDir {
        let base = tempfile::tempdir().unwrap();
        for f in files {
            let p = base.path().join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, "").unwrap();
        }
        base
    }

    fn check(dir: &Path, kind: PluginKind, v: Value) -> Validation {
        validate(dir, kind, &v.to_string())
    }

    fn base(kind: &str, entry: &str) -> Value {
        json!({ "id": "x", "type": kind, "name": "X", "version": "1.0.0", "apiVersion": 1, "entry": entry, kind: {} })
    }

    #[test]
    fn ids_and_versions() {
        assert!(is_valid_id("quick-launch") && is_valid_id("gog2"));
        assert!(!is_valid_id("Steam") && !is_valid_id("a_b") && !is_valid_id(""));
        assert!(is_version("1.0.0") && is_version("2.10.3-beta.1") && is_version("1.0.0+abc"));
        assert!(!is_version("1.0") && !is_version("v1.0.0") && !is_version("1.x.0"));
    }

    #[test]
    fn minimal_manifests_pass_for_each_type() {
        let d = dir_with(&["provider.js", "index.html"]);
        assert!(check(d.path(), PluginKind::Provider, base("provider", "provider.js")).manifest.is_some());
        assert!(check(d.path(), PluginKind::Skin, base("skin", "index.html")).manifest.is_some());
        assert!(check(d.path(), PluginKind::Module, base("module", "index.html")).manifest.is_some());
    }

    #[test]
    fn collects_all_errors_at_once() {
        let d = dir_with(&[]);
        let v = check(
            d.path(),
            PluginKind::Provider,
            json!({ "id": "Bad_Id", "type": "provider", "version": "1", "apiVersion": 99, "entry": "provider.js" }),
        );
        assert!(v.manifest.is_none());
        let all = v.errors.join("\n");
        for needle in ["lowercase letters", "\"name\" is missing", "must look like 1.0.0", "API version 99", "does not exist", "section is missing"] {
            assert!(all.contains(needle), "missing {needle:?} in:\n{all}");
        }
    }

    #[test]
    fn wrong_folder_for_type() {
        let d = dir_with(&["index.html"]);
        let v = check(d.path(), PluginKind::Provider, base("skin", "index.html"));
        assert!(v.errors[0].contains("Move it to plugins/skins"));
    }

    #[test]
    fn entry_cannot_escape_the_folder() {
        let d = dir_with(&[]);
        for entry in ["../evil.js", "C:\\evil.js", "/evil.js"] {
            let v = check(d.path(), PluginKind::Provider, base("provider", entry));
            assert!(v.errors.iter().any(|e| e.contains("relative path inside")), "{entry}: {:?}", v.errors);
        }
    }

    #[test]
    fn provider_section_rules() {
        let d = dir_with(&["provider.js"]);
        let mut m = base("provider", "provider.js");
        m["provider"] = json!({
            "locations": { "root": { "label": "Steam", "registry": [{ "hive": "HKCR", "key": "k", "value": "v" }] } },
            "capabilities": ["launch", "teleport"],
            "uriSchemes": "steam"
        });
        let v = check(d.path(), PluginKind::Provider, m);
        assert!(v.errors.iter().any(|e| e.contains("HKCU or HKLM")));
        assert!(v.errors.iter().any(|e| e.contains("\"uriSchemes\" must be an array")));
        assert!(v.warnings.iter().any(|w| w.contains("teleport")));
    }

    #[test]
    fn skin_options_and_views() {
        let d = dir_with(&["index.html", "views/timeline.js"]);
        let mut m = base("skin", "index.html");
        m["skin"] = json!({
            "views": [
                { "id": "timeline", "name": "Timeline", "entry": "views/timeline.js" },
                { "id": "covers", "name": "Dup", "entry": "views/timeline.js" }
            ],
            "options": [
                { "id": "accent", "label": "Accent", "type": "color", "default": "#fff", "cssVar": "--v-accent" },
                { "id": "size", "label": "Size", "type": "range", "default": 1 },
                { "id": "accent", "label": "Again", "type": "sparkle" }
            ]
        });
        let v = check(d.path(), PluginKind::Skin, m);
        let all = v.errors.join("\n");
        assert!(all.contains("\"covers\" is already taken"), "{all}");
        assert!(all.contains("\"min\" must be a number"), "{all}");
        assert!(all.contains("used twice"), "{all}");
        assert!(all.contains("\"sparkle\" is not one of"), "{all}");
    }

    #[test]
    fn module_hotkey_must_name_a_command() {
        let d = dir_with(&["index.html"]);
        let mut m = base("module", "index.html");
        m["module"] = json!({
            "commands": [{ "id": "open", "label": "Open" }],
            "globalHotkey": { "command": "close" }
        });
        let v = check(d.path(), PluginKind::Module, m);
        assert!(v.errors.iter().any(|e| e.contains("not one of the module's commands")));
    }
}
