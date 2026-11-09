//! GOG's own game details (`api.gog.com/v2/games/<id>`): developer, publisher, release date,
//! genres and the first paragraph of the description. Public and keyless, like Steam's store
//! API. Cached in `cache/metadata/gog.json` with the same record shape and timing as Steam's
//! (see details.rs), and the provider's own metadata still wins.
//!
//! Checked on 2026-11-08 against Beneath a Steel Sky (1207658695): `_embedded.developers[].name`,
//! `_embedded.publisher.name`, `_embedded.product.globalReleaseDate` (ISO with a time zone),
//! `_embedded.tags[].name` (what GOG's store shows as genres) and `overview` (HTML paragraphs).
//! An unknown id answers 404.

use serde_json::Value;

use super::details::{clean_text, FetchError};
use crate::providers::model::Metadata;

/// The store shows a handful of genres; GOG's tag lists can run long.
const MAX_GENRES: usize = 4;

pub fn api_base() -> String {
    std::env::var("VELLUM_GOG_API").unwrap_or_else(|_| "https://api.gog.com".to_string())
}

pub fn url(base: &str, id: &str) -> String {
    format!("{base}/v2/games/{id}?locale=en-US")
}

/// The first paragraph of GOG's description, as plain text.
fn first_paragraph(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let end = ["<br", "<p", "\n\n", "<hr", "<h"]
        .iter()
        .filter_map(|m| lower.find(m))
        .filter(|&i| !clean_text(&html[..i]).is_empty())
        .min()
        .unwrap_or(html.len());
    Some(clean_text(&html[..end])).filter(|s| !s.is_empty())
}

/// Parses a `v2/games` reply. `Ok(None)` means GOG answered but has nothing usable.
pub fn parse(v: &Value) -> Result<Option<Metadata>, String> {
    let Some(e) = v.get("_embedded") else { return Ok(None) };
    let names = |k: &str| {
        e.get(k)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|x| x.get("name").and_then(Value::as_str))
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect::<Vec<_>>()
    };
    let developers = names("developers");
    let genres: Vec<String> = names("tags").into_iter().take(MAX_GENRES).collect();
    let publisher = e.get("publisher").and_then(|p| p.get("name")).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    let release_date = e
        .get("product")
        .and_then(|p| p.get("globalReleaseDate"))
        .and_then(Value::as_str)
        .filter(|d| d.len() >= 10 && d.as_bytes()[4] == b'-' && d.as_bytes()[7] == b'-')
        .map(|d| d[..10].to_string());
    let description = v.get("overview").or_else(|| v.get("description")).and_then(Value::as_str).and_then(first_paragraph);
    let m = Metadata {
        developer: Some(developers.join(", ")).filter(|s| !s.is_empty()),
        publisher,
        release_date,
        genres,
        description,
    };
    Ok(Some(m))
}

pub fn fetch(agent: &ureq::Agent, base: &str, id: &str) -> Result<Option<Metadata>, FetchError> {
    let mut resp = agent
        .get(&url(base, id))
        .header("User-Agent", super::USER_AGENT)
        .call()
        .map_err(|e| FetchError::Failed(e.to_string()))?;
    match resp.status().as_u16() {
        200 => {}
        404 => return Ok(None),
        429 | 403 => return Err(FetchError::Limited),
        s => return Err(FetchError::Failed(format!("HTTP {s}"))),
    }
    let bytes = resp.body_mut().with_config().limit(8 * 1024 * 1024).read_to_vec().map_err(|e| FetchError::Failed(e.to_string()))?;
    let v: Value = serde_json::from_slice(&bytes).map_err(|e| FetchError::Failed(e.to_string()))?;
    parse(&v).map_err(FetchError::Failed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_a_game() {
        let v = json!({
            "overview": "Robert Foster is an innocent outsider &amp; more...\n<br><br>\nParanoid population.",
            "_embedded": {
                "product": { "title": "Beneath a Steel Sky (1994)", "globalReleaseDate": "1994-04-11T00:00:00+02:00" },
                "publisher": { "name": "Revolution Software" },
                "developers": [{ "name": "Revolution Software" }],
                "tags": [{ "name": "Sci-fi" }, { "name": "Adventure" }, { "name": "Point-and-click" }, { "name": "Classic" }, { "name": "Story Rich" }]
            }
        });
        let m = parse(&v).unwrap().unwrap();
        assert_eq!(m.developer.as_deref(), Some("Revolution Software"));
        assert_eq!(m.publisher.as_deref(), Some("Revolution Software"));
        assert_eq!(m.release_date.as_deref(), Some("1994-04-11"));
        assert_eq!(m.genres, ["Sci-fi", "Adventure", "Point-and-click", "Classic"]);
        assert_eq!(m.description.as_deref(), Some("Robert Foster is an innocent outsider & more..."));
    }

    #[test]
    fn a_reply_without_a_game_is_nothing() {
        assert_eq!(parse(&json!({ "error": "not found" })).unwrap(), None);
        let bare = parse(&json!({ "_embedded": { "product": { "globalReleaseDate": null } } })).unwrap().unwrap();
        assert_eq!(bare, Metadata::default());
    }

    #[test]
    fn a_description_without_breaks_is_kept_whole() {
        assert_eq!(first_paragraph("<p>One. Two.</p>").as_deref(), Some("One. Two."));
        assert_eq!(first_paragraph("<b>Bold</b> start<br>second").as_deref(), Some("Bold start"));
        assert_eq!(first_paragraph("   "), None);
    }
}
