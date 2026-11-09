//! Which game records make up which entry (docs/decisions.md, "Phase 5").
//!
//! A title found on two stores is a *duplicate*. Vellum never joins duplicates on its own: the
//! user answers for each one (one entry through a chosen store, one entry that asks each time,
//! or separate entries marked with their store). Answers live in `userdata.json` as merge rules
//! plus the set of records already decided. Everything here is pure and rebuilt from those.

use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::{record_id, LibrarySnapshot, ProviderRecords};
use crate::art::ArtCandidate;
use crate::providers::model::{GameKind, ProviderGame};
use crate::userdata::games::{MergeMode, MergeRule, UserData};
use crate::userdata::settings::{LibrarySettings, OnDuplicate};

/// Case-folded, without ™ ® © or punctuation, whitespace collapsed. Words such as "Edition" stay:
/// a false match costs more than a missed one, and Merge with… covers the misses.
pub fn title_key(title: &str) -> String {
    let mut out = String::with_capacity(title.len());
    let mut gap = false;
    for c in title.chars().flat_map(char::to_lowercase) {
        if c.is_alphanumeric() {
            if gap && !out.is_empty() {
                out.push(' ');
            }
            gap = false;
            out.push(c);
        } else if c.is_whitespace() {
            gap = true;
        }
    }
    out
}

/// One game record with what it came from.
#[derive(Debug, Clone)]
pub struct Rec<'a> {
    pub provider: &'a str,
    pub recs: &'a ProviderRecords,
    pub game: &'a ProviderGame,
    pub id: String,
}

/// The records behind one entry.
#[derive(Debug)]
pub struct Group<'a> {
    /// The entry's id: its oldest active record, so changing store or adding a copy can't move it.
    pub id: String,
    /// Records of active providers, preferred first. Empty when the game isn't shown.
    pub records: Vec<Rec<'a>>,
    /// Records of disabled providers: not shown, but still written to and read from.
    pub inactive: Vec<String>,
    /// Play opens a store picker.
    pub ask: bool,
    /// Another entry holds a copy of this title, so this one shows its store's name.
    pub marked: bool,
}

impl<'a> Group<'a> {
    pub fn visible(&self) -> bool {
        !self.records.is_empty()
    }

    pub fn preferred(&self) -> Option<&Rec<'a>> {
        self.records.first()
    }

    /// Every record id, active or not: a change to the user's data goes to all of them.
    pub fn all_ids(&self) -> impl Iterator<Item = &str> {
        self.records.iter().map(|r| r.id.as_str()).chain(self.inactive.iter().map(String::as_str))
    }

    /// Art candidates of every source, preferred store first.
    pub fn candidates(&self) -> Cow<'a, [ArtCandidate]> {
        fn of<'b>(r: &Rec<'b>) -> &'b [ArtCandidate] {
            r.recs.art.get(&r.game.source_id).map(Vec::as_slice).unwrap_or(&[])
        }
        match self.records.as_slice() {
            [] => Cow::Borrowed(&[]),
            [one] => Cow::Borrowed(of(one)),
            many => Cow::Owned(many.iter().flat_map(|r| of(r).iter().cloned()).collect()),
        }
    }

    /// Art overrides for the entry: the first record in preference order that has one per kind.
    pub fn overrides(&self, ud: &UserData) -> Map<String, Value> {
        let mut out = Map::new();
        for id in self.all_ids() {
            for (kind, v) in ud.games.get(id).map(|g| &g.art_overrides).into_iter().flatten() {
                out.entry(kind.clone()).or_insert_with(|| v.clone());
            }
        }
        out
    }
}

/// Copies of one title on different stores, as indexes into the record list.
#[derive(Debug)]
struct DupSet {
    records: Vec<usize>,
}

#[derive(Debug)]
pub struct Groups<'a> {
    pub list: Vec<Group<'a>>,
    by_record: HashMap<String, usize>,
    all: Vec<Rec<'a>>,
    sets: Vec<DupSet>,
}

impl<'a> Groups<'a> {
    /// The group holding a record, whichever record id is asked for.
    pub fn of(&self, record: &str) -> Option<&Group<'a>> {
        self.by_record.get(record).map(|&i| &self.list[i])
    }

    /// The shown group holding a record.
    pub fn shown(&self, record: &str) -> Option<&Group<'a>> {
        self.of(record).filter(|g| g.visible())
    }
}

fn rank(lib: &LibrarySettings, provider: &str) -> usize {
    lib.provider_priority.iter().position(|p| p == provider).unwrap_or(lib.provider_priority.len())
}

/// Titles found on more than one provider, across every cached record, disabled providers' too.
/// A demo or soundtrack isn't the game, and two records from one provider can't be told apart
/// by title, so neither counts.
fn duplicate_sets(all: &[Rec]) -> Vec<DupSet> {
    let mut by_key: BTreeMap<String, BTreeMap<&str, Vec<usize>>> = BTreeMap::new();
    for (i, r) in all.iter().enumerate() {
        if r.game.kind != GameKind::Game || !r.game.labels.is_empty() {
            continue;
        }
        let key = title_key(&r.game.title);
        if !key.is_empty() {
            by_key.entry(key).or_default().entry(r.provider).or_default().push(i);
        }
    }
    by_key
        .into_values()
        .filter_map(|providers| {
            let records: Vec<usize> = providers.into_values().filter(|v| v.len() == 1).flatten().collect();
            (records.len() >= 2).then_some(DupSet { records })
        })
        .collect()
}

/// Builds every group. `active` says which providers' games are shown.
pub fn groups<'a>(snap: &'a LibrarySnapshot, ud: &UserData, lib: &LibrarySettings, active: &dyn Fn(&str) -> bool) -> Groups<'a> {
    let all: Vec<Rec<'a>> = snap
        .providers
        .iter()
        .flat_map(|(pid, recs)| recs.games.iter().map(move |game| Rec { provider: pid.as_str(), recs, game, id: record_id(pid, &game.source_id) }))
        .collect();
    let index: HashMap<&str, usize> = all.iter().enumerate().map(|(i, r)| (r.id.as_str(), i)).collect();
    let sets = duplicate_sets(&all);

    // Who belongs with whom: the user's rules first, then anything "merge by priority" adds.
    struct Member<'r> {
        records: Vec<usize>,
        rule: Option<&'r MergeRule>,
    }
    let mut owner: Vec<Option<usize>> = vec![None; all.len()];
    let mut members: Vec<Member> = Vec::new();
    for rule in &ud.merges {
        let mut records = Vec::new();
        for i in rule.records.iter().filter_map(|id| index.get(id.as_str()).copied()) {
            if owner[i].is_none() {
                owner[i] = Some(members.len());
                records.push(i);
            }
        }
        if !records.is_empty() {
            members.push(Member { records, rule: Some(rule) });
        }
    }
    if lib.on_duplicate == OnDuplicate::Merge {
        for set in &sets {
            let open: Vec<usize> = set.records.iter().copied().filter(|&i| owner[i].is_none() && !ud.decided.contains(&all[i].id)).collect();
            let target = set.records.iter().find_map(|&i| owner[i]);
            match target {
                Some(m) => {
                    for i in open {
                        owner[i] = Some(m);
                        members[m].records.push(i);
                    }
                }
                None if open.len() >= 2 => {
                    for &i in &open {
                        owner[i] = Some(members.len());
                    }
                    members.push(Member { records: open, rule: None });
                }
                None => {}
            }
        }
    }
    for i in 0..all.len() {
        if owner[i].is_none() {
            owner[i] = Some(members.len());
            members.push(Member { records: vec![i], rule: None });
        }
    }

    let mut list = Vec::with_capacity(members.len());
    let mut by_record = HashMap::with_capacity(all.len());
    for (m, member) in members.iter().enumerate() {
        let preferred = member.rule.and_then(|r| r.preferred.as_deref());
        let mut shown: Vec<&Rec> = member.records.iter().map(|&i| &all[i]).filter(|r| active(r.provider)).collect();
        shown.sort_by_key(|r| (Some(r.provider) != preferred, rank(lib, r.provider), r.id.clone()));
        let inactive: Vec<String> = member.records.iter().map(|&i| &all[i]).filter(|r| !active(r.provider)).map(|r| r.id.clone()).collect();

        let seen = |id: &str| ud.games.get(id).and_then(|g| g.first_seen.as_deref());
        // `None` (never recorded) sorts last, so an unknown age can't take over an entry's id.
        let oldest = |ids: &mut dyn Iterator<Item = &str>| ids.min_by_key(|id| (seen(id).is_none(), seen(id).map(str::to_string), id.to_string())).map(str::to_string);
        let id = if shown.is_empty() {
            oldest(&mut inactive.iter().map(String::as_str))
        } else {
            oldest(&mut shown.iter().map(|r| r.id.as_str()))
        }
        .unwrap_or_default();

        let ask = shown.len() >= 2 && member.rule.is_some_and(|r| r.mode == MergeMode::Ask);
        for &i in &member.records {
            by_record.insert(all[i].id.clone(), m);
        }
        list.push(Group { id, records: shown.into_iter().cloned().collect(), inactive, ask, marked: false });
    }

    // A copy shown in another entry: both entries say which store they are.
    for set in &sets {
        let shown: BTreeSet<usize> = set.records.iter().filter(|&&i| active(all[i].provider)).filter_map(|&i| owner[i]).collect();
        if shown.len() >= 2 {
            for m in shown {
                list[m].marked = true;
            }
        }
    }
    Groups { list, by_record, all, sets }
}

/// How a duplicate is listed now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChoiceMode {
    /// One entry; Play uses `preferred`.
    One,
    /// One entry; Play asks.
    Ask,
    /// One entry per store.
    Separate,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateCopy {
    pub record: String,
    pub provider: String,
    pub provider_name: String,
    pub title: String,
}

/// One row of the duplicates dialog.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateView {
    pub title: String,
    /// Active copies, in store priority order.
    pub copies: Vec<DuplicateCopy>,
    /// A copy nobody has answered for yet.
    pub pending: bool,
    /// How it's listed today; `None` when only some copies share an entry.
    pub current: Option<ChoiceMode>,
    /// The store Play uses, or the one to preselect.
    pub preferred: String,
    /// A copy's provider asks for separate entries to be preselected (set by the command).
    pub suggest_separate: bool,
}

/// The duplicates the user can answer for: every title with copies on two active providers.
pub fn duplicates(g: &Groups, ud: &UserData, lib: &LibrarySettings, active: &dyn Fn(&str) -> bool) -> Vec<DuplicateView> {
    let mut out = Vec::new();
    for set in &g.sets {
        let mut recs: Vec<&Rec> = set.records.iter().map(|&i| &g.all[i]).filter(|r| active(r.provider)).collect();
        if recs.len() < 2 {
            continue;
        }
        recs.sort_by_key(|r| (rank(lib, r.provider), r.id.clone()));
        let owners: BTreeSet<usize> = recs.iter().filter_map(|r| g.by_record.get(&r.id).copied()).collect();
        let together = owners.len() == 1;
        let group = together.then(|| owners.first().map(|&m| &g.list[m])).flatten();
        let current = match group {
            Some(gr) if gr.ask => Some(ChoiceMode::Ask),
            Some(_) => Some(ChoiceMode::One),
            None if owners.len() == recs.len() => Some(ChoiceMode::Separate),
            None => None,
        };
        let preferred = group.and_then(|gr| gr.preferred()).unwrap_or(recs[0]).provider.to_string();
        out.push(DuplicateView {
            title: recs[0].game.title.clone(),
            pending: recs.iter().any(|r| !ud.decided.contains(&r.id)),
            copies: recs
                .iter()
                .map(|r| DuplicateCopy { record: r.id.clone(), provider: r.provider.to_string(), provider_name: r.recs.provider_name.clone(), title: r.game.title.clone() })
                .collect(),
            current,
            preferred,
            suggest_separate: false,
        });
    }
    out
}

/// Records one answer: these records become one entry, or separate ones, and count as decided.
pub fn apply_choice(ud: &mut UserData, records: &[String], mode: ChoiceMode, preferred: Option<&str>) {
    for rule in &mut ud.merges {
        rule.records.retain(|r| !records.contains(r));
    }
    ud.merges.retain(|r| r.records.len() >= 2);
    let merge_mode = match mode {
        ChoiceMode::One => Some(MergeMode::One),
        ChoiceMode::Ask => Some(MergeMode::Ask),
        ChoiceMode::Separate => None,
    };
    if let Some(mode) = merge_mode.filter(|_| records.len() >= 2) {
        ud.merges.push(MergeRule { records: records.to_vec(), mode, preferred: preferred.map(str::to_string) });
    }
    ud.decided.extend(records.iter().cloned());
}

/// Takes one copy out of its entry; the others stay together as they were.
pub fn separate(ud: &mut UserData, group: &[String], record: &str, mode: ChoiceMode, preferred: Option<&str>) {
    let rest: Vec<String> = group.iter().filter(|r| r.as_str() != record).cloned().collect();
    let provider = record.split_once(':').map(|(p, _)| p);
    apply_choice(ud, &rest, mode, preferred.filter(|p| Some(*p) != provider));
    apply_choice(ud, &[record.to_string()], ChoiceMode::Separate, None);
}

/// Records can share an entry only if each comes from a different store: Play via… picks by store.
pub fn distinct_providers(records: &[String]) -> bool {
    let providers: Vec<&str> = records.iter().filter_map(|r| r.split_once(':').map(|(p, _)| p)).collect();
    providers.iter().collect::<BTreeSet<_>>().len() == records.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::model::parse_scan;
    use crate::userdata::games::GameUserData;
    use serde_json::json;

    fn provider(name: &str, games: Value) -> ProviderRecords {
        ProviderRecords { provider_name: name.into(), games: parse_scan(json!({ "games": games })).unwrap().games, ..Default::default() }
    }

    /// Hades on Steam, GOG and Custom, plus games that must not count.
    fn snap() -> LibrarySnapshot {
        let mut s = LibrarySnapshot::default();
        s.providers.insert(
            "steam".into(),
            provider(
                "Steam",
                json!([
                    { "sourceId": "1", "title": "Hades" },
                    { "sourceId": "2", "title": "Portal" },
                    { "sourceId": "3", "title": "Tunic", "labels": ["Demo"] },
                    { "sourceId": "4", "title": "Twin" },
                    { "sourceId": "5", "title": "Twin" },
                    { "sourceId": "6", "title": "Celeste", "kind": "other" },
                ]),
            ),
        );
        s.providers.insert(
            "gog".into(),
            provider(
                "GOG",
                json!([
                    { "sourceId": "10", "title": "HADES™" },
                    { "sourceId": "11", "title": "Tunic" },
                    { "sourceId": "12", "title": "Twin" },
                    { "sourceId": "13", "title": "Celeste" },
                ]),
            ),
        );
        s.providers.insert("custom".into(), provider("Custom games", json!([{ "sourceId": "c", "title": "Hades" }])));
        s
    }

    fn lib() -> LibrarySettings {
        LibrarySettings::default()
    }

    fn ud() -> UserData {
        UserData::default()
    }

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn views(s: &LibrarySnapshot, u: &UserData) -> Vec<DuplicateView> {
        let g = groups(s, u, &lib(), &|_| true);
        duplicates(&g, u, &lib(), &|_| true)
    }

    #[test]
    fn title_keys() {
        assert_eq!(title_key("The Witcher® 3:  Wild Hunt™"), "the witcher 3 wild hunt");
        assert_eq!(title_key("  HADES ©"), "hades");
        assert_ne!(title_key("Skyrim"), title_key("Skyrim Special Edition"), "words stay");
        assert_ne!(title_key("Half-Life 2"), title_key("Half Life 2"), "a miss, on purpose");
        assert_eq!(title_key("ゼルダの伝説"), "ゼルダの伝説");
        assert_eq!(title_key("™ ® !"), "", "nothing left means nothing to match");
    }

    #[test]
    fn only_real_copies_on_different_stores_are_duplicates() {
        let v = views(&snap(), &ud());
        assert_eq!(v.len(), 1, "demo, non-game and same-store titles don't count: {v:?}");
        assert_eq!(v[0].copies.iter().map(|c| c.record.as_str()).collect::<Vec<_>>(), ["steam:1", "gog:10", "custom:c"], "in store priority order");
        assert!(v[0].pending);
        assert_eq!((v[0].current, v[0].preferred.as_str()), (Some(ChoiceMode::Separate), "steam"));
    }

    #[test]
    fn nothing_merges_before_the_user_answers_and_both_copies_are_marked() {
        let s = snap();
        let g = groups(&s, &ud(), &lib(), &|_| true);
        let hades = |id: &str| g.of(id).unwrap();
        assert_eq!(hades("steam:1").records.len(), 1);
        assert!(hades("steam:1").marked && hades("gog:10").marked && hades("custom:c").marked);
        assert!(!hades("steam:2").marked, "Portal has no copy elsewhere");
    }

    #[test]
    fn always_via_one_store() {
        let s = snap();
        let mut u = ud();
        apply_choice(&mut u, &ids(&["steam:1", "gog:10", "custom:c"]), ChoiceMode::One, Some("gog"));
        let g = groups(&s, &u, &lib(), &|_| true);
        let e = g.of("custom:c").unwrap();
        assert_eq!(e.records.iter().map(|r| r.provider).collect::<Vec<_>>(), ["gog", "steam", "custom"]);
        assert!(!e.ask && !e.marked);
        let v = duplicates(&g, &u, &lib(), &|_| true);
        assert_eq!((v[0].current, v[0].preferred.as_str(), v[0].pending), (Some(ChoiceMode::One), "gog", false));
    }

    #[test]
    fn ask_each_time_is_one_entry_that_asks() {
        let s = snap();
        let mut u = ud();
        apply_choice(&mut u, &ids(&["steam:1", "gog:10", "custom:c"]), ChoiceMode::Ask, None);
        let g = groups(&s, &u, &lib(), &|_| true);
        assert!(g.of("steam:1").unwrap().ask);
        // With only one store left there's nothing to ask.
        let g = groups(&s, &u, &lib(), &|p| p == "gog");
        assert!(!g.of("gog:10").unwrap().ask);
    }

    #[test]
    fn list_separately_keeps_them_apart_and_marked_without_asking_again() {
        let s = snap();
        let mut u = ud();
        apply_choice(&mut u, &ids(&["steam:1", "gog:10", "custom:c"]), ChoiceMode::Separate, None);
        let g = groups(&s, &u, &lib(), &|_| true);
        assert_eq!(g.of("steam:1").unwrap().records.len(), 1);
        assert!(g.of("steam:1").unwrap().marked);
        assert!(!duplicates(&g, &u, &lib(), &|_| true)[0].pending);
    }

    #[test]
    fn a_new_copy_asks_again_but_a_reinstall_does_not() {
        let mut s = snap();
        let custom = s.providers.remove("custom").unwrap();
        let mut u = ud();
        apply_choice(&mut u, &ids(&["steam:1", "gog:10"]), ChoiceMode::One, Some("steam"));
        assert!(!views(&s, &u)[0].pending);

        s.providers.insert("custom".into(), custom.clone());
        let v = views(&s, &u);
        assert!(v[0].pending, "a third store's copy");
        assert_eq!(v[0].current, None, "two copies share an entry and one doesn't");

        apply_choice(&mut u, &ids(&["steam:1", "gog:10", "custom:c"]), ChoiceMode::One, Some("steam"));
        s.providers.remove("custom");
        s.providers.insert("custom".into(), custom);
        assert!(!views(&s, &u)[0].pending, "reinstalled, already decided");
    }

    #[test]
    fn the_id_is_the_oldest_record_whatever_the_preferred_store() {
        let s = snap();
        let mut u = ud();
        u.games.insert("gog:10".into(), GameUserData { first_seen: Some("2026-01-01T00:00:00Z".into()), ..Default::default() });
        u.games.insert("steam:1".into(), GameUserData { first_seen: Some("2026-06-01T00:00:00Z".into()), ..Default::default() });
        apply_choice(&mut u, &ids(&["steam:1", "gog:10"]), ChoiceMode::One, Some("steam"));
        assert_eq!(groups(&s, &u, &lib(), &|_| true).of("steam:1").unwrap().id, "gog:10");

        apply_choice(&mut u, &ids(&["steam:1", "gog:10"]), ChoiceMode::One, Some("gog"));
        assert_eq!(groups(&s, &u, &lib(), &|_| true).of("steam:1").unwrap().id, "gog:10", "changing store doesn't move it");

        apply_choice(&mut u, &ids(&["steam:1", "gog:10", "custom:c"]), ChoiceMode::One, Some("gog"));
        assert_eq!(groups(&s, &u, &lib(), &|_| true).of("custom:c").unwrap().id, "gog:10", "nor does adding a copy");

        let g = groups(&s, &u, &lib(), &|p| p != "gog");
        let e = g.of("steam:1").unwrap();
        assert_eq!(e.id, "steam:1", "the store behind the id is off: the next oldest stands in");
        assert_eq!(e.inactive, ["gog:10"]);
        assert_eq!(groups(&s, &u, &lib(), &|_| true).of("steam:1").unwrap().id, "gog:10", "and it comes back");
    }

    #[test]
    fn disabled_providers_stay_in_the_group_but_hide_their_games() {
        let s = snap();
        let mut u = ud();
        apply_choice(&mut u, &ids(&["steam:1", "gog:10"]), ChoiceMode::One, None);
        let g = groups(&s, &u, &lib(), &|p| p != "steam");
        let e = g.of("gog:10").unwrap();
        assert_eq!(e.records.len(), 1);
        assert_eq!(e.all_ids().count(), 2, "writes still reach the hidden copy");
        let all_off = groups(&s, &u, &lib(), &|_| false);
        assert!(!all_off.of("gog:10").unwrap().visible() && all_off.shown("gog:10").is_none());
    }

    #[test]
    fn the_setting_can_merge_or_separate_without_asking() {
        let s = snap();
        let u = ud();
        let merge = LibrarySettings { on_duplicate: OnDuplicate::Merge, ..lib() };
        let g = groups(&s, &u, &merge, &|_| true);
        let e = g.of("custom:c").unwrap();
        assert_eq!(e.records.iter().map(|r| r.provider).collect::<Vec<_>>(), ["steam", "gog", "custom"], "by store priority");

        // A copy the user separated stays out.
        let mut u = ud();
        apply_choice(&mut u, &ids(&["custom:c"]), ChoiceMode::Separate, None);
        let g = groups(&s, &u, &merge, &|_| true);
        assert_eq!(g.of("steam:1").unwrap().records.len(), 2);
        assert_eq!(g.of("custom:c").unwrap().records.len(), 1);
    }

    #[test]
    fn separating_one_of_three_makes_two_entries() {
        let s = snap();
        let mut u = ud();
        let all = ids(&["steam:1", "gog:10", "custom:c"]);
        apply_choice(&mut u, &all, ChoiceMode::Ask, None);
        separate(&mut u, &all, "custom:c", ChoiceMode::Ask, None);
        let g = groups(&s, &u, &lib(), &|_| true);
        assert_eq!(g.of("steam:1").unwrap().records.len(), 2);
        assert!(g.of("steam:1").unwrap().ask, "the rest keep their choice");
        assert_eq!(g.of("custom:c").unwrap().records.len(), 1);
        assert!(g.of("custom:c").unwrap().marked && g.of("steam:1").unwrap().marked);

        // Separating one of the last two dissolves the rule; the preferred store can't be the one that left.
        separate(&mut u, &ids(&["steam:1", "gog:10"]), "gog:10", ChoiceMode::One, Some("gog"));
        assert!(u.merges.is_empty());
    }

    #[test]
    fn manual_rules_join_any_titles_and_only_one_copy_per_store() {
        let s = snap();
        let mut u = ud();
        apply_choice(&mut u, &ids(&["steam:2", "gog:13"]), ChoiceMode::One, None);
        assert_eq!(groups(&s, &u, &lib(), &|_| true).of("gog:13").unwrap().id, "gog:13", "no ages: ties go by id");
        assert!(distinct_providers(&ids(&["steam:2", "gog:13"])));
        assert!(!distinct_providers(&ids(&["steam:2", "steam:1"])));
    }

    #[test]
    #[ignore = "timing, run by hand with --nocapture"]
    fn timing_for_a_large_library() {
        let games: Vec<Value> = (0..5000).map(|i| json!({ "sourceId": i.to_string(), "title": format!("Some Game Title® {i}") })).collect();
        let mut s = LibrarySnapshot::default();
        s.providers.insert("steam".into(), provider("Steam", json!(games)));
        s.providers.insert("gog".into(), provider("GOG", json!(games)));
        let u = ud();
        let t = std::time::Instant::now();
        let g = groups(&s, &u, &lib(), &|_| true);
        println!("{} groups from 10000 records in {:?}", g.list.len(), t.elapsed());
    }
}
