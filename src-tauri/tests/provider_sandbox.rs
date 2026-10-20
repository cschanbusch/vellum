//! A deliberately hostile provider tries every way out of the sandbox; each attempt must be
//! refused. Also covers limits (timeout, memory) and module loading rules.

mod common;

use std::path::Path;
use std::time::Duration;

use common::*;
use serde_json::{json, Map, Value};
use vellum_lib::platform::Hive;
use vellum_lib::providers::host::{HostError, Method};
use vellum_lib::providers::locations::FakeRegistry;
use vellum_lib::providers::model::ProviderSpec;

fn spec(dir: &Path, source: &str, derived: bool) -> ProviderSpec {
    std::fs::write(dir.join("provider.js"), source).unwrap();
    ProviderSpec {
        id: "hostile".into(),
        name: "Hostile".into(),
        dir: dir.to_path_buf(),
        entry: "provider.js".into(),
        locations: Vec::new(),
        derived_locations: derived,
        registry_read: vec!["HKCU\\Software\\Valve\\Steam".into()],
        uri_schemes: vec!["steam".into()],
        art_hosts: Vec::new(),
        capabilities: vec!["launch".into()],
        deny_files: vec!["config/loginusers.vdf".into(), "ssfn*".into()],
        settings: Map::new(),
    }
}

struct World {
    _tmp: tempfile::TempDir,
    plugin: std::path::PathBuf,
    root: std::path::PathBuf,
    outside: std::path::PathBuf,
}

fn world() -> World {
    let tmp = tempfile::tempdir().unwrap();
    let plugin = tmp.path().join("plugin");
    let root = tmp.path().join("store");
    let outside = tmp.path().join("outside");
    for d in [&plugin, &root.join("config"), &outside] {
        std::fs::create_dir_all(d).unwrap();
    }
    std::fs::write(root.join("ok.txt"), "fine").unwrap();
    std::fs::write(root.join("config/loginusers.vdf"), "secret").unwrap();
    std::fs::write(root.join("ssfn99"), "secret").unwrap();
    std::fs::write(outside.join("secret.txt"), "secret").unwrap();
    std::fs::write(outside.join("evil.exe"), "MZ").unwrap();
    std::fs::write(tmp.path().join("sibling.js"), "export const x = 1;").unwrap();
    World { _tmp: tmp, plugin, root, outside }
}

const ATTEMPTS: &str = r#"
const results = {};
const attempt = (name, fn) => {
  try { const v = fn(); results[name] = "ALLOWED " + JSON.stringify(v ?? null); }
  catch (e) { results[name] = "blocked"; }
};
export default {
  scan(ctx) {
    const root = ctx.locations.root;
    const outside = root + "\\..\\outside";
    results.okRead = ctx.fs.readText(root + "\\ok.txt");
    attempt("traversal", () => ctx.fs.readText(outside + "\\secret.txt"));
    attempt("absoluteOutside", () => ctx.fs.readBytes(ctx.settings.outside + "\\secret.txt"));
    attempt("listOutside", () => ctx.fs.list(ctx.settings.outside));
    attempt("globOutside", () => ctx.fs.glob(ctx.settings.outside, "*"));
    attempt("denylisted", () => ctx.fs.readText(root + "\\config\\loginusers.vdf"));
    attempt("denylistedCase", () => ctx.fs.readText(root + "\\CONFIG\\LoginUsers.VDF"));
    attempt("sentry", () => ctx.fs.readText(root + "\\ssfn99"));
    results.globHidesDenied = ctx.fs.glob(root, "**/*").filter((p) => /loginusers|ssfn/i.test(p)).length;
    attempt("allowWithoutPermission", () => ctx.fs.allow(ctx.settings.outside));
    attempt("registryOutsideAllowlist", () => ctx.registry.get("HKLM", "SOFTWARE\\Microsoft", "x"));
    attempt("registryPrefixTrick", () => ctx.registry.get("HKCU", "Software\\Valve\\SteamEvil", "x"));
    results.registryAllowed = ctx.registry.get("HKCU", "Software\\Valve\\Steam", "SteamPath");
    attempt("httpUri", () => ctx.openUri("https://evil.example/"));
    attempt("fileUri", () => ctx.openUri("file:///C:/Windows/System32/calc.exe"));
    attempt("runOutside", () => ctx.run(ctx.settings.outside + "\\evil.exe", []));
    attempt("sqlite", () => ctx.sqlite.query(root + "\\x.db", "select 1", []));
    attempt("mutateCtx", () => { ctx.fs.readText = () => "pwned"; return ctx.fs.readText(outside + "\\secret.txt"); });
    attempt("rawHost", () => globalThis.__host.readText(outside + "\\secret.txt"));
    results.globals = ["setTimeout", "fetch", "XMLHttpRequest", "require", "process", "std", "os"]
      .filter((g) => typeof globalThis[g] !== "undefined");
    results.statAnywhere = ctx.fs.stat(ctx.settings.outside + "\\secret.txt") !== null;
    return { games: [], results };
  },
};
"#;

#[test]
fn hostile_provider_is_contained() {
    let w = world();
    let mut reg = FakeRegistry::default();
    reg.set(Hive::CurrentUser, "Software\\Valve\\Steam", "SteamPath", "c:/steam");
    let mut s = spec(&w.plugin, ATTEMPTS, false);
    s.settings.insert("outside".into(), json!(w.outside.to_string_lossy()));
    let mut h = Harness::new(s, &[("root", &w.root)], reg);
    let out = h.call(Method::Scan, None).unwrap();
    let r = &out.value["results"];

    assert_eq!(r["okRead"], "fine");
    for (name, v) in r.as_object().unwrap() {
        if let Some(s) = v.as_str() {
            assert!(!s.starts_with("ALLOWED"), "{name} escaped the sandbox: {s}");
        }
    }
    for name in ["traversal", "absoluteOutside", "listOutside", "globOutside", "denylisted", "denylistedCase", "sentry", "allowWithoutPermission", "registryOutsideAllowlist", "registryPrefixTrick", "httpUri", "fileUri", "runOutside", "sqlite", "mutateCtx", "rawHost"] {
        assert_eq!(r[name], "blocked", "{name}");
    }
    assert_eq!(r["globHidesDenied"], 0);
    assert_eq!(r["registryAllowed"], "c:/steam");
    assert_eq!(r["globals"], json!([]));
    assert_eq!(r["statAnywhere"], true, "exists/stat reveal no content and are allowed anywhere");
    assert!(h.opened().is_empty(), "nothing may be opened or run: {:?}", h.opened());
}

#[test]
fn imports_stay_inside_the_plugin_folder() {
    let w = world();
    std::fs::create_dir_all(w.plugin.join("lib")).unwrap();
    std::fs::write(w.plugin.join("lib/util.js"), "export const n = 3;").unwrap();
    let ok = spec(&w.plugin, r#"import { n } from "./lib/util.js"; export default { scan() { return { games: [], n }; } };"#, false);
    let mut h = Harness::new(ok, &[("root", &w.root)], FakeRegistry::default());
    assert_eq!(h.call(Method::Scan, None).unwrap().value["n"], 3);

    for src in [
        r#"import { x } from "../sibling.js"; export default { scan() { return { games: [] }; } };"#,
        r#"import "https://evil.example/x.js"; export default { scan() { return { games: [] }; } };"#,
        r#"import * as std from "std"; export default { scan() { return { games: [] }; } };"#,
    ] {
        let mut h = Harness::new(spec(&w.plugin, src, false), &[("root", &w.root)], FakeRegistry::default());
        assert!(matches!(h.call(Method::Scan, None), Err(HostError::Load(_))), "{src}");
    }
}

#[test]
fn derived_locations_extend_scope_for_later_calls() {
    let w = world();
    let src = r#"export default {
      scan(ctx) { ctx.fs.allow(ctx.settings.outside); return { games: [] }; },
      launch(ctx) { return ctx.fs.readText(ctx.settings.outside + "\\secret.txt"); },
    };"#;
    let mut s = spec(&w.plugin, src, true);
    s.settings.insert("outside".into(), json!(w.outside.to_string_lossy()));
    let mut h = Harness::new(s, &[("root", &w.root)], FakeRegistry::default());
    assert!(h.call(Method::Launch, Some(&json!({}))).is_err(), "not allowed before the scan derives it");
    h.call(Method::Scan, None).unwrap();
    assert_eq!(h.call(Method::Launch, Some(&json!({}))).unwrap().value, "secret");
}

#[test]
fn run_allows_exes_in_the_game_install_dir_only_during_that_call() {
    let w = world();
    let src = r#"export default { launch(ctx, game) { ctx.run(game.installDir + "\\evil.exe", ["-x"]); } };"#;
    let mut h = Harness::new(spec(&w.plugin, src, false), &[("root", &w.root)], FakeRegistry::default());
    let game = json!({ "sourceId": "1", "title": "t", "installDir": w.outside.to_string_lossy() });
    h.call(Method::Launch, Some(&game)).unwrap();
    assert_eq!(h.opened().len(), 1);
    assert!(h.opened()[0].starts_with("run ") && h.opened()[0].ends_with("evil.exe -x"));
}

#[test]
fn limits_turn_runaway_providers_into_errors() {
    let w = world();
    let mut h = Harness::new(spec(&w.plugin, "export default { scan() { for (;;) {} } };", false), &[("root", &w.root)], FakeRegistry::default());
    h.timeout = Some(Duration::from_millis(500));
    let started = std::time::Instant::now();
    assert!(matches!(h.call(Method::Scan, None), Err(HostError::Timeout(_))));
    assert!(started.elapsed() < Duration::from_secs(5));

    let bomb = "export default { scan() { const a = []; for (;;) a.push(new Array(1e6).fill(1)); } };";
    let mut h = Harness::new(spec(&w.plugin, bomb, false), &[("root", &w.root)], FakeRegistry::default());
    assert!(matches!(h.call(Method::Scan, None), Err(HostError::Memory)));

    let throws = "export default { scan() { throw new Error('boom'); } };";
    let mut h = Harness::new(spec(&w.plugin, throws, false), &[("root", &w.root)], FakeRegistry::default());
    match h.call(Method::Scan, None) {
        Err(HostError::Script(m)) => assert!(m.contains("boom"), "{m}"),
        other => panic!("{other:?}"),
    }

    let missing = "export default { scan() { return { games: [] }; } };";
    let mut h = Harness::new(spec(&w.plugin, missing, false), &[("root", &w.root)], FakeRegistry::default());
    assert!(matches!(h.call(Method::OpenStore, Some(&Value::Null)), Err(HostError::Missing("openStore"))));
}
