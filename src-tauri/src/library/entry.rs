//! The `Entry` shape skins receive (spec: "Library model and user data").

use std::collections::BTreeMap;

use serde::Serialize;

use super::merge::Group;
use crate::art::{self, resolve::ArtSources};
use crate::net::details;
use crate::providers::model::{GameKind, Metadata};
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
    /// Id of the entry's oldest game record, e.g. `steam:620`.
    pub id: String,
    pub title: String,
    pub sort_title: String,
    pub kind: GameKind,
    pub sources: Vec<Source>,
    pub preferred_source: String,
    /// Play asks which store to use, rather than using `preferred_source`.
    pub ask_source: bool,
    pub categories: Vec<Category>,
    /// The store's labels for this game, such as "Demo" or "Soundtrack".
    pub labels: Vec<String>,
    pub tags: Vec<String>,
    pub favorite: bool,
    pub hidden: bool,
    pub last_launched: Option<String>,
    pub added_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    /// Store-reported minutes played and last session (see `ProviderGame`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub playtime_minutes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_played: Option<String>,
    pub metadata: Metadata,
    /// Art URLs on the skin's own origin, versioned so they can be cached as immutable.
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

/// The later of two ISO times, either of which may be missing.
fn latest(a: Option<String>, b: Option<&String>) -> Option<String> {
    match (a, b) {
        (Some(a), Some(b)) => Some(if b.as_str() > a.as_str() { b.clone() } else { a }),
        (a, b) => a.or_else(|| b.cloned()),
    }
}

impl Entry {
    /// One shown group as an entry: the preferred record speaks for it, and what the records
    /// know between them is combined. The group must have at least one active record.
    pub fn from_group(group: &Group, ud: &UserData, src: &dyn ArtSources) -> Entry {
        let g = group.preferred().expect("a shown group has a record").game;
        let provider = group.preferred().expect("a shown group has a record").provider;
        let id = group.id.clone();

        // What the user said, across every record, in preference order.
        let (mut favorite, mut hidden, mut notes) = (false, None, None);
        let (mut last_launched, mut first_seen): (Option<String>, Option<String>) = (None, None);
        let mut tags: Vec<String> = Vec::new();
        for user in group.all_ids().filter_map(|r| ud.games.get(r)) {
            favorite |= user.favorite;
            hidden = hidden.or(user.hidden);
            notes = notes.or_else(|| user.notes.clone().filter(|n| !n.is_empty()));
            last_launched = latest(last_launched, user.last_launched.as_ref());
            first_seen = match (first_seen, &user.first_seen) {
                (Some(a), Some(b)) => Some(if *b < a { b.clone() } else { a }),
                (a, b) => a.or_else(|| b.clone()),
            };
            for t in &user.tags {
                if !tags.iter().any(|x| x.eq_ignore_ascii_case(t)) {
                    tags.push(t.clone());
                }
            }
        }

        // What the stores said.
        let mut metadata: Option<Metadata> = None;
        let (mut playtime, mut last_played): (Option<u64>, Option<String>) = (None, None);
        let (mut sources, mut categories) = (Vec::with_capacity(group.records.len()), Vec::new());
        for r in &group.records {
            let own = details::merge(&r.game.metadata, src.details(&r.id).as_ref());
            metadata = Some(match metadata {
                Some(so_far) => details::merge(&so_far, Some(&own)),
                None => own,
            });
            playtime = match (playtime, r.game.playtime_minutes) {
                (Some(a), Some(b)) => Some(a + b),
                (a, b) => a.or(b),
            };
            last_played = latest(last_played, r.game.last_played.as_ref());
            sources.push(Source {
                provider: r.provider.to_string(),
                provider_name: r.recs.provider_name.clone(),
                game_id: r.id.clone(),
                capabilities: r.recs.capabilities.clone(),
                install_dir: r.game.install_dir.clone(),
            });
            categories.extend(r.game.categories.iter().map(|c| Category { provider: r.provider.to_string(), name: c.clone() }));
        }

        let mut labels = g.labels.clone();
        if group.marked {
            labels.push(group.preferred().expect("a shown group has a record").recs.provider_name.clone());
        }
        let cands = group.candidates();
        let overrides = group.overrides(ud);
        let resolved: Vec<_> = ART_KINDS.iter().map(|k| (*k, art::resolve::resolve(&id, k, &cands, Some(&overrides), src))).collect();
        Entry {
            title: g.title.clone(),
            sort_title: sort_title(&g.title),
            kind: g.kind,
            sources,
            preferred_source: provider.to_string(),
            ask_source: group.ask,
            categories,
            labels,
            tags,
            favorite,
            hidden: hidden.unwrap_or(g.hidden),
            last_launched,
            added_at: first_seen.unwrap_or_default(),
            size_bytes: g.size_bytes,
            playtime_minutes: playtime,
            last_played,
            metadata: metadata.unwrap_or_default(),
            art: resolved.iter().map(|(k, r)| (*k, art::url(&id, k, &art::version(r.candidate.as_ref(), &g.title)))).collect(),
            art_status: resolved.iter().map(|(k, r)| (*k, r.status())).collect(),
            notes,
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
