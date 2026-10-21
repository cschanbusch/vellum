//! The shipped Steam provider, run in the real QuickJS host against tests/fixtures/steam.

mod common;

use common::*;
use serde_json::{json, Map, Value};
use vellum_lib::providers::host::Method;
use vellum_lib::providers::locations::FakeRegistry;
use vellum_lib::providers::model::{parse_scan, GameKind};

fn harness(fx: &SteamFixture, settings: Map<String, Value>) -> Harness {
    Harness::new(shipped_provider("steam", settings), &[("root", &fx.root)], FakeRegistry::default())
}

#[test]
fn scans_installed_games_across_libraries_with_collections() {
    let fx = steam_fixture();
    let mut h = harness(&fx, Map::new());
    let out = h.call(Method::Scan, None).unwrap();
    let scan = parse_scan(out.value).unwrap();
    assert!(scan.skipped.is_empty(), "{:?}", scan.skipped);

    let ids: Vec<&str> = scan.games.iter().map(|g| g.source_id.as_str()).collect();
    assert_eq!(ids, ["1003800", "228980", "620", "1493710", "2642680", "413150"], "uninstalled and corrupt manifests are excluded");
    let kinds: Vec<(&str, GameKind, Vec<String>)> = scan.games.iter().map(|g| (g.title.as_str(), g.kind, g.labels.clone())).collect();
    assert_eq!(
        kinds[..5],
        [
            ("Gang Beasts Soundtrack", GameKind::Other, vec!["Soundtrack".to_string()]),
            ("Steamworks Common Redistributables", GameKind::Tool, vec![]),
            ("Portal 2", GameKind::Game, vec![]),
            ("Proton Experimental", GameKind::Tool, vec![]),
            ("Half Sword Demo", GameKind::Game, vec!["Demo".to_string()]),
        ],
        "everything installed is reported; filters decide what is shown"
    );
    let soundtrack = &scan.games[0];
    assert!(soundtrack.install_dir.as_deref().unwrap().replace('\\', "/").ends_with("steamapps/music/Gang Beasts Soundtrack"));
    let scan = { let mut g = scan; g.games.retain(|x| x.kind == GameKind::Game && x.labels.is_empty()); g };

    let portal = &scan.games[0];
    assert_eq!(portal.source_id, "620");
    assert_eq!(portal.title, "Portal 2");
    assert_eq!(portal.kind, GameKind::Game);
    assert_eq!(portal.size_bytes, Some(12_000_000_000));
    assert_eq!(portal.launch_data, json!({ "appid": "620" }));
    // Playtime is the active account's (22222), not the other account's.
    assert_eq!(portal.playtime_minutes, Some(754));
    assert_eq!(portal.last_played.as_deref(), Some("2025-10-09T08:53:20.000Z"));
    let mut cats = portal.categories.clone();
    cats.sort();
    assert_eq!(cats, ["Co-op", "Steam favorites"], "deleted, dynamic and other-account collections are ignored");
    assert!(!portal.hidden);

    let stardew = &scan.games[1];
    assert!(stardew.hidden, "member of Steam's hidden collection");
    assert_eq!(stardew.categories, ["Co-op"]);
    let install = stardew.install_dir.as_deref().unwrap();
    assert!(install.ends_with("libB\\steamapps\\common\\Stardew Valley"), "{install}");

    // The second library became a derived location; the unplugged one did not.
    assert!(out.derived.iter().any(|d| d.ends_with("libB")), "{:?}", out.derived);
    assert!(!out.derived.iter().any(|d| d.ends_with("unplugged")));
    let logs: Vec<&str> = out.logs.iter().map(|l| l.message.as_str()).collect();
    assert!(logs.iter().any(|l| l.contains("dynamic collection(s): Dynamic: Puzzle")), "{logs:?}");
    assert!(logs.iter().any(|l| l.contains("library folder not available")), "{logs:?}");
    assert!(logs.iter().any(|l| l.contains("skipping unreadable manifest")), "{logs:?}");
}

#[test]
fn store_metadata_comes_from_appinfo() {
    let fx = steam_fixture();
    let mut h = harness(&fx, Map::new());
    let scan = parse_scan(h.call(Method::Scan, None).unwrap().value).unwrap();
    let portal = scan.games.iter().find(|g| g.source_id == "620").unwrap();
    assert_eq!(portal.metadata.developer.as_deref(), Some("Valve"));
    assert_eq!(portal.metadata.publisher.as_deref(), Some("Valve"));
    assert_eq!(portal.metadata.genres, ["Action", "Adventure"]);
    assert_eq!(portal.metadata.release_date.as_deref(), Some("2011-04-18"));
    let stardew = scan.games.iter().find(|g| g.source_id == "413150").unwrap();
    assert_eq!(stardew.metadata.genres, ["Indie", "RPG", "Simulation"], "Early Access is not a genre");
    assert_eq!(stardew.metadata.developer.as_deref(), Some("ConcernedApe"));
    // Apps missing from the cache have no metadata.
    let tools = scan.games.iter().find(|g| g.source_id == "228980").unwrap();
    assert!(tools.metadata.developer.is_none() && tools.metadata.genres.is_empty());
}

#[test]
fn respect_hidden_setting_can_be_turned_off() {
    let fx = steam_fixture();
    let mut settings = Map::new();
    settings.insert("respectHidden".into(), json!(false));
    let mut h = harness(&fx, settings);
    let scan = parse_scan(h.call(Method::Scan, None).unwrap().value).unwrap();
    assert!(scan.games.iter().all(|g| !g.hidden));
}

#[test]
fn chosen_account_overrides_most_recent() {
    let fx = steam_fixture();
    let mut settings = Map::new();
    settings.insert("account".into(), json!("11111"));
    let mut h = harness(&fx, settings);
    let scan = parse_scan(h.call(Method::Scan, None).unwrap().value).unwrap();
    let portal = scan.games.iter().find(|g| g.source_id == "620").unwrap();
    assert_eq!(portal.categories, ["Other account's collection"]);
}

#[test]
fn actions_open_steam_uris() {
    let fx = steam_fixture();
    let mut h = harness(&fx, Map::new());
    let game = json!({ "sourceId": "620", "title": "Portal 2", "launchData": { "appid": "620" } });
    for m in [Method::Launch, Method::Install, Method::Uninstall, Method::OpenStore] {
        h.call(m, Some(&game)).unwrap();
    }
    assert_eq!(
        h.opened(),
        ["uri steam://rungameid/620", "uri steam://install/620", "uri steam://uninstall/620", "uri steam://store/620"]
    );
}

#[test]
fn watch_lists_manifest_folders_collections_and_playtime() {
    let fx = steam_fixture();
    let mut h = harness(&fx, Map::new());
    let targets = h.call(Method::Watch, None).unwrap().value;
    let globs: Vec<&str> = targets.as_array().unwrap().iter().map(|t| t["glob"].as_str().unwrap()).collect();
    assert_eq!(globs, ["libraryfolders.vdf", "appmanifest_*.acf", "appmanifest_*.acf", "cloud-storage-namespace-1.json", "localconfig.vdf"]);
}

#[test]
fn login_files_stay_unreadable_even_inside_the_root() {
    // The denylist comes from the shipped manifest; a provider asking for these must fail.
    let fx = steam_fixture();
    let spec = shipped_provider("steam", Map::new());
    let scope = vellum_lib::providers::scope::Scope::new([fx.root.clone()], &spec.deny_files);
    for f in ["config/loginusers.vdf", "ssfn1234567890"] {
        let p = fx.root.join(f);
        assert!(scope.check(&p.to_string_lossy()).is_err(), "{f} must be denied");
    }
}

/// Art candidates, in priority order: custom grid art, Steam's nested per-app cache, the older
/// flat cache names, the low-resolution capsule, then CDN URLs (downloaded from Phase 4 on).
#[test]
fn art_candidates_follow_the_documented_order() {
    let fx = steam_fixture();
    let mut h = harness(&fx, Map::new());
    let scan = parse_scan(h.call(Method::Scan, None).unwrap().value).unwrap();
    let art = |h: &mut Harness, id: &str| -> Vec<(String, String)> {
        let game = serde_json::to_value(scan.games.iter().find(|g| g.source_id == id).unwrap()).unwrap();
        let out = h.call(Method::Art, Some(&game)).unwrap().value;
        out.as_array()
            .unwrap()
            .iter()
            .map(|c| {
                let kind = c["kind"].as_str().unwrap().to_string();
                let at = c["file"].as_str().or(c["url"].as_str()).unwrap().replace('\\', "/");
                (kind, at)
            })
            .collect()
    };
    let ends = |list: &[(String, String)]| -> Vec<String> {
        list.iter().map(|(k, at)| format!("{k}={}", at.rsplit('/').next().unwrap())).collect()
    };

    let portal = art(&mut h, "620");
    assert_eq!(
        ends(&portal),
        [
            "cover=620p.png",
            "hero=620_hero.jpg",
            "cover=library_600x900.jpg",
            "hero=library_hero.jpg",
            "logo=logo.png",
            "icon=0d3db87fafbdd4b67437dea28d104ec8f2a2b0a0.jpg",
            "cover=library_600x900_2x.jpg",
            "hero=library_hero.jpg",
            "logo=logo.png",
            "header=header.jpg",
        ]
    );
    assert!(portal[0].1.contains("/userdata/22222/config/grid/"), "the active account's grid folder");
    assert!(portal[6].1.starts_with("https://cdn.cloudflare.steamstatic.com/steam/apps/620/"));

    let stardew = art(&mut h, "413150");
    assert_eq!(
        &ends(&stardew)[..4],
        ["header=library_header.jpg", "cover=413150_library_600x900.jpg", "header=413150_header.jpg", "cover=library_capsule.jpg"]
    );
}
