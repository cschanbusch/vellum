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
    assert_eq!(ids, ["620", "413150"], "tools, uninstalled and corrupt manifests are excluded");

    let portal = &scan.games[0];
    assert_eq!(portal.title, "Portal 2");
    assert_eq!(portal.kind, GameKind::Game);
    assert_eq!(portal.size_bytes, Some(12_000_000_000));
    assert_eq!(portal.launch_data, json!({ "appid": "620" }));
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
fn settings_show_tools_and_ignore_hidden() {
    let fx = steam_fixture();
    let mut settings = Map::new();
    settings.insert("showTools".into(), json!(true));
    settings.insert("respectHidden".into(), json!(false));
    let mut h = harness(&fx, settings);
    let scan = parse_scan(h.call(Method::Scan, None).unwrap().value).unwrap();
    let tools: Vec<&str> = scan.games.iter().filter(|g| g.kind == GameKind::Tool).map(|g| g.title.as_str()).collect();
    assert_eq!(tools, ["Steamworks Common Redistributables", "Proton Experimental"]);
    assert!(scan.games.iter().all(|g| !g.hidden));
}

#[test]
fn chosen_account_overrides_most_recent() {
    let fx = steam_fixture();
    let mut settings = Map::new();
    settings.insert("account".into(), json!("11111"));
    let mut h = harness(&fx, settings);
    let scan = parse_scan(h.call(Method::Scan, None).unwrap().value).unwrap();
    assert_eq!(scan.games[0].categories, ["Other account's collection"]);
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
fn watch_lists_manifest_folders_and_collections() {
    let fx = steam_fixture();
    let mut h = harness(&fx, Map::new());
    let targets = h.call(Method::Watch, None).unwrap().value;
    let globs: Vec<&str> = targets.as_array().unwrap().iter().map(|t| t["glob"].as_str().unwrap()).collect();
    assert_eq!(globs, ["libraryfolders.vdf", "appmanifest_*.acf", "appmanifest_*.acf", "cloud-storage-namespace-1.json"]);
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
