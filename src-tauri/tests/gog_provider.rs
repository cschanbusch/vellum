//! The shipped GOG provider, run in the real QuickJS host. The folders and registry values copy
//! the shapes seen on a real Galaxy 2.1 install. Nothing here starts a program: launches go to a
//! recording stand-in, including in the live test against this PC's real install.

mod common;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use common::*;
use serde_json::{json, Map, Value};
use vellum_lib::platform::Hive;
use vellum_lib::providers::host::Method;
use vellum_lib::providers::locations::{FakeRegistry, SystemRegistry};
use vellum_lib::providers::model::{parse_scan, GameKind, ProviderGame};

const GAMES: &str = r"SOFTWARE\WOW6432Node\GOG.com\Games";

struct Fixture {
    dir: tempfile::TempDir,
    galaxy: PathBuf,
    registry: FakeRegistry,
}

fn add(reg: &mut FakeRegistry, id: &str, values: &[(&str, &str)]) {
    for (k, v) in values {
        reg.set(Hive::LocalMachine, &format!(r"{GAMES}\{id}"), k, v);
    }
}

fn touch(p: &Path) {
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, b"x").unwrap();
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let galaxy = root.join("GOG Galaxy");
    touch(&galaxy.join("GalaxyClient.exe"));
    let mut registry = FakeRegistry::default();

    // A base game as Galaxy installs it: manuals and links come first, the game runs under ScummVM.
    let sky = root.join("Games").join("Sky Game");
    touch(&sky.join(r"ScummVM\scummvm.exe"));
    touch(&sky.join("goggame-1000.ico"));
    std::fs::write(
        sky.join("goggame-1000.info"),
        json!({
            "gameId": "1000", "rootGameId": "1000", "name": "Sky Game: Info Title",
            "playTasks": [
                { "category": "document", "name": "Manual", "path": "Manual.pdf", "type": "FileTask" },
                { "category": "document", "name": "Support", "link": "http://example.invalid", "type": "URLTask" },
                { "category": "game", "isPrimary": true, "name": "Sky Game", "path": r"ScummVM\scummvm.exe",
                  "arguments": r#"-c "..\sky game.ini" sky"#, "workingDir": "ScummVM", "type": "FileTask" },
            ],
        })
        .to_string(),
    )
    .unwrap();
    add(&mut registry, "1000", &[("gameName", "Registry Title"), ("path", sky.to_str().unwrap()), ("dependsOn", "")]);

    // An add-on, both ways it can show: rootGameId in its info file, dependsOn in the registry.
    let dlc = root.join("Games").join("Sky DLC");
    std::fs::create_dir_all(&dlc).unwrap();
    std::fs::write(dlc.join("goggame-1001.info"), json!({ "gameId": "1001", "rootGameId": "1000", "name": "Sky DLC", "playTasks": [] }).to_string()).unwrap();
    add(&mut registry, "1001", &[("path", dlc.to_str().unwrap())]);
    let dep = root.join("Games").join("Dep DLC");
    std::fs::create_dir_all(&dep).unwrap();
    add(&mut registry, "1002", &[("gameName", "Dep DLC"), ("path", dep.to_str().unwrap()), ("dependsOn", "1000")]);

    // A standalone installer's game with no info file: the registry says everything.
    let plain = root.join("Games").join("Plain");
    touch(&plain.join("plain.exe"));
    add(
        &mut registry,
        "2000",
        &[
            ("gameName", "Plain Game"),
            ("path", plain.to_str().unwrap()),
            ("exe", plain.join("plain.exe").to_str().unwrap()),
            ("launchParam", "-windowed"),
            ("workingDir", plain.to_str().unwrap()),
        ],
    );

    // A broken info file falls back to the registry too; a removed game is left out.
    let broken = root.join("Games").join("Broken");
    std::fs::create_dir_all(&broken).unwrap();
    std::fs::write(broken.join("goggame-3000.info"), b"{ nope").unwrap();
    add(&mut registry, "3000", &[("gameName", "Broken Info"), ("path", broken.to_str().unwrap())]);
    add(&mut registry, "4000", &[("gameName", "Uninstalled"), ("path", root.join("gone").to_str().unwrap())]);

    Fixture { dir, galaxy, registry }
}

fn scan(h: &mut Harness) -> Vec<ProviderGame> {
    let s = parse_scan(h.call(Method::Scan, None).unwrap().value).unwrap();
    assert!(s.skipped.is_empty(), "{:?}", s.skipped);
    s.games
}

/// The returned folder must stay alive as long as the harness: bind it to a named variable.
fn harness(fx: Fixture, settings: Map<String, Value>, with_galaxy: bool) -> (Harness, tempfile::TempDir) {
    let locs: Vec<(&str, &Path)> = if with_galaxy { vec![("galaxy", fx.galaxy.as_path())] } else { vec![] };
    (Harness::new(shipped_provider("gog", settings), &locs, fx.registry), fx.dir)
}

fn find<'a>(games: &'a [ProviderGame], id: &str) -> &'a ProviderGame {
    games.iter().find(|g| g.source_id == id).unwrap()
}

#[test]
fn lists_games_from_the_registry_preferring_the_info_file() {
    let (mut h, _dir) = harness(fixture(), Map::new(), true);
    let games = scan(&mut h);
    let ids: Vec<&str> = games.iter().map(|g| g.source_id.as_str()).collect();
    assert_eq!(ids, ["1000", "1001", "1002", "2000", "3000"], "the game whose folder is gone is left out");

    let sky = find(&games, "1000");
    assert_eq!(sky.title, "Sky Game: Info Title");
    assert_eq!(sky.kind, GameKind::Game);
    assert!(sky.install_dir.as_deref().unwrap().ends_with("Sky Game"));

    assert_eq!(find(&games, "1001").kind, GameKind::Dlc, "rootGameId names another game");
    assert_eq!(find(&games, "1002").kind, GameKind::Dlc, "dependsOn is set");
    assert_eq!(find(&games, "2000").title, "Plain Game");
    assert_eq!(find(&games, "3000").title, "Broken Info", "an unreadable info file falls back");
}

#[test]
fn the_option_launches_through_galaxy() {
    let fx = fixture();
    let exe = fx.galaxy.join("GalaxyClient.exe");
    let mut on = Map::new();
    on.insert("skipGalaxy".into(), json!(false));
    let (mut h, _dir) = harness(fx, on, true);
    let games = scan(&mut h);
    let game = serde_json::to_value(find(&games, "1000")).unwrap();
    h.call(Method::Launch, Some(&game)).unwrap();
    let dir = game["installDir"].as_str().unwrap();
    assert_eq!(h.opened(), [format!("run {} /command=runGame /gameId=1000 /path={dir}", exe.display())]);
}

#[test]
fn by_default_or_without_galaxy_the_game_runs_directly_and_galaxy_stays_closed() {
    let mut on = Map::new();
    on.insert("skipGalaxy".into(), json!(false));
    for (settings, galaxy) in [(Map::new(), true), (on, false)] {
        let (mut h, _dir) = harness(fixture(), settings, galaxy);
        let games = scan(&mut h);
        let game = serde_json::to_value(find(&games, "1000")).unwrap();
        h.call(Method::Launch, Some(&game)).unwrap();
        let exe = Path::new(game["installDir"].as_str().unwrap()).join(r"ScummVM\scummvm.exe");
        assert_eq!(h.opened(), [format!(r"run {} -c ..\sky game.ini sky", exe.display())], "the game, not the manual");
    }
}

#[test]
fn a_game_with_no_info_file_uses_the_registrys_command() {
    let (mut h, _dir) = harness(fixture(), Map::new(), false);
    let games = scan(&mut h);
    let game = serde_json::to_value(find(&games, "2000")).unwrap();
    h.call(Method::Launch, Some(&game)).unwrap();
    let exe = Path::new(game["installDir"].as_str().unwrap()).join("plain.exe");
    assert_eq!(h.opened(), [format!("run {} -windowed", exe.display())]);

    let broken = serde_json::to_value(find(&games, "3000")).unwrap();
    let err = h.call(Method::Launch, Some(&broken)).unwrap_err().to_string();
    assert!(err.contains("no program to start"), "{err}");
}

#[test]
fn offers_the_games_own_icon() {
    let (mut h, _dir) = harness(fixture(), Map::new(), false);
    let games = scan(&mut h);
    let art = h.call(Method::Art, Some(&serde_json::to_value(find(&games, "1000")).unwrap())).unwrap().value;
    assert_eq!(art[0]["kind"], json!("icon"));
    assert!(art[0]["file"].as_str().unwrap().ends_with("goggame-1000.ico"));
    let none = h.call(Method::Art, Some(&serde_json::to_value(find(&games, "2000")).unwrap())).unwrap().value;
    assert_eq!(none, json!([]));
}

/// This PC's real install, read-only: run with `--ignored --nocapture` when GOG is installed.
/// Launches are recorded, not run, so nothing opens.
#[test]
#[ignore = "needs a real GOG install"]
fn live_real_install() {
    let galaxy = Path::new(r"C:\Program Files\GOG Galaxy");
    let mut on = Map::new();
    on.insert("skipGalaxy".into(), json!(false));
    let mut h = Harness::new(shipped_provider("gog", on), &[("galaxy", galaxy)], FakeRegistry::default());
    h.env.registry = Arc::new(SystemRegistry);
    let games = scan(&mut h);
    assert!(!games.is_empty(), "no GOG games found");
    for g in &games {
        println!("{} | {} | {:?} | {:?}", g.source_id, g.title, g.kind, g.install_dir);
        let arg = serde_json::to_value(g).unwrap();
        let art = h.call(Method::Art, Some(&arg)).unwrap().value;
        println!("  art: {art}");
        if let Some(icon) = art[0]["file"].as_str() {
            let img = image::ImageReader::open(icon).unwrap().with_guessed_format().unwrap().decode().unwrap();
            println!("  the icon decodes: {}x{}", img.width(), img.height());
        }
        h.call(Method::Launch, Some(&arg)).unwrap();
    }

    let mut direct = Harness::new(shipped_provider("gog", Map::new()), &[("galaxy", galaxy)], FakeRegistry::default());
    direct.env.registry = Arc::new(SystemRegistry);
    for g in &scan(&mut direct) {
        direct.call(Method::Launch, Some(&serde_json::to_value(g).unwrap())).unwrap();
    }
    println!("through Galaxy: {:#?}", h.opened());
    println!("directly: {:#?}", direct.opened());
}
