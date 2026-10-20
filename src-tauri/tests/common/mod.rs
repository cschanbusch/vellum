//! Shared helpers for integration tests.
#![allow(dead_code)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use serde_json::{Map, Value};
use vellum_lib::providers::host::{self, HostEnv, Invocation, Method, Output, RecordingOpener};
use vellum_lib::providers::locations::FakeRegistry;
use vellum_lib::providers::model::ProviderSpec;
use vellum_lib::plugins::{self, PluginKind};

pub fn repo(rel: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join(rel)
}

pub fn copy_tree(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap() {
        let e = e.unwrap();
        let dest = to.join(e.file_name());
        if e.file_type().unwrap().is_dir() {
            copy_tree(&e.path(), &dest);
        } else {
            std::fs::copy(e.path(), dest).unwrap();
        }
    }
}

/// VDF strings escape backslashes.
pub fn vdf_path(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "\\\\")
}

/// A temp copy of tests/fixtures/steam with library paths filled in and account 22222's
/// localconfig.vdf newer than 11111's, so 22222 is the active account.
pub struct SteamFixture {
    pub dir: tempfile::TempDir,
    pub root: PathBuf,
    pub lib_b: PathBuf,
}

pub fn steam_fixture() -> SteamFixture {
    let dir = tempfile::tempdir().unwrap();
    copy_tree(&repo("tests/fixtures/steam"), dir.path());
    let root = dir.path().join("root");
    let lib_b = dir.path().join("libB");
    let lf = root.join("steamapps").join("libraryfolders.vdf");
    let text = std::fs::read_to_string(&lf)
        .unwrap()
        .replace("%ROOT%", &vdf_path(&root))
        .replace("%LIBB%", &vdf_path(&lib_b))
        .replace("%MISSING%", &vdf_path(&dir.path().join("unplugged")));
    std::fs::write(&lf, text).unwrap();
    let old = SystemTime::now() - Duration::from_secs(86_400);
    std::fs::File::options()
        .write(true)
        .open(root.join("userdata/11111/config/localconfig.vdf"))
        .unwrap()
        .set_modified(old)
        .unwrap();
    SteamFixture { dir, root, lib_b }
}

pub fn shipped_provider(id: &str, settings: Map<String, Value>) -> ProviderSpec {
    let rec = plugins::load(&repo(&format!("plugins/providers/{id}")), PluginKind::Provider);
    assert!(rec.is_valid(), "{:?}", rec.errors);
    ProviderSpec::from_record(&rec, &settings).unwrap()
}

pub struct Harness {
    pub spec: ProviderSpec,
    pub locations: BTreeMap<String, PathBuf>,
    pub derived: Vec<PathBuf>,
    pub opener: Arc<RecordingOpener>,
    pub env: HostEnv,
    pub timeout: Option<Duration>,
}

impl Harness {
    pub fn new(spec: ProviderSpec, locations: &[(&str, &Path)], registry: FakeRegistry) -> Self {
        let opener = Arc::new(RecordingOpener::default());
        Harness {
            spec,
            locations: locations.iter().map(|(k, p)| (k.to_string(), p.to_path_buf())).collect(),
            derived: Vec::new(),
            env: HostEnv { registry: Arc::new(registry), opener: opener.clone() },
            opener,
            timeout: None,
        }
    }

    pub fn call(&mut self, method: Method, arg: Option<&Value>) -> Result<Output, host::HostError> {
        let inv = Invocation {
            spec: &self.spec,
            locations: &self.locations,
            derived: &self.derived,
            env: &self.env,
            timeout: self.timeout,
        };
        let out = host::invoke(&inv, method, arg)?;
        self.derived.extend(out.derived.iter().cloned());
        Ok(out)
    }

    pub fn opened(&self) -> Vec<String> {
        self.opener.calls.lock().unwrap().clone()
    }
}
