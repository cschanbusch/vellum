//! The shipped PCSX2 provider, run in the real QuickJS host. The folders, settings file, game list
//! cache and playtime file copy the shapes seen on a real PCSX2 2.6.3 install. Nothing here starts
//! a program: launches go to a recording stand-in, including in the live test.

mod common;

use std::path::{Path, PathBuf};

use common::*;
use serde_json::{json, Map, Value};
use vellum_lib::providers::host::Method;
use vellum_lib::providers::locations::FakeRegistry;
use vellum_lib::providers::model::{parse_scan, ProviderGame};

/// One record of PCSX2's `cache/gamelist.cache`.
fn record(path: &Path, serial: &str, title: &str, title_en: &str, ty: u8) -> Vec<u8> {
    let mut out = Vec::new();
    for s in [path.to_str().unwrap(), serial, title, "", title_en] {
        out.extend((s.len() as u32).to_le_bytes());
        out.extend(s.as_bytes());
    }
    out.extend([ty, 6]);
    out.extend(5_312_000_000u64.to_le_bytes());
    out.extend(1_779_000_000u64.to_le_bytes());
    out.extend(0x77e6_1c8au32.to_le_bytes());
    out.push(5);
    out
}

fn touch(p: &Path) {
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, b"x").unwrap();
}

struct Fixture {
    dir: tempfile::TempDir,
    install: PathBuf,
    flat: PathBuf,
    deep: PathBuf,
}

/// A portable PCSX2 with one folder scanned without subfolders and one with them.
fn fixture(cache: impl FnOnce(&Fixture) -> Vec<u8>, ui: &str) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let fx = Fixture { install: root.join("PCSX2"), flat: root.join("Flat"), deep: root.join("Deep Games"), dir };
    touch(&fx.install.join("pcsx2-qt.exe"));
    touch(&fx.install.join("portable.txt"));
    touch(&fx.install.join(r"covers\SCUS-97328.jpg"));
    touch(&fx.flat.join("Gran Turismo 4 (USA).iso"));
    touch(&fx.flat.join(r"Sub\Not Scanned (USA).iso")); // Paths don't include subfolders
    touch(&fx.flat.join("notes.txt"));
    touch(&fx.deep.join(r"A\Okami (USA) [SLUS_215.15].chd")); // not in the cache yet
    touch(&fx.deep.join(r"B\Homebrew.elf"));
    touch(&fx.deep.join(r"C\GT4 Prologue.iso"));
    touch(&fx.deep.join(r"D\Not A Game.bin"));
    touch(&fx.deep.join(r"E\Gran Turismo 4 (Copy).iso"));
    touch(&fx.deep.join("skip me.iso"));
    std::fs::create_dir_all(fx.install.join("inis")).unwrap();
    std::fs::write(
        fx.install.join(r"inis\PCSX2.ini"),
        format!(
            "[UI]\r\n{ui}\r\n\r\n[GameList]\r\nPaths = {}\r\nRecursivePaths = {}\r\nExcludedPaths = {}\r\n",
            fx.flat.display(),
            fx.deep.display(),
            fx.deep.join("skip me.iso").display()
        ),
    )
    .unwrap();
    std::fs::write(
        fx.install.join(r"inis\playtime.dat"),
        "SCUS-97328                       24245                1784776674          \nSLUS-21515                       123                  1782510660          \n",
    )
    .unwrap();
    let bytes = cache(&fx);
    std::fs::create_dir_all(fx.install.join("cache")).unwrap();
    std::fs::write(fx.install.join(r"cache\gamelist.cache"), bytes).unwrap();
    fx
}

fn pcsx2_cache(fx: &Fixture) -> Vec<u8> {
    let mut b = b"GLCE".to_vec();
    b.extend(34u32.to_le_bytes());
    b.extend(record(&fx.flat.join("Gran Turismo 4 (USA).iso"), "SCUS-97328", "Gran Turismo 4", "", 0));
    b.extend(record(&fx.deep.join(r"B\Homebrew.elf"), "", "Homebrew", "", 2));
    b.extend(record(&fx.deep.join(r"C\GT4 Prologue.iso"), "SCPS-15055", "グランツーリスモ4 プロローグ", "Gran Turismo 4 Prologue", 0));
    b.extend(record(&fx.deep.join(r"D\Not A Game.bin"), "", "Not A Game", "", 3));
    b.extend(record(&fx.deep.join(r"E\Gran Turismo 4 (Copy).iso"), "SCUS-97328", "Gran Turismo 4", "", 0));
    b.extend(record(&fx.dir.path().join(r"Gone\Removed.iso"), "SLUS-20001", "Removed", "", 0));
    b
}

fn harness(fx: &Fixture, settings: Map<String, Value>) -> Harness {
    Harness::new(shipped_provider("pcsx2", settings), &[("install", fx.install.as_path())], FakeRegistry::default())
}

fn scan(h: &mut Harness) -> Vec<ProviderGame> {
    let s = parse_scan(h.call(Method::Scan, None).unwrap().value).unwrap();
    assert!(s.skipped.is_empty(), "{:?}", s.skipped);
    s.games
}

fn by_title<'a>(games: &'a [ProviderGame], title: &str) -> &'a ProviderGame {
    games.iter().find(|g| g.title == title).unwrap_or_else(|| panic!("no {title}: {games:?}"))
}

#[test]
fn lists_what_pcsx2s_game_list_lists() {
    let fx = fixture(pcsx2_cache, "PreferEnglishGameList = false");
    let mut h = harness(&fx, Map::new());
    let games = scan(&mut h);
    let mut titles: Vec<&str> = games.iter().map(|g| g.title.as_str()).collect();
    titles.sort();
    assert_eq!(
        titles,
        ["Gran Turismo 4", "Gran Turismo 4", "Homebrew", "Okami", "グランツーリスモ4 プロローグ"],
        "not: a subfolder of a Paths folder, a text file, an excluded file, a file PCSX2 can't boot, a removed file"
    );

    let gt4 = games.iter().find(|g| g.source_id == "SCUS-97328").unwrap();
    assert!(gt4.launch_data["path"].as_str().unwrap().ends_with(r"Flat\Gran Turismo 4 (USA).iso"));
    assert_eq!(gt4.playtime_minutes, Some(404));
    assert_eq!(gt4.last_played.as_deref(), Some("2026-07-23T03:17:54.000Z"));
    assert!(gt4.install_dir.as_deref().unwrap().ends_with("Flat"));
    assert_eq!(gt4.size_bytes, Some(1));

    let copy = games.iter().find(|g| g.title == "Gran Turismo 4" && g.source_id != "SCUS-97328").unwrap();
    assert!(copy.source_id.starts_with("file-"), "a second copy of a disc gets an id from its path");

    let okami = by_title(&games, "Okami");
    assert_eq!(okami.source_id, "SLUS-21515", "the serial in the filename");
    assert_eq!(okami.playtime_minutes, Some(2));
    assert_eq!(by_title(&games, "Homebrew").labels, ["ELF"]);
    assert_eq!(by_title(&games, "グランツーリスモ4 プロローグ").source_id, "SCPS-15055");
}

#[test]
fn english_titles_when_pcsx2_prefers_them() {
    let fx = fixture(pcsx2_cache, "PreferEnglishGameList = true");
    let mut h = harness(&fx, Map::new());
    let games = scan(&mut h);
    assert_eq!(games.iter().find(|g| g.source_id == "SCPS-15055").unwrap().title, "Gran Turismo 4 Prologue");
}

#[test]
fn an_unreadable_cache_still_lists_every_file_by_its_name() {
    let fx = fixture(|_| b"GLCE\x63\x00\x00\x00\xff\xff".to_vec(), "");
    let mut h = harness(&fx, Map::new());
    let mut titles: Vec<String> = scan(&mut h).into_iter().map(|g| g.title).collect();
    titles.sort();
    assert_eq!(titles, ["GT4 Prologue", "Gran Turismo 4", "Gran Turismo 4", "Homebrew", "Not A Game", "Okami"]);
}

#[test]
fn without_pcsx2_nothing_is_listed_and_nothing_fails() {
    let mut h = Harness::new(shipped_provider("pcsx2", Map::new()), &[], FakeRegistry::default());
    assert!(scan(&mut h).is_empty());
}

fn launched(settings: Map<String, Value>, game_values: &[(&str, Value)]) -> (Fixture, String) {
    let fx = fixture(pcsx2_cache, "");
    let mut h = harness(&fx, settings);
    let games = scan(&mut h);
    let game = serde_json::to_value(games.iter().find(|g| g.source_id == "SCUS-97328").unwrap()).unwrap();
    for (k, v) in game_values {
        h.spec.game_values.insert(k.to_string(), v.clone());
    }
    h.call(Method::Launch, Some(&game)).unwrap();
    let calls = h.opened();
    assert_eq!(calls.len(), 1);
    (fx, calls[0].clone())
}

#[test]
fn launches_fullscreen_without_pcsx2s_window_and_fast_by_default() {
    let (fx, call) = launched(Map::new(), &[]);
    let exe = fx.install.join("pcsx2-qt.exe");
    let file = fx.flat.join("Gran Turismo 4 (USA).iso");
    assert_eq!(call, format!("run {} -fullscreen -nogui -fastboot -- {}", exe.display(), file.display()));
}

#[test]
fn provider_options_shape_every_launch() {
    let mut s = Map::new();
    s.insert("fullscreen".into(), json!(false));
    s.insert("noGui".into(), json!(false));
    s.insert("fastBoot".into(), json!(false));
    s.insert("extraArgs".into(), json!(r#"-bigpicture -logfile "C:\my logs\x.log""#));
    let (_fx, call) = launched(s, &[]);
    assert!(call.contains(r" -nofullscreen -slowboot -bigpicture -logfile C:\my logs\x.log -- "), "{call}");
}

#[test]
fn a_games_own_options_win_and_add_arguments() {
    let mut s = Map::new();
    s.insert("extraArgs".into(), json!("-bigpicture"));
    let (_fx, call) = launched(s, &[("fullscreen", json!("off")), ("fastBoot", json!("off")), ("noGui", json!("default")), ("args", json!("-gamecfg gt4.ini"))]);
    assert!(call.contains(" -nofullscreen -nogui -slowboot -bigpicture -gamecfg gt4.ini -- "), "{call}");
}

#[test]
fn covers_from_pcsx2_first_then_the_online_set() {
    let fx = fixture(pcsx2_cache, "");
    let mut h = harness(&fx, Map::new());
    let games = scan(&mut h);
    let art = |h: &mut Harness, id: &str| {
        let g = serde_json::to_value(games.iter().find(|g| g.source_id == id).unwrap()).unwrap();
        h.call(Method::Art, Some(&g)).unwrap().value
    };
    let gt4 = art(&mut h, "SCUS-97328");
    assert!(gt4[0]["file"].as_str().unwrap().ends_with(r"covers\SCUS-97328.jpg"));
    assert_eq!(gt4[1]["url"], json!("https://raw.githubusercontent.com/xlenore/ps2-covers/main/covers/default/SCUS-97328.jpg"));
    assert_eq!(art(&mut h, "SLUS-21515"), json!([{ "kind": "cover", "url": "https://raw.githubusercontent.com/xlenore/ps2-covers/main/covers/default/SLUS-21515.jpg" }]));

    let mut off = Map::new();
    off.insert("onlineCovers".into(), json!("off"));
    let mut h = harness(&fx, off);
    let g = serde_json::to_value(games.iter().find(|g| g.source_id == "SLUS-21515").unwrap()).unwrap();
    assert_eq!(h.call(Method::Art, Some(&g)).unwrap().value, json!([]));
}

#[test]
fn the_manifest_offers_launch_options_and_separate_duplicates() {
    let spec = shipped_provider("pcsx2", Map::new());
    assert!(spec.can("launchOptions"), "per-game settings put Launch options… in the game menu");
    assert!(spec.separate_duplicates);
    assert_eq!(spec.game_values["fullscreen"], json!("default"));
}

/// This PC's real install, read-only: run with `--ignored --nocapture` when PCSX2 is at C:\PCSX2.
/// Launches are recorded, not run, so nothing opens.
#[test]
#[ignore = "needs a real PCSX2 install"]
fn live_real_install() {
    let mut h = Harness::new(shipped_provider("pcsx2", Map::new()), &[("install", Path::new(r"C:\PCSX2"))], FakeRegistry::default());
    let out = h.call(Method::Scan, None).unwrap();
    for l in &out.logs {
        println!("log: {l:?}");
    }
    let games = parse_scan(out.value).unwrap().games;
    assert!(!games.is_empty(), "no PCSX2 games found");
    for g in &games {
        println!("{} | {} | {:?} min | {:?}", g.source_id, g.title, g.playtime_minutes, g.labels);
        let arg = serde_json::to_value(g).unwrap();
        println!("  art: {}", h.call(Method::Art, Some(&arg)).unwrap().value);
    }
    let first = serde_json::to_value(&games[0]).unwrap();
    h.call(Method::Launch, Some(&first)).unwrap();
    println!("launch: {:?}", h.opened());
}
