//! The plugins in the repo's `plugins/` (core) and `extras/` (optional) folders are what ships beside
//! Vellum Game Launcher.exe: they must all validate, and an id may not appear in both. Among the dev fixtures, the test skins must validate and the deliberately
//! broken plugins must all be rejected.

use std::path::{Path, PathBuf};

use vellum_lib::plugins::{discover, PluginKind};

fn repo(rel: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join(rel)
}

#[test]
fn every_shipped_plugin_is_valid() {
    let found = discover(&[repo("plugins"), repo("extras")]);
    for p in &found {
        assert!(p.is_valid(), "{} {} has errors: {:?}", p.kind.as_str(), p.id, p.errors);
        assert!(p.warnings.is_empty(), "{} {} has warnings: {:?}", p.kind.as_str(), p.id, p.warnings);
    }
    let ids = |root: &str, k: PluginKind| {
        let root = repo(root);
        let mut v: Vec<&str> =
            found.iter().filter(|p| p.kind == k && p.dir.starts_with(&root)).map(|p| p.id.as_str()).collect();
        v.sort();
        v
    };
    // Core: what the launcher needs on its own. The default skin must be here.
    assert_eq!(ids("plugins", PluginKind::Provider), ["custom", "epic", "gog", "steam"]);
    assert_eq!(ids("plugins", PluginKind::Skin), ["basis"]);
    assert!(ids("plugins", PluginKind::Module).is_empty());
    // Extras: safe to leave out of an install.
    assert_eq!(ids("extras", PluginKind::Provider), ["mock"]);
    assert_eq!(ids("extras", PluginKind::Skin), ["aero", "calling-card", "ficsit", "frontier", "gridline", "redline", "synthwave"]);
    assert_eq!(ids("extras", PluginKind::Module), ["quick-launch", "random-pick"]);
}

#[test]
fn every_dev_fixture_is_rejected_with_a_reason() {
    const TEST_SKINS: [&str; 4] = ["music-test", "sidebar-test", "timeline-test", "token-test"];
    let found = discover(&[repo("tests/fixtures/dev-plugins")]);
    assert_eq!(found.len(), 8);
    for p in &found {
        if p.kind == PluginKind::Skin && TEST_SKINS.contains(&p.id.as_str()) {
            assert!(p.is_valid(), "test skin {} has errors: {:?}", p.id, p.errors);
        } else {
            assert!(!p.is_valid() && !p.errors.is_empty(), "{} should be invalid", p.id);
        }
    }
}
