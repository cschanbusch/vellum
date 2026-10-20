//! Turns provider results into entries: one per game as the user thinks of it.
//! Skins only ever see entries. Merging duplicates across stores arrives in Phase 5; until
//! then each entry has exactly one source, but the shape already allows several.

pub mod entry;

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

pub use entry::Entry;

use crate::providers::model::ProviderGame;
use crate::userdata::games::UserData;

pub const SCHEMA_VERSION: u32 = 1;

/// `library-cache.json`: the last scan of every provider, shown instantly at startup.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LibrarySnapshot {
    pub schema_version: u32,
    pub providers: BTreeMap<String, ProviderRecords>,
}

impl Default for LibrarySnapshot {
    fn default() -> Self {
        LibrarySnapshot { schema_version: SCHEMA_VERSION, providers: BTreeMap::new() }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProviderRecords {
    pub provider_name: String,
    pub capabilities: Vec<String>,
    pub scanned_at: String,
    pub games: Vec<ProviderGame>,
}

/// The cache is disposable: anything unreadable or from another schema starts empty.
pub fn load_snapshot(_path: &Path, bytes: Option<Vec<u8>>) -> LibrarySnapshot {
    bytes
        .and_then(|b| serde_json::from_slice::<LibrarySnapshot>(&b).ok())
        .filter(|s| s.schema_version == SCHEMA_VERSION)
        .unwrap_or_default()
}

pub fn record_id(provider: &str, source_id: &str) -> String {
    format!("{provider}:{source_id}")
}

/// Builds entries for every provider `active` accepts, sorted by sort title.
pub fn build_entries(snap: &LibrarySnapshot, ud: &UserData, active: &dyn Fn(&str) -> bool) -> Vec<Entry> {
    let mut out: Vec<Entry> = snap
        .providers
        .iter()
        .filter(|(id, _)| active(id))
        .flat_map(|(id, recs)| recs.games.iter().map(move |g| Entry::single(id, recs, g, ud)))
        .collect();
    out.sort_by(|a, b| a.sort_title.cmp(&b.sort_title).then_with(|| a.id.cmp(&b.id)));
    out
}

/// Finds the provider record behind a game record id.
pub fn find<'a>(snap: &'a LibrarySnapshot, record: &str) -> Option<(&'a str, &'a ProviderRecords, &'a ProviderGame)> {
    let (provider, source) = record.split_once(':')?;
    let (pid, recs) = snap.providers.get_key_value(provider)?;
    let game = recs.games.iter().find(|g| g.source_id == source)?;
    Some((pid.as_str(), recs, game))
}

/// Marks newly seen records with the current time, for `addedAt`. Returns true if any changed.
pub fn note_first_seen(ud: &mut UserData, provider: &str, games: &[ProviderGame], now: &str) -> bool {
    let mut changed = false;
    for g in games {
        let e = ud.games.entry(record_id(provider, &g.source_id)).or_default();
        if e.first_seen.is_none() {
            e.first_seen = Some(now.to_string());
            changed = true;
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::model::parse_scan;
    use crate::userdata::games::GameUserData;
    use serde_json::json;

    fn snap() -> LibrarySnapshot {
        let games = parse_scan(json!({ "games": [
            { "sourceId": "1", "title": "The Witcher 3", "categories": ["RPG"], "sizeBytes": 10 },
            { "sourceId": "2", "title": "Hollow Knight", "hidden": true },
            { "sourceId": "3", "title": "A Short Hike" },
        ]}))
        .unwrap()
        .games;
        let mut s = LibrarySnapshot::default();
        s.providers.insert(
            "steam".into(),
            ProviderRecords { provider_name: "Steam".into(), capabilities: vec!["launch".into()], scanned_at: String::new(), games },
        );
        s.providers.insert("mock".into(), ProviderRecords { provider_name: "Mock".into(), ..Default::default() });
        s
    }

    #[test]
    fn entries_sort_by_sort_title_and_apply_user_data() {
        let mut ud = UserData::default();
        ud.games.insert("steam:2".into(), GameUserData { hidden: Some(false), favorite: true, ..Default::default() });
        ud.games.insert("steam:1".into(), GameUserData { tags: vec!["backlog".into()], ..Default::default() });
        let entries = build_entries(&snap(), &ud, &|_| true);
        let titles: Vec<&str> = entries.iter().map(|e| e.title.as_str()).collect();
        assert_eq!(titles, ["Hollow Knight", "A Short Hike", "The Witcher 3"]);
        let hk = &entries[0];
        assert!(hk.favorite && !hk.hidden, "user's choice beats the store's hidden flag");
        assert_eq!(entries[2].tags, ["backlog"]);
        assert_eq!(entries[2].categories[0].name, "RPG");
        assert_eq!(entries[2].sources[0].game_id, "steam:1");
    }

    #[test]
    fn inactive_providers_contribute_nothing() {
        assert!(build_entries(&snap(), &UserData::default(), &|p| p != "steam").is_empty());
    }

    #[test]
    fn find_and_first_seen() {
        let s = snap();
        let (p, _, g) = find(&s, "steam:3").unwrap();
        assert_eq!((p, g.title.as_str()), ("steam", "A Short Hike"));
        assert!(find(&s, "steam:404").is_none() && find(&s, "nocolon").is_none());

        let mut ud = UserData::default();
        assert!(note_first_seen(&mut ud, "steam", &s.providers["steam"].games, "T1"));
        assert!(!note_first_seen(&mut ud, "steam", &s.providers["steam"].games, "T2"));
        assert_eq!(ud.games["steam:1"].first_seen.as_deref(), Some("T1"));
    }
}
