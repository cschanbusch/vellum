//! The shipped Epic provider, run in the real QuickJS host against tests/fixtures/epic.

mod common;

use common::*;
use serde_json::{json, Map};
use vellum_lib::providers::host::Method;
use vellum_lib::providers::locations::FakeRegistry;
use vellum_lib::providers::model::{parse_scan, GameKind};

fn harness() -> Harness {
    let manifests = repo("tests/fixtures/epic/Manifests");
    let catalog = repo("tests/fixtures/epic/Catalog");
    Harness::new(shipped_provider("epic", Map::new()), &[("manifests", &manifests), ("catalog", &catalog)], FakeRegistry::default())
}

#[test]
fn developer_comes_from_the_catalog_cache() {
    let mut h = harness();
    let scan = parse_scan(h.call(Method::Scan, None).unwrap().value).unwrap();
    let game = scan.games.iter().find(|g| g.source_id == "Fowl").unwrap();
    assert_eq!(game.metadata.developer.as_deref(), Some("Pöllö Studios"), "base64 and UTF-8 decoded");
    assert!(scan.games.iter().find(|g| g.source_id == "UE_5.4").unwrap().metadata.developer.is_none());

    // Without the cache, scanning still works.
    let manifests = repo("tests/fixtures/epic/Manifests");
    let mut h = Harness::new(shipped_provider("epic", Map::new()), &[("manifests", &manifests)], FakeRegistry::default());
    let scan = parse_scan(h.call(Method::Scan, None).unwrap().value).unwrap();
    assert!(scan.games.iter().all(|g| g.metadata.developer.is_none()));
}

#[test]
fn scans_games_marks_dlc_and_skips_incomplete_installs() {
    let mut h = harness();
    let out = h.call(Method::Scan, None).unwrap();
    let scan = parse_scan(out.value).unwrap();
    assert!(scan.skipped.is_empty(), "{:?}", scan.skipped);
    let mut got: Vec<(String, GameKind)> = scan.games.iter().map(|g| (g.title.clone(), g.kind)).collect();
    got.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(
        got,
        [
            ("Fowl Escape 2".to_string(), GameKind::Game),
            ("Fowl Escape 2 - Soundtrack Pack".to_string(), GameKind::Dlc),
            ("Unreal Engine".to_string(), GameKind::Other),
        ],
        "a base game with an empty MainGameAppName is a game; the incomplete install is left out"
    );
    let game = scan.games.iter().find(|g| g.source_id == "Fowl").unwrap();
    assert_eq!(game.size_bytes, Some(1_873_264_640));
    assert_eq!(game.install_dir.as_deref(), Some(r"C:\Program Files\Epic Games\FowlEscape2"));
    let logs: Vec<&str> = out.logs.iter().map(|l| l.message.as_str()).collect();
    assert!(logs.iter().any(|l| l.contains("skipping unreadable manifest")), "{logs:?}");
}

#[test]
fn launches_through_the_launcher_uri() {
    let mut h = harness();
    let scan = parse_scan(h.call(Method::Scan, None).unwrap().value).unwrap();
    let game = serde_json::to_value(scan.games.iter().find(|g| g.source_id == "Fowl").unwrap()).unwrap();
    h.call(Method::Launch, Some(&game)).unwrap();
    assert_eq!(
        h.opened(),
        ["uri com.epicgames.launcher://apps/115577f4ef1e4055aaf0da534fdfe81e%3A481004e1785e4a2eb98e63b11797aa9a%3AFowl?action=launch&silent=true"]
    );
}

#[test]
fn watches_the_manifests_folder() {
    let mut h = harness();
    let targets = h.call(Method::Watch, None).unwrap().value;
    assert_eq!(targets[0]["glob"], json!("*.item"));
    assert!(targets[0]["path"].as_str().unwrap().ends_with("Manifests"));
}
