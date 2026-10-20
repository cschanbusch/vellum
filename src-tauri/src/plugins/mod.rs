//! Plugin discovery and manifests. All three plugin types share one folder convention:
//! `plugins/<providers|skins|modules>/<id>/plugin.json`.

pub mod manifest;

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub use manifest::Manifest;

pub const MANIFEST_FILE: &str = "plugin.json";
/// The host API version this build implements.
pub const API_VERSION: u32 = 1;
/// The oldest host API version still supported.
pub const MIN_API_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginKind {
    Provider,
    Skin,
    Module,
}

impl PluginKind {
    pub const ALL: [PluginKind; 3] = [PluginKind::Provider, PluginKind::Skin, PluginKind::Module];

    /// Folder under `plugins/` that holds this type.
    pub fn folder(self) -> &'static str {
        match self {
            PluginKind::Provider => "providers",
            PluginKind::Skin => "skins",
            PluginKind::Module => "modules",
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            PluginKind::Provider => "provider",
            PluginKind::Skin => "skin",
            PluginKind::Module => "module",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|k| k.as_str() == s)
    }
}

/// One plugin folder as found on disk. Invalid plugins are kept (with errors) so the
/// Plugins page can show what is wrong; they are never enabled.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRecord {
    /// Manifest id, or the folder name when the manifest has no usable id.
    pub id: String,
    pub kind: PluginKind,
    /// Display name: manifest name, or the folder name.
    pub name: String,
    pub version: Option<String>,
    pub dir: PathBuf,
    pub manifest: Option<Manifest>,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

impl PluginRecord {
    pub fn is_valid(&self) -> bool {
        self.errors.is_empty()
    }
}

/// Scans each root's `providers/`, `skins/` and `modules/` folders. Later roots never
/// replace earlier ones: a repeated id is reported as an error on the later plugin.
pub fn discover(roots: &[PathBuf]) -> Vec<PluginRecord> {
    let mut out: Vec<PluginRecord> = Vec::new();
    let mut seen: HashMap<(PluginKind, String), PathBuf> = HashMap::new();

    for root in roots {
        for kind in PluginKind::ALL {
            for dir in subfolders(&root.join(kind.folder())) {
                let mut rec = load(&dir, kind);
                if rec.is_valid() {
                    let key = (kind, rec.id.clone());
                    if let Some(first) = seen.get(&key) {
                        rec.errors.push(format!(
                            "Another {} already uses the id \"{}\" ({}).",
                            kind.as_str(),
                            rec.id,
                            first.display()
                        ));
                        rec.manifest = None;
                    } else {
                        seen.insert(key, dir.clone());
                    }
                }
                out.push(rec);
            }
        }
    }
    out
}

fn subfolders(dir: &Path) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut dirs: Vec<PathBuf> = rd
        .filter_map(Result::ok)
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .map(|e| e.path())
        .collect();
    dirs.sort();
    dirs
}

/// Reads and validates one plugin folder. Never fails: problems become `errors`.
pub fn load(dir: &Path, kind: PluginKind) -> PluginRecord {
    let folder = dir.file_name().unwrap_or_default().to_string_lossy().into_owned();
    let mut rec = PluginRecord {
        id: folder.clone(),
        kind,
        name: folder.clone(),
        version: None,
        dir: dir.to_path_buf(),
        manifest: None,
        errors: Vec::new(),
        warnings: Vec::new(),
    };

    let text = match std::fs::read_to_string(dir.join(MANIFEST_FILE)) {
        Ok(t) => t,
        Err(_) => {
            rec.errors.push(format!("No {MANIFEST_FILE} in this folder."));
            return rec;
        }
    };
    let v = manifest::validate(dir, kind, &text);
    if let Some(id) = v.id {
        rec.id = id;
    }
    if let Some(name) = v.name {
        rec.name = name;
    }
    rec.version = v.version;
    rec.errors = v.errors;
    rec.warnings = v.warnings;
    rec.manifest = v.manifest;
    rec
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plugin(root: &Path, kind: PluginKind, folder: &str, json: &str, files: &[&str]) {
        let dir = root.join(kind.folder()).join(folder);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(MANIFEST_FILE), json).unwrap();
        for f in files {
            std::fs::write(dir.join(f), "").unwrap();
        }
    }

    fn provider_json(id: &str) -> String {
        format!(
            r#"{{"id":"{id}","type":"provider","name":"P {id}","version":"1.0.0","apiVersion":1,"entry":"provider.js","provider":{{}}}}"#
        )
    }

    #[test]
    fn finds_valid_plugins_in_all_three_folders() {
        let root = tempfile::tempdir().unwrap();
        plugin(root.path(), PluginKind::Provider, "steam", &provider_json("steam"), &["provider.js"]);
        plugin(
            root.path(),
            PluginKind::Skin,
            "basis",
            r#"{"id":"basis","type":"skin","name":"Basis","version":"1.0.0","apiVersion":1,"entry":"index.html","skin":{}}"#,
            &["index.html"],
        );
        plugin(
            root.path(),
            PluginKind::Module,
            "random-pick",
            r#"{"id":"random-pick","type":"module","name":"Random","version":"1.0.0","apiVersion":1,"entry":"index.html","module":{}}"#,
            &["index.html"],
        );
        let found = discover(&[root.path().to_path_buf()]);
        assert_eq!(found.len(), 3);
        assert!(found.iter().all(|p| p.is_valid()), "{found:#?}");
    }

    #[test]
    fn missing_manifest_and_bad_json_are_reported_not_fatal() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("providers").join("empty")).unwrap();
        plugin(root.path(), PluginKind::Provider, "garbled", "{ nope", &[]);
        let found = discover(&[root.path().to_path_buf()]);
        assert_eq!(found.len(), 2);
        assert!(found.iter().all(|p| !p.is_valid() && p.manifest.is_none()));
        assert!(found.iter().any(|p| p.errors[0].contains("No plugin.json")));
        assert!(found.iter().any(|p| p.errors[0].contains("not valid JSON")));
    }

    #[test]
    fn duplicate_ids_across_roots_keep_the_first() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        plugin(a.path(), PluginKind::Provider, "steam", &provider_json("steam"), &["provider.js"]);
        plugin(b.path(), PluginKind::Provider, "steam-copy", &provider_json("steam"), &["provider.js"]);
        let found = discover(&[a.path().to_path_buf(), b.path().to_path_buf()]);
        assert!(found[0].is_valid());
        assert!(!found[1].is_valid());
        assert!(found[1].errors[0].contains("already uses the id"));
    }

    #[test]
    fn hidden_folders_and_loose_files_are_ignored() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("providers").join(".git")).unwrap();
        std::fs::write(root.path().join("providers").join("readme.txt"), "").unwrap();
        assert!(discover(&[root.path().to_path_buf()]).is_empty());
    }
}
