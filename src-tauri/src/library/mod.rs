//! Turns provider results into entries: one per game as the user thinks of it.
//! Skins only ever see entries. `merge` decides which records share an entry.

pub mod entry;
pub mod merge;

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

pub use entry::Entry;

use crate::art::resolve::ArtSources;
use crate::art::ArtCandidate;

use crate::providers::model::ProviderGame;
use crate::userdata::games::UserData;
use crate::userdata::settings::LibrarySettings;

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
    /// Validated art candidates by source id, from the provider's `art()`.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub art: BTreeMap<String, Vec<ArtCandidate>>,
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

/// Builds one entry per shown group, for the providers `active` accepts, sorted by sort title.
pub fn build_entries(snap: &LibrarySnapshot, ud: &UserData, lib: &LibrarySettings, active: &dyn Fn(&str) -> bool, src: &dyn ArtSources) -> Vec<Entry> {
    let groups = merge::groups(snap, ud, lib, active);
    let mut out: Vec<Entry> = groups.list.iter().filter(|g| g.visible()).map(|g| Entry::from_group(g, ud, src)).collect();
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
    use crate::art::resolve::NoNetwork;
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
            ProviderRecords { provider_name: "Steam".into(), capabilities: vec!["launch".into()], games, ..Default::default() },
        );
        s.providers.insert("mock".into(), ProviderRecords { provider_name: "Mock".into(), ..Default::default() });
        s
    }

    #[test]
    fn entries_sort_by_sort_title_and_apply_user_data() {
        let mut ud = UserData::default();
        ud.games.insert("steam:2".into(), GameUserData { hidden: Some(false), favorite: true, ..Default::default() });
        ud.games.insert("steam:1".into(), GameUserData { tags: vec!["backlog".into()], ..Default::default() });
        let entries = build_entries(&snap(), &ud, &LibrarySettings::default(), &|_| true, &NoNetwork);
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
        assert!(build_entries(&snap(), &UserData::default(), &LibrarySettings::default(), &|p| p != "steam", &NoNetwork).is_empty());
    }

    /// The same game on Steam and GOG, chosen to be one entry.
    fn merged() -> (LibrarySnapshot, UserData) {
        let mut s = LibrarySnapshot::default();
        let scan = |v| parse_scan(v).unwrap().games;
        s.providers.insert(
            "steam".into(),
            ProviderRecords {
                provider_name: "Steam".into(),
                capabilities: vec!["launch".into()],
                games: scan(json!({ "games": [{ "sourceId": "1", "title": "Hades", "categories": ["RPG"], "sizeBytes": 10, "playtimeMinutes": 30, "lastPlayed": "2026-01-01T00:00:00Z", "installDir": "C:\\s" }] })),
                ..Default::default()
            },
        );
        s.providers.insert(
            "gog".into(),
            ProviderRecords {
                provider_name: "GOG".into(),
                capabilities: vec!["launch".into()],
                games: scan(json!({ "games": [{ "sourceId": "9", "title": "HADES™", "categories": ["Roguelike"], "sizeBytes": 20, "playtimeMinutes": 12, "lastPlayed": "2026-03-01T00:00:00Z", "metadata": { "developer": "Supergiant" } }] })),
                ..Default::default()
            },
        );
        let mut ud = UserData::default();
        ud.games.insert("steam:1".into(), GameUserData { favorite: true, tags: vec!["Co-op".into()], first_seen: Some("2026-02-01".into()), last_launched: Some("2026-01-05".into()), ..Default::default() });
        ud.games.insert("gog:9".into(), GameUserData { tags: vec!["co-op".into(), "Backlog".into()], first_seen: Some("2026-01-01".into()), last_launched: Some("2026-04-05".into()), ..Default::default() });
        merge::apply_choice(&mut ud, &["steam:1".to_string(), "gog:9".to_string()], merge::ChoiceMode::One, Some("steam"));
        (s, ud)
    }

    #[test]
    fn a_merged_entry_combines_its_records() {
        let (s, ud) = merged();
        let entries = build_entries(&s, &ud, &LibrarySettings::default(), &|_| true, &NoNetwork);
        assert_eq!(entries.len(), 1);
        let e = &entries[0];
        assert_eq!(e.id, "gog:9", "the oldest record, though Steam is preferred");
        assert_eq!((e.title.as_str(), e.preferred_source.as_str(), e.size_bytes), ("Hades", "steam", Some(10)));
        assert_eq!(e.sources.iter().map(|x| x.provider.as_str()).collect::<Vec<_>>(), ["steam", "gog"]);
        assert!(e.favorite, "favorite if any record is");
        assert_eq!(e.tags, ["Co-op", "Backlog"], "a union, ignoring case");
        assert_eq!(e.categories.len(), 2);
        assert_eq!(e.playtime_minutes, Some(42), "summed");
        assert_eq!(e.last_played.as_deref(), Some("2026-03-01T00:00:00Z"), "the latest");
        assert_eq!(e.last_launched.as_deref(), Some("2026-04-05"));
        assert_eq!(e.added_at, "2026-01-01", "the earliest");
        assert_eq!(e.metadata.developer.as_deref(), Some("Supergiant"), "gaps filled from the other store");
        assert!(e.labels.is_empty() && !e.ask_source);
    }

    #[test]
    fn separate_copies_carry_their_stores_name_after_the_stores_own_labels() {
        let (s, _) = merged();
        let entries = build_entries(&s, &UserData::default(), &LibrarySettings::default(), &|_| true, &NoNetwork);
        assert_eq!(entries.len(), 2, "nothing merges before the user answers");
        let labels: Vec<&[String]> = entries.iter().map(|e| e.labels.as_slice()).collect();
        assert!(labels.contains(&&["Steam".to_string()][..]) && labels.contains(&&["GOG".to_string()][..]), "{labels:?}");
    }

    #[test]
    fn disabling_a_provider_loses_nothing() {
        let (s, ud) = merged();
        let lib = LibrarySettings::default();
        let off = build_entries(&s, &ud, &lib, &|p| p != "steam", &NoNetwork);
        assert_eq!(off.len(), 1);
        assert_eq!(off[0].sources.len(), 1);
        assert!(off[0].favorite, "the favorite was set on the hidden copy");
        assert_eq!(off[0].tags, ["co-op", "Backlog"], "shown copies are read first, so GOG's spelling leads");
        let on = build_entries(&s, &ud, &lib, &|_| true, &NoNetwork);
        assert_eq!((on[0].id.as_str(), on[0].sources.len()), ("gog:9", 2));
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
