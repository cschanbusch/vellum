//! What providers hand back to the host, and the host-side description of a provider.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::locations::LocationDecl;
use crate::plugins::PluginRecord;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GameKind {
    #[default]
    Game,
    Tool,
    Dlc,
    Other,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Metadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub developer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publisher: Option<String>,
    /// ISO date.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_date: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub genres: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// One game as a provider reports it (the spec's `ProviderGame`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderGame {
    pub source_id: String,
    pub title: String,
    #[serde(default)]
    pub kind: GameKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    /// Opaque to the host; handed back unchanged to `launch`.
    #[serde(default)]
    pub launch_data: Value,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub categories: Vec<String>,
    /// Short labels shown with the title, such as "Demo", "Playtest" or "Soundtrack".
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub labels: Vec<String>,
    #[serde(default)]
    pub metadata: Metadata,
    /// The store itself hides this game (e.g. Steam's hidden collection).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub hidden: bool,
    /// Minutes played, as the store counts them: every session, not only Vellum's launches.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub playtime_minutes: Option<u64>,
    /// ISO time the store last saw the game played.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_played: Option<String>,
}

/// Checks a value for one of a plugin's declared `settings`: only declared options can be set, and
/// only to a value of their kind. That also keeps data a provider stores in its values (the custom
/// provider's games) out of reach of this path.
pub fn check_setting(declared: &[Value], key: &str, value: &Value) -> Result<(), String> {
    let opt = declared.iter().find(|o| o.get("id").and_then(Value::as_str) == Some(key)).ok_or_else(|| format!("Unknown option {key:?}."))?;
    let ok = match opt.get("type").and_then(Value::as_str) {
        Some("toggle") => value.is_boolean(),
        Some("text") => value.as_str().is_some_and(|t| t.chars().count() <= 2000),
        Some("select") => opt.get("choices").and_then(Value::as_array).is_some_and(|c| c.iter().any(|x| x.get("value") == Some(value))),
        Some("range") => value.as_f64().is_some_and(|v| {
            opt.get("min").and_then(Value::as_f64).is_none_or(|m| v >= m) && opt.get("max").and_then(Value::as_f64).is_none_or(|m| v <= m)
        }),
        _ => false,
    };
    if ok {
        Ok(())
    } else {
        Err(format!("That isn't a valid value for {key:?}."))
    }
}

#[derive(Debug, Default)]
pub struct ScanResult {
    pub games: Vec<ProviderGame>,
    /// One message per game that was dropped for being malformed.
    pub skipped: Vec<String>,
}

/// Validates a `scan()` return value. Malformed games are skipped individually;
/// a malformed overall shape is an error.
pub fn parse_scan(v: Value) -> Result<ScanResult, String> {
    let Some(games) = v.get("games").and_then(Value::as_array) else {
        return Err("scan() must return an object with a \"games\" array".into());
    };
    let mut out = ScanResult::default();
    let mut seen = std::collections::HashSet::new();
    for (i, g) in games.iter().enumerate() {
        match serde_json::from_value::<ProviderGame>(g.clone()) {
            Ok(game) if game.source_id.trim().is_empty() => out.skipped.push(format!("game {i}: empty sourceId")),
            Ok(game) if !seen.insert(game.source_id.clone()) => {
                out.skipped.push(format!("game {i}: duplicate sourceId {:?}", game.source_id))
            }
            Ok(mut game) => {
                if !game.launch_data.is_object() {
                    game.launch_data = Value::Object(Map::new());
                }
                // Labels are badges: a few, short, no blanks.
                game.labels.retain(|l| !l.trim().is_empty());
                game.labels.iter_mut().for_each(|l| *l = l.trim().chars().take(20).collect());
                game.labels.truncate(3);
                out.games.push(game);
            }
            Err(e) => out.skipped.push(format!("game {i}: {e}")),
        }
    }
    Ok(out)
}

/// Everything the host needs to run one provider, derived from its validated manifest
/// and the user's settings for it.
#[derive(Debug, Clone)]
pub struct ProviderSpec {
    pub id: String,
    pub name: String,
    pub dir: PathBuf,
    pub entry: String,
    pub locations: Vec<LocationDecl>,
    pub derived_locations: bool,
    pub registry_read: Vec<String>,
    pub uri_schemes: Vec<String>,
    pub art_hosts: Vec<String>,
    pub capabilities: Vec<String>,
    pub deny_files: Vec<String>,
    /// Manifest defaults overlaid with saved values.
    pub settings: Map<String, Value>,
    /// Per-game options (`provider.gameSettings`), edited from the game menu's Launch options.
    pub game_settings: Vec<Value>,
    /// `ctx.gameSettings` for this call: the defaults, overlaid with the game's saved values at
    /// launch.
    pub game_values: Map<String, Value>,
    /// The duplicates dialog suggests separate entries for this provider's games (an emulator's
    /// game is usually a different product from a store game of the same name).
    pub separate_duplicates: bool,
}

/// Each option's `default`, by id.
pub fn defaults(options: &[Value]) -> Map<String, Value> {
    let mut out = Map::new();
    for opt in options {
        if let (Some(id), Some(default)) = (opt.get("id").and_then(Value::as_str), opt.get("default")) {
            out.insert(id.to_string(), default.clone());
        }
    }
    out
}

fn strings(section: &Value, key: &str) -> Vec<String> {
    section
        .get(key)
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default()
}

impl ProviderSpec {
    /// `None` for plugins that are not valid providers.
    pub fn from_record(rec: &PluginRecord, saved: &Map<String, Value>) -> Option<Self> {
        let m = rec.manifest.as_ref().filter(|m| m.kind == crate::plugins::PluginKind::Provider)?;
        let s = &m.section;
        let mut settings = defaults(&m.settings);
        for (k, v) in saved {
            settings.insert(k.clone(), v.clone());
        }
        let game_settings = s.get("gameSettings").and_then(Value::as_array).cloned().unwrap_or_default();
        let mut capabilities = strings(s, "capabilities");
        // Entries carry their store's capabilities, so this tells the game menu to offer the dialog.
        if !game_settings.is_empty() && !capabilities.iter().any(|c| c == "launchOptions") {
            capabilities.push("launchOptions".into());
        }
        Some(ProviderSpec {
            id: m.id.clone(),
            name: m.name.clone(),
            dir: rec.dir.clone(),
            entry: m.entry.clone(),
            locations: LocationDecl::from_section(s),
            derived_locations: s.get("derivedLocations").and_then(Value::as_bool).unwrap_or(false),
            registry_read: strings(s, "registryRead"),
            uri_schemes: strings(s, "uriSchemes"),
            art_hosts: strings(s, "artHosts"),
            capabilities,
            deny_files: strings(s, "denyFiles"),
            settings,
            game_values: defaults(&game_settings),
            game_settings,
            separate_duplicates: s.get("duplicates").and_then(Value::as_str) == Some("separate"),
        })
    }

    pub fn can(&self, capability: &str) -> bool {
        self.capabilities.iter().any(|c| c == capability)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_declared_settings_with_fitting_values_can_be_set() {
        let declared = [
            json!({ "id": "silent", "type": "toggle", "default": true }),
            json!({ "id": "count", "type": "range", "min": 10, "max": 50, "default": 20 }),
            json!({ "id": "mode", "type": "select", "default": "a", "choices": [{ "value": "a", "label": "A" }] }),
            json!({ "id": "tint", "type": "color", "default": "#000" }),
        ];
        assert!(check_setting(&declared, "silent", &json!(false)).is_ok());
        assert!(check_setting(&declared, "silent", &json!("no")).is_err());
        assert!(check_setting(&declared, "count", &json!(50)).is_ok());
        assert!(check_setting(&declared, "count", &json!(51)).is_err());
        assert!(check_setting(&declared, "mode", &json!("a")).is_ok());
        assert!(check_setting(&declared, "mode", &json!("b")).is_err());
        assert!(check_setting(&declared, "tint", &json!("#fff")).is_err(), "the page doesn't offer this type");
        assert!(check_setting(&declared, "games", &json!([])).is_err(), "undeclared: the custom provider's list stays safe");
    }

    #[test]
    fn scan_results_are_validated_per_game() {
        let r = parse_scan(json!({ "games": [
            { "sourceId": "620", "title": "Portal 2", "sizeBytes": 123, "launchData": { "appid": "620" } },
            { "sourceId": "1", "title": "Tool", "kind": "tool", "launchData": "not an object" },
            { "title": "no id" },
            { "sourceId": "620", "title": "dupe" },
            { "sourceId": "  ", "title": "blank" },
            { "sourceId": "2", "title": "Bad kind", "kind": "spaceship" },
            { "sourceId": "3", "title": "Labelled", "labels": ["Demo", " ", "A very long label indeed, too long", "x", "y"] }
        ]}))
        .unwrap();
        assert_eq!(r.games[2].labels, ["Demo", "A very long label in", "x"], "blank dropped, trimmed to 20, at most 3");
        assert_eq!(r.games.len(), 3);
        assert_eq!(r.games[1].kind, GameKind::Tool);
        assert!(r.games[1].launch_data.is_object());
        assert_eq!(r.skipped.len(), 4, "{:?}", r.skipped);
        assert!(parse_scan(json!([])).is_err());
    }
}
