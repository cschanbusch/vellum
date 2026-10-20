//! `userdata.json`: everything the user says about a game, keyed by game record id
//! (`<provider>:<sourceId>`) so it survives disabling a provider, merges and unmerges.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::atomic;

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UserData {
    pub schema_version: u32,
    pub games: BTreeMap<String, GameUserData>,
    /// Manual merge/unmerge overrides (Phase 5).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub merges: Vec<Value>,
    #[serde(flatten)]
    pub other: Map<String, Value>,
}

impl Default for UserData {
    fn default() -> Self {
        UserData { schema_version: SCHEMA_VERSION, games: BTreeMap::new(), merges: Vec::new(), other: Map::new() }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct GameUserData {
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub favorite: bool,
    /// `None` = follow the store (e.g. Steam's hidden collection); `Some` = the user decided.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hidden: Option<bool>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_launched: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    /// When Vellum first saw this game record (the entry's `addedAt`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_seen: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preferred_source: Option<String>,
    #[serde(skip_serializing_if = "Map::is_empty")]
    pub art_overrides: Map<String, Value>,
}

/// Loads `userdata.json`, keeping one `.bak` copy of the file as it was at startup.
/// An unreadable file is set aside and, if the backup parses, the backup is used.
pub fn load(path: &Path, bytes: Option<Vec<u8>>) -> UserData {
    let Some(bytes) = bytes else { return UserData::default() };
    match parse(&bytes) {
        Ok(ud) => {
            let _ = std::fs::write(atomic::sibling(path, "bak"), &bytes);
            ud
        }
        Err(e) => {
            let corrupt = atomic::sibling(path, "corrupt");
            let _ = std::fs::rename(path, &corrupt);
            tracing::error!(error = %e, "userdata unreadable; moved to {}", corrupt.display());
            std::fs::read(atomic::sibling(path, "bak"))
                .ok()
                .and_then(|b| parse(&b).ok())
                .inspect(|_| tracing::warn!("restored userdata from backup"))
                .unwrap_or_default()
        }
    }
}

fn parse(bytes: &[u8]) -> Result<UserData, String> {
    let mut doc: Value = serde_json::from_slice(atomic::strip_bom(bytes)).map_err(|e| e.to_string())?;
    if !doc.is_object() {
        return Err("userdata root is not an object".into());
    }
    // No migrations yet; version 0 (missing) has the same shape as version 1.
    doc["schemaVersion"] = SCHEMA_VERSION.into();
    serde_json::from_value(doc).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_omits_defaults() {
        let mut ud = UserData::default();
        ud.games.insert("steam:620".into(), GameUserData { favorite: true, ..Default::default() });
        let json = serde_json::to_string(&ud).unwrap();
        assert!(json.contains("\"favorite\":true") && !json.contains("tags"));
        let back = parse(json.as_bytes()).unwrap();
        assert_eq!(back.games["steam:620"], ud.games["steam:620"]);
    }

    #[test]
    fn corrupt_file_falls_back_to_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("userdata.json");
        let good = br#"{"schemaVersion":1,"games":{"steam:1":{"favorite":true}}}"#.to_vec();
        load(&path, Some(good)); // writes .bak
        std::fs::write(&path, b"{ broken").unwrap();
        let ud = load(&path, std::fs::read(&path).ok());
        assert!(ud.games["steam:1"].favorite);
        assert!(atomic::sibling(&path, "corrupt").exists());
    }
}
