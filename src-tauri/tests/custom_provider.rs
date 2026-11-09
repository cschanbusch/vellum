//! The shipped custom-games provider, run in the real QuickJS host.

mod common;

use common::*;
use serde_json::{json, Map, Value};
use vellum_lib::providers::host::Method;
use vellum_lib::providers::locations::FakeRegistry;
use vellum_lib::providers::model::{parse_scan, ProviderGame};

fn harness(games: Value) -> Harness {
    let mut settings = Map::new();
    settings.insert("games".into(), games);
    Harness::new(shipped_provider("custom", settings), &[], FakeRegistry::default())
}

fn scan(h: &mut Harness) -> Vec<ProviderGame> {
    let s = parse_scan(h.call(Method::Scan, None).unwrap().value).unwrap();
    assert!(s.skipped.is_empty(), "{:?}", s.skipped);
    s.games
}

#[test]
fn no_saved_games_is_an_empty_library() {
    let mut h = Harness::new(shipped_provider("custom", Map::new()), &[], FakeRegistry::default());
    assert!(scan(&mut h).is_empty());
}

#[test]
fn lists_saved_games_and_marks_missing_files() {
    let dir = tempfile::tempdir().unwrap();
    let exe = dir.path().join("game.exe");
    std::fs::write(&exe, b"x").unwrap();
    let mut h = harness(json!([
        { "id": "a", "title": "Present", "exe": exe },
        { "id": "b", "title": "Gone", "exe": dir.path().join("gone.exe") },
        { "id": "c", "title": "No exe" },
    ]));
    let games = scan(&mut h);
    assert_eq!(games.len(), 2, "an incomplete record is left out");
    assert!(games[0].labels.is_empty());
    assert_eq!(games[0].install_dir.as_deref(), Some(dir.path().to_str().unwrap()));
    assert_eq!(games[1].labels, ["Missing"]);
}

#[test]
fn launch_splits_quoted_arguments_and_only_runs_the_saved_file() {
    let dir = tempfile::tempdir().unwrap();
    let exe = dir.path().join("emu.exe");
    std::fs::write(&exe, b"x").unwrap();
    let mut h = harness(json!([{ "id": "a", "title": "Emu", "exe": exe, "args": r#"-c "..\my games\x.ini"  beneath "" "# }]));
    let game = serde_json::to_value(&scan(&mut h)[0]).unwrap();
    h.call(Method::Launch, Some(&game)).unwrap();
    assert_eq!(h.opened(), [format!(r"run {} -c ..\my games\x.ini beneath ", exe.display())], "an empty quoted argument is kept");

    // A record pointing outside its own install folder is refused by the host's scope check.
    let elsewhere = tempfile::tempdir().unwrap();
    let mut bad = game.clone();
    bad["installDir"] = json!(elsewhere.path());
    assert!(h.call(Method::Launch, Some(&bad)).is_err());
}
