//! The plugins in the repo's `plugins/` folder are what ships beside Vellum.exe: they must
//! all validate, and the broken dev fixtures must all be rejected.

use std::path::{Path, PathBuf};

use vellum_lib::plugins::{discover, PluginKind};

fn repo(rel: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join(rel)
}

#[test]
fn every_shipped_plugin_is_valid() {
    let found = discover(&[repo("plugins")]);
    for p in &found {
        assert!(p.is_valid(), "{} {} has errors: {:?}", p.kind.as_str(), p.id, p.errors);
        assert!(p.warnings.is_empty(), "{} {} has warnings: {:?}", p.kind.as_str(), p.id, p.warnings);
    }
    let ids = |k: PluginKind| {
        let mut v: Vec<&str> = found.iter().filter(|p| p.kind == k).map(|p| p.id.as_str()).collect();
        v.sort();
        v
    };
    assert_eq!(ids(PluginKind::Provider), ["custom", "epic", "gog", "mock", "steam"]);
    assert_eq!(ids(PluginKind::Skin), ["basis"]);
    assert_eq!(ids(PluginKind::Module), ["quick-launch", "random-pick"]);
}

#[test]
fn every_dev_fixture_is_rejected_with_a_reason() {
    let found = discover(&[repo("tests/fixtures/dev-plugins")]);
    assert_eq!(found.len(), 4);
    for p in &found {
        assert!(!p.is_valid() && !p.errors.is_empty(), "{} should be invalid", p.id);
    }
}
