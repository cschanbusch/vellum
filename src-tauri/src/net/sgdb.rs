//! SteamGridDB (https://www.steamgriddb.com/api/v2), used only with the user's own API key.
//! An entry with a Steam source is looked up by appid; any other by its title (the first
//! autocomplete match). Results per entry and kind are kept in `cache/metadata/steamgriddb.json`:
//! the best images first, so the resolver can fall back to the next when one fails to download.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const SCHEMA_VERSION: u32 = 1;
/// How many results per kind are kept for the Change art dialog.
pub const KEEP: usize = 30;

pub fn api_base() -> String {
    std::env::var("VELLUM_SGDB_API").unwrap_or_else(|_| "https://www.steamgriddb.com/api/v2".to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SgdbIndex {
    pub schema_version: u32,
    /// By entry id.
    pub entries: BTreeMap<String, SgdbEntry>,
}

impl Default for SgdbIndex {
    fn default() -> Self {
        SgdbIndex { schema_version: SCHEMA_VERSION, entries: BTreeMap::new() }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SgdbEntry {
    /// SteamGridDB's game id, once known (title lookups only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub game_id: Option<u64>,
    pub kinds: BTreeMap<String, SgdbKind>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SgdbKind {
    /// Unix seconds of the lookup.
    pub at: u64,
    pub images: Vec<SgdbImage>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SgdbImage {
    pub url: String,
    pub thumb: String,
    pub width: u32,
    pub height: u32,
    pub score: i64,
}

pub fn load(_path: &Path, bytes: Option<Vec<u8>>) -> SgdbIndex {
    bytes
        .and_then(|b| serde_json::from_slice::<SgdbIndex>(&b).ok())
        .filter(|s| s.schema_version == SCHEMA_VERSION)
        .unwrap_or_default()
}

/// The endpoint and filters for one art kind. Dimensions follow Steam's library sizes.
pub fn endpoint(kind: &str) -> Option<(&'static str, &'static str)> {
    Some(match kind {
        "cover" => ("grids", "dimensions=600x900,342x482,660x930"),
        "header" => ("grids", "dimensions=920x430,460x215"),
        "hero" => ("heroes", "dimensions=3840x1240,1920x620,1600x650"),
        "logo" => ("logos", ""),
        "icon" => ("icons", ""),
        _ => return None,
    })
}

/// How Vellum names the game to SteamGridDB.
#[derive(Debug, Clone, PartialEq)]
pub enum Target {
    Steam(String),
    Game(u64),
}

pub fn images_url(base: &str, kind: &str, target: &Target) -> Option<String> {
    let (path, dims) = endpoint(kind)?;
    let (platform, id) = match target {
        Target::Steam(a) => ("steam", a.clone()),
        Target::Game(g) => ("game", g.to_string()),
    };
    let mut q = String::from("nsfw=false&humor=false&epilepsy=false");
    if kind != "logo" && kind != "icon" {
        q.push_str("&types=static");
    }
    if !dims.is_empty() {
        q.push('&');
        q.push_str(dims);
    }
    Some(format!("{base}/{path}/{platform}/{id}?{q}"))
}

pub fn search_url(base: &str, title: &str) -> String {
    format!("{base}/search/autocomplete/{}", crate::art::encode_segment(title).replace(':', "%3A"))
}

/// `{ success, data: [...] }` → the images, best first: highest score, then largest.
pub fn parse_images(v: &Value) -> Vec<SgdbImage> {
    let mut out: Vec<SgdbImage> = v
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|i| !i.get("nsfw").and_then(Value::as_bool).unwrap_or(false) && !i.get("humor").and_then(Value::as_bool).unwrap_or(false))
        .filter_map(|i| {
            let url = i.get("url")?.as_str()?;
            if !url.starts_with("https://") {
                return None;
            }
            Some(SgdbImage {
                url: url.to_string(),
                thumb: i.get("thumb").and_then(Value::as_str).unwrap_or(url).to_string(),
                width: i.get("width").and_then(Value::as_u64).unwrap_or(0) as u32,
                height: i.get("height").and_then(Value::as_u64).unwrap_or(0) as u32,
                score: i.get("score").and_then(Value::as_i64).unwrap_or(0),
            })
        })
        .collect();
    out.sort_by(|a, b| b.score.cmp(&a.score).then((b.width as u64 * b.height as u64).cmp(&(a.width as u64 * a.height as u64))));
    out.truncate(KEEP);
    out
}

/// The first autocomplete result's game id.
pub fn parse_search(v: &Value) -> Option<u64> {
    v.get("data")?.as_array()?.first()?.get("id")?.as_u64()
}

#[derive(Debug)]
pub enum LookupError {
    /// The key was refused: stop using SteamGridDB until it is changed.
    BadKey,
    /// The game isn't on SteamGridDB (a definite answer, cached like an empty result).
    NotFound,
    /// Network trouble: try again later.
    Failed(String),
}

fn get_json(agent: &ureq::Agent, url: &str, key: &str) -> Result<Value, LookupError> {
    let mut resp = agent
        .get(url)
        .header("User-Agent", super::USER_AGENT)
        .header("Authorization", format!("Bearer {key}"))
        .call()
        .map_err(|e| LookupError::Failed(e.to_string()))?;
    match resp.status().as_u16() {
        200 => {}
        401 | 403 => return Err(LookupError::BadKey),
        404 => return Err(LookupError::NotFound),
        s => return Err(LookupError::Failed(format!("HTTP {s}"))),
    }
    let bytes = resp.body_mut().with_config().limit(4 * 1024 * 1024).read_to_vec().map_err(|e| LookupError::Failed(e.to_string()))?;
    serde_json::from_slice(&bytes).map_err(|e| LookupError::Failed(e.to_string()))
}

/// Finds the game id for a title; `None` when SteamGridDB has no match.
pub fn search(agent: &ureq::Agent, base: &str, key: &str, title: &str) -> Result<Option<u64>, LookupError> {
    match get_json(agent, &search_url(base, title), key) {
        Ok(v) => Ok(parse_search(&v)),
        Err(LookupError::NotFound) => Ok(None),
        Err(e) => Err(e),
    }
}

pub fn images(agent: &ureq::Agent, base: &str, key: &str, kind: &str, target: &Target) -> Result<Vec<SgdbImage>, LookupError> {
    let url = images_url(base, kind, target).ok_or_else(|| LookupError::Failed(format!("unknown kind {kind}")))?;
    match get_json(agent, &url, key) {
        Ok(v) => Ok(parse_images(&v)),
        Err(LookupError::NotFound) => Ok(Vec::new()),
        Err(e) => Err(e),
    }
}

/// Checks a key by asking for something every key may read.
pub fn check_key(agent: &ureq::Agent, base: &str, key: &str) -> Result<(), String> {
    match search(agent, base, key, "portal") {
        Ok(_) => Ok(()),
        Err(LookupError::BadKey) => Err("SteamGridDB didn't accept that key.".into()),
        Err(LookupError::NotFound) => Ok(()),
        Err(LookupError::Failed(e)) => Err(format!("Couldn't reach SteamGridDB to check the key: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::testserver::serve;
    use serde_json::json;

    #[test]
    fn urls_carry_the_right_filters() {
        let u = images_url("B", "cover", &Target::Steam("620".into())).unwrap();
        assert_eq!(u, "B/grids/steam/620?nsfw=false&humor=false&epilepsy=false&types=static&dimensions=600x900,342x482,660x930");
        let u = images_url("B", "logo", &Target::Game(42)).unwrap();
        assert_eq!(u, "B/logos/game/42?nsfw=false&humor=false&epilepsy=false");
        assert!(images_url("B", "poster", &Target::Game(1)).is_none());
        assert_eq!(search_url("B", "Half-Life: Alyx"), "B/search/autocomplete/Half-Life%3A%20Alyx");
        assert_eq!(search_url("B", "a/b"), "B/search/autocomplete/a%2Fb");
    }

    #[test]
    fn images_sort_by_score_then_size_and_drop_unsafe() {
        let v = json!({ "success": true, "data": [
            { "url": "https://cdn2.steamgriddb.com/a.png", "thumb": "https://cdn2.steamgriddb.com/t/a.png", "width": 600, "height": 900, "score": 1 },
            { "url": "https://cdn2.steamgriddb.com/b.png", "width": 600, "height": 900, "score": 5 },
            { "url": "https://cdn2.steamgriddb.com/c.png", "width": 1200, "height": 1800, "score": 5 },
            { "url": "https://cdn2.steamgriddb.com/n.png", "width": 600, "height": 900, "score": 9, "nsfw": true },
            { "url": "http://insecure/x.png", "score": 9 }
        ]});
        let imgs = parse_images(&v);
        let urls: Vec<&str> = imgs.iter().map(|i| i.url.rsplit('/').next().unwrap()).collect();
        assert_eq!(urls, ["c.png", "b.png", "a.png"]);
        assert_eq!(imgs[1].thumb, imgs[1].url, "thumb defaults to the image");
        assert_eq!(parse_search(&json!({ "data": [{ "id": 7 }, { "id": 8 }] })), Some(7));
        assert_eq!(parse_search(&json!({ "data": [] })), None);
    }

    #[test]
    fn talks_to_the_api() {
        let base = serve(vec![
            ("/search/autocomplete/Celeste", 200, br#"{"success":true,"data":[{"id":99,"name":"Celeste"}]}"#.to_vec()),
            ("/heroes/game/99", 200, br#"{"success":true,"data":[{"url":"https://cdn2.steamgriddb.com/h.png","width":1920,"height":620,"score":3}]}"#.to_vec()),
            ("/grids/steam/1", 404, br#"{"success":false}"#.to_vec()),
            ("/search/autocomplete/portal", 401, b"{}".to_vec()),
        ]);
        let agent = crate::net::agent();
        assert_eq!(search(&agent, &base, "k", "Celeste").unwrap(), Some(99));
        let h = images(&agent, &base, "k", "hero", &Target::Game(99)).unwrap();
        assert_eq!(h[0].width, 1920);
        assert!(images(&agent, &base, "k", "cover", &Target::Steam("1".into())).unwrap().is_empty());
        assert!(check_key(&agent, &base, "bad").unwrap_err().contains("accept"));
    }
}
