//! The `Entry` shape skins receive (spec: "Library model and user data").

use std::collections::BTreeMap;

use serde::Serialize;

use super::{record_id, ProviderRecords};
use crate::providers::model::{GameKind, Metadata, ProviderGame};
use crate::userdata::games::UserData;

pub const ART_KINDS: [&str; 5] = ["cover", "hero", "logo", "header", "icon"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub provider: String,
    pub provider_name: String,
    /// `<provider>:<sourceId>`
    pub game_id: String,
    pub capabilities: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Category {
    pub provider: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// Id of the entry's primary game record, e.g. `steam:620`.
    pub id: String,
    pub title: String,
    pub sort_title: String,
    pub kind: GameKind,
    pub sources: Vec<Source>,
    pub preferred_source: String,
    pub categories: Vec<Category>,
    pub tags: Vec<String>,
    pub favorite: bool,
    pub hidden: bool,
    pub last_launched: Option<String>,
    pub added_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    pub metadata: Metadata,
    /// Art URLs on the skin's own origin; resolved and served from Phase 3 on.
    pub art: BTreeMap<&'static str, String>,
    pub art_status: BTreeMap<&'static str, &'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

/// Lower-cased title with a leading "The " or "A " moved to the end:
/// "The Witcher 3" sorts as "witcher 3, the".
pub fn sort_title(title: &str) -> String {
    let t = title.trim();
    for article in ["The ", "A ", "An "] {
        // `get` (not indexing): titles may start with multi-byte characters.
        if let (Some(head), Some(rest)) = (t.get(..article.len()), t.get(article.len()..)) {
            if !rest.is_empty() && head.eq_ignore_ascii_case(article) {
                return format!("{rest}, {}", article.trim()).to_lowercase();
            }
        }
    }
    t.to_lowercase()
}

impl Entry {
    pub fn single(provider: &str, recs: &ProviderRecords, g: &ProviderGame, ud: &UserData) -> Entry {
        let id = record_id(provider, &g.source_id);
        let user = ud.games.get(&id).cloned().unwrap_or_default();
        Entry {
            title: g.title.clone(),
            sort_title: sort_title(&g.title),
            kind: g.kind,
            sources: vec![Source {
                provider: provider.to_string(),
                provider_name: recs.provider_name.clone(),
                game_id: id.clone(),
                capabilities: recs.capabilities.clone(),
                install_dir: g.install_dir.clone(),
            }],
            preferred_source: provider.to_string(),
            categories: g.categories.iter().map(|c| Category { provider: provider.to_string(), name: c.clone() }).collect(),
            tags: user.tags,
            favorite: user.favorite,
            hidden: user.hidden.unwrap_or(g.hidden),
            last_launched: user.last_launched,
            added_at: user.first_seen.unwrap_or_default(),
            size_bytes: g.size_bytes,
            metadata: g.metadata.clone(),
            art: ART_KINDS.iter().map(|k| (*k, format!("/__vellum/art/{id}/{k}"))).collect(),
            art_status: ART_KINDS.iter().map(|k| (*k, "placeholder")).collect(),
            notes: user.notes,
            id,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sort_titles() {
        assert_eq!(sort_title("The Witcher 3"), "witcher 3, the");
        assert_eq!(sort_title("A Short Hike"), "short hike, a");
        assert_eq!(sort_title("An Untitled Story"), "untitled story, an");
        assert_eq!(sort_title("Theatrhythm"), "theatrhythm");
        assert_eq!(sort_title("A"), "a");
        assert_eq!(sort_title("  Hades "), "hades");
    }

    #[test]
    fn sort_titles_with_multibyte_starts_do_not_panic() {
        // Found on a real library: slicing 4 bytes cut a character in half.
        for t in ["Ōkami HD", "ゼルダの伝説", "Ä", "Tö", "Théa", "A\u{301}bc", "😀 Party"] {
            let _ = sort_title(t);
        }
        assert_eq!(sort_title("Ōkami HD"), "ōkami hd");
    }
}
