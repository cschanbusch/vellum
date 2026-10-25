//! Steam store details (`appdetails`): developer, publisher, release date, genres and a short
//! description, cached in `cache/metadata/steam.json`. The provider's own metadata (read from
//! Steam's local cache) always wins; fetched details only fill what it lacks.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::providers::model::Metadata;

pub const SCHEMA_VERSION: u32 = 1;
/// Spacing between requests: Steam limits the store API to about 200 calls per 5 minutes.
pub const SPACING_MS: u64 = 1500;

pub fn api_base() -> String {
    std::env::var("VELLUM_STEAM_STORE_API").unwrap_or_else(|_| "https://store.steampowered.com/api".to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DetailsIndex {
    pub schema_version: u32,
    /// By appid.
    pub apps: BTreeMap<String, DetailsRecord>,
}

impl Default for DetailsIndex {
    fn default() -> Self {
        DetailsIndex { schema_version: SCHEMA_VERSION, apps: BTreeMap::new() }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DetailsRecord {
    /// Unix seconds of the fetch.
    pub at: u64,
    /// `None` when Steam has no store page for the app.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Metadata>,
}

pub fn load(_path: &Path, bytes: Option<Vec<u8>>) -> DetailsIndex {
    bytes
        .and_then(|b| serde_json::from_slice::<DetailsIndex>(&b).ok())
        .filter(|s| s.schema_version == SCHEMA_VERSION)
        .unwrap_or_default()
}

/// Whether an app's details should be fetched: never fetched, or older than the refresh
/// period (`refresh_days` 0 = never refresh). Expired details stay in use until replaced.
pub fn due(rec: Option<&DetailsRecord>, now: u64, refresh_days: u32) -> bool {
    match rec {
        None => true,
        Some(_) if refresh_days == 0 => false,
        Some(r) => now.saturating_sub(r.at) >= refresh_days as u64 * 86_400,
    }
}

/// Fills the provider's gaps from fetched details.
pub fn merge(provider: &Metadata, fetched: Option<&Metadata>) -> Metadata {
    let Some(f) = fetched else { return provider.clone() };
    let pick = |a: &Option<String>, b: &Option<String>| a.clone().filter(|s| !s.is_empty()).or_else(|| b.clone());
    Metadata {
        developer: pick(&provider.developer, &f.developer),
        publisher: pick(&provider.publisher, &f.publisher),
        release_date: pick(&provider.release_date, &f.release_date),
        genres: if provider.genres.is_empty() { f.genres.clone() } else { provider.genres.clone() },
        description: pick(&provider.description, &f.description),
    }
}

pub fn url(base: &str, appid: &str) -> String {
    format!("{base}/appdetails?appids={appid}&l=english&cc=us")
}

/// Parses an `appdetails` reply. `Ok(None)` means Steam answered but has no page for the app.
pub fn parse(v: &Value, appid: &str) -> Result<Option<Metadata>, String> {
    let app = v.get(appid).ok_or("reply doesn't mention the app")?;
    if !app.get("success").and_then(Value::as_bool).unwrap_or(false) {
        return Ok(None);
    }
    let d = app.get("data").ok_or("no data")?;
    let first = |k: &str| {
        d.get(k).and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(", ")).filter(|s| !s.is_empty())
    };
    let genres = d
        .get("genres")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|g| g.get("description").and_then(Value::as_str))
        .map(str::to_string)
        .collect();
    let release_date = d
        .get("release_date")
        .filter(|r| !r.get("coming_soon").and_then(Value::as_bool).unwrap_or(false))
        .and_then(|r| r.get("date"))
        .and_then(Value::as_str)
        .and_then(parse_date);
    let description = d.get("short_description").and_then(Value::as_str).map(clean_text).filter(|s| !s.is_empty());
    Ok(Some(Metadata { developer: first("developers"), publisher: first("publishers"), release_date, genres, description }))
}

const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/// Steam's English dates: "18 Nov, 2011", "Nov 18, 2011", "November 2011", "2011".
pub fn parse_date(s: &str) -> Option<String> {
    let words: Vec<String> = s.split([' ', ',', '.']).filter(|w| !w.is_empty()).map(str::to_lowercase).collect();
    let month = words.iter().find_map(|w| MONTHS.iter().position(|m| w.starts_with(m)).filter(|_| w.chars().all(char::is_alphabetic)))?;
    let nums: Vec<u32> = words.iter().filter_map(|w| w.parse().ok()).collect();
    let year = *nums.iter().find(|&&n| (1970..=2100).contains(&n))?;
    let day = nums.iter().find(|&&n| (1..=31).contains(&n)).copied();
    Some(match day {
        Some(d) => format!("{year:04}-{:02}-{d:02}", month + 1),
        None => format!("{year:04}-{:02}", month + 1),
    })
}

/// Store text can hold HTML tags and entities.
pub fn clean_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    let out = out
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&");
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[derive(Debug)]
pub enum FetchError {
    /// Too many requests: back off for a while.
    Limited,
    Failed(String),
}

pub fn fetch(agent: &ureq::Agent, base: &str, appid: &str) -> Result<Option<Metadata>, FetchError> {
    let mut resp = agent.get(&url(base, appid)).header("User-Agent", super::USER_AGENT).call().map_err(|e| FetchError::Failed(e.to_string()))?;
    match resp.status().as_u16() {
        200 => {}
        429 | 403 => return Err(FetchError::Limited),
        s => return Err(FetchError::Failed(format!("HTTP {s}"))),
    }
    let bytes = resp.body_mut().with_config().limit(8 * 1024 * 1024).read_to_vec().map_err(|e| FetchError::Failed(e.to_string()))?;
    // Steam answers `null` for some ids instead of `success: false`.
    let v: Value = serde_json::from_slice(&bytes).map_err(|e| FetchError::Failed(e.to_string()))?;
    if v.is_null() {
        return Ok(None);
    }
    parse(&v, appid).map_err(FetchError::Failed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn dates() {
        assert_eq!(parse_date("18 Nov, 2011").as_deref(), Some("2011-11-18"));
        assert_eq!(parse_date("Nov 18, 2011").as_deref(), Some("2011-11-18"));
        assert_eq!(parse_date("5 Sep, 2023").as_deref(), Some("2023-09-05"));
        assert_eq!(parse_date("November 2011").as_deref(), Some("2011-11"));
        assert_eq!(parse_date("Coming soon"), None);
        assert_eq!(parse_date("Q4 2026"), None);
    }

    #[test]
    fn parses_appdetails() {
        let v = json!({ "620": { "success": true, "data": {
            "developers": ["Valve"], "publishers": ["Valve", " "],
            "release_date": { "coming_soon": false, "date": "18 Apr, 2011" },
            "genres": [{ "id": "1", "description": "Action" }, { "id": "25", "description": "Adventure" }],
            "short_description": "Portal&nbsp;2 draws from the award-winning formula of <b>innovative</b> gameplay &amp; story."
        }}});
        let m = parse(&v, "620").unwrap().unwrap();
        assert_eq!(m.developer.as_deref(), Some("Valve"));
        assert_eq!(m.publisher.as_deref(), Some("Valve"));
        assert_eq!(m.release_date.as_deref(), Some("2011-04-18"));
        assert_eq!(m.genres, ["Action", "Adventure"]);
        assert_eq!(m.description.as_deref(), Some("Portal 2 draws from the award-winning formula of innovative gameplay & story."));
        assert_eq!(parse(&json!({ "1": { "success": false } }), "1").unwrap(), None);
        let soon = json!({ "2": { "success": true, "data": { "release_date": { "coming_soon": true, "date": "2027" } } } });
        assert_eq!(parse(&soon, "2").unwrap().unwrap().release_date, None);
    }

    #[test]
    fn provider_metadata_wins() {
        let p = Metadata { developer: Some("Local".into()), genres: vec!["RPG".into()], ..Default::default() };
        let f = Metadata { developer: Some("Store".into()), publisher: Some("Pub".into()), genres: vec!["Action".into()], description: Some("D".into()), ..Default::default() };
        let m = merge(&p, Some(&f));
        assert_eq!((m.developer.as_deref(), m.publisher.as_deref()), (Some("Local"), Some("Pub")));
        assert_eq!(m.genres, ["RPG"]);
        assert_eq!(m.description.as_deref(), Some("D"));
        assert_eq!(merge(&p, None), p);
    }

    #[test]
    fn refresh_timing() {
        let r = DetailsRecord { at: 0, metadata: None };
        assert!(due(None, 0, 30));
        assert!(!due(Some(&r), 29 * 86_400, 30));
        assert!(due(Some(&r), 30 * 86_400, 30));
        assert!(!due(Some(&r), 10_000 * 86_400, 0), "0 = never refresh");
    }
}
