//! Resolving a provider's declared locations: saved path → registry hints → defaults →
//! ask the user. Every candidate tried is recorded, for the UI and for `--diagnose`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use super::scope::{canonical, glob, simplify};
use crate::platform::{self, Hive};

/// Registry access, injectable so tests and non-Windows builds use a fake.
pub trait Registry: Send + Sync {
    fn get(&self, hive: Hive, key: &str, value: &str) -> Option<String>;
    fn subkeys(&self, hive: Hive, key: &str) -> Vec<String>;
}

pub struct SystemRegistry;

impl Registry for SystemRegistry {
    fn get(&self, hive: Hive, key: &str, value: &str) -> Option<String> {
        platform::registry_get(hive, key, value)
    }
    fn subkeys(&self, hive: Hive, key: &str) -> Vec<String> {
        platform::registry_subkeys(hive, key)
    }
}

/// In-memory registry for tests: keys are case-insensitive like the real one.
#[derive(Default)]
pub struct FakeRegistry {
    values: HashMap<(Hive, String, String), String>,
}

impl FakeRegistry {
    pub fn set(&mut self, hive: Hive, key: &str, value: &str, data: &str) {
        self.values.insert((hive, key.to_lowercase(), value.to_lowercase()), data.to_string());
    }
}

impl Registry for FakeRegistry {
    fn get(&self, hive: Hive, key: &str, value: &str) -> Option<String> {
        self.values.get(&(hive, key.to_lowercase(), value.to_lowercase())).cloned()
    }
    fn subkeys(&self, hive: Hive, key: &str) -> Vec<String> {
        let prefix = format!("{}\\", key.to_lowercase());
        let mut out: Vec<String> = self
            .values
            .keys()
            .filter(|(h, k, _)| *h == hive && k.starts_with(&prefix))
            .filter_map(|(_, k, _)| k[prefix.len()..].split('\\').next().map(str::to_string))
            .collect();
        out.sort();
        out.dedup();
        out
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryHint {
    pub hive: Hive,
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocationDecl {
    pub key: String,
    pub label: String,
    pub required: bool,
    pub registry: Vec<RegistryHint>,
    pub defaults: Vec<String>,
    pub validate: Vec<String>,
}

impl LocationDecl {
    /// Reads `provider.locations` from an already-validated manifest section.
    pub fn from_section(section: &Value) -> Vec<LocationDecl> {
        let Some(locs) = section.get("locations").and_then(Value::as_object) else { return Vec::new() };
        let strings = |v: Option<&Value>| -> Vec<String> {
            v.and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
                .unwrap_or_default()
        };
        locs.iter()
            .map(|(key, l)| LocationDecl {
                key: key.clone(),
                label: l.get("label").and_then(Value::as_str).unwrap_or(key).to_string(),
                required: l.get("required").and_then(Value::as_bool).unwrap_or(true),
                registry: l
                    .get("registry")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(|h| {
                                Some(RegistryHint {
                                    hive: h.get("hive")?.as_str()?.parse().ok()?,
                                    key: h.get("key")?.as_str()?.to_string(),
                                    value: h.get("value")?.as_str()?.to_string(),
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
                defaults: strings(l.get("defaults")),
                validate: strings(l.get("validate")),
            })
            .collect()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CandidateSource {
    Saved,
    Registry,
    Default,
    User,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub source: CandidateSource,
    /// The path as tried (after env expansion), or the registry value name when it was absent.
    pub path: String,
    pub ok: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolution {
    pub key: String,
    pub label: String,
    pub required: bool,
    /// Canonical, simplified path when a candidate passed validation.
    pub path: Option<PathBuf>,
    pub candidates: Vec<Candidate>,
}

/// Checks that `dir` exists and contains everything in `validate` (paths or globs).
/// The error is a sentence for the user: "This folder has no steamapps/libraryfolders.vdf".
pub fn validate(dir: &Path, patterns: &[String]) -> Result<PathBuf, String> {
    if !dir.is_dir() {
        return Err("This folder doesn't exist.".into());
    }
    for pat in patterns {
        let found = if pat.contains(['*', '?']) { !glob(dir, pat).is_empty() } else { dir.join(pat).exists() };
        if !found {
            return Err(if pat.contains(['*', '?']) {
                format!("This folder has no files matching {pat}.")
            } else {
                format!("This folder has no {pat}.")
            });
        }
    }
    canonical(dir).map(|c| simplify(&c)).ok_or_else(|| "This folder can't be opened.".into())
}

/// Runs the resolution chain for one location, stopping at the first valid candidate.
pub fn resolve(decl: &LocationDecl, saved: Option<&str>, registry: &dyn Registry) -> Resolution {
    let mut res = Resolution {
        key: decl.key.clone(),
        label: decl.label.clone(),
        required: decl.required,
        path: None,
        candidates: Vec::new(),
    };
    let try_path =|source: CandidateSource, raw: &str, res: &mut Resolution| -> bool {
        let expanded = platform::expand_env(raw);
        match validate(Path::new(&expanded), &decl.validate) {
            Ok(p) => {
                res.candidates.push(Candidate { source, path: expanded, ok: true, reason: None });
                res.path = Some(p);
                true
            }
            Err(reason) => {
                res.candidates.push(Candidate { source, path: expanded, ok: false, reason: Some(reason) });
                false
            }
        }
    };

    if let Some(s) = saved {
        if try_path(CandidateSource::Saved, s, &mut res) {
            return res;
        }
    }
    for hint in &decl.registry {
        match registry.get(hint.hive, &hint.key, &hint.value) {
            Some(v) => {
                if try_path(CandidateSource::Registry, &v, &mut res) {
                    return res;
                }
            }
            None => res.candidates.push(Candidate {
                source: CandidateSource::Registry,
                path: format!("{}\\{} [{}]", hint.hive, hint.key, hint.value),
                ok: false,
                reason: Some("Registry value not found.".into()),
            }),
        }
    }
    for d in &decl.defaults {
        if try_path(CandidateSource::Default, d, &mut res) {
            return res;
        }
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decl() -> LocationDecl {
        LocationDecl {
            key: "root".into(),
            label: "Steam installation folder".into(),
            required: true,
            registry: vec![RegistryHint { hive: Hive::CurrentUser, key: "Software\\Valve\\Steam".into(), value: "SteamPath".into() }],
            defaults: vec!["%VELLUM_TEST_NO_SUCH_VAR%\\Steam".into()],
            validate: vec!["steamapps/libraryfolders.vdf".into()],
        }
    }

    fn steam_dir() -> tempfile::TempDir {
        let t = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(t.path().join("steamapps")).unwrap();
        std::fs::write(t.path().join("steamapps/libraryfolders.vdf"), "").unwrap();
        t
    }

    #[test]
    fn registry_hint_with_forward_slashes_resolves() {
        let steam = steam_dir();
        let mut reg = FakeRegistry::default();
        reg.set(Hive::CurrentUser, "Software\\Valve\\Steam", "SteamPath", &steam.path().to_string_lossy().replace('\\', "/"));
        let r = resolve(&decl(), None, &reg);
        assert!(r.path.is_some(), "{r:#?}");
        assert_eq!(r.candidates.last().unwrap().source, CandidateSource::Registry);
    }

    #[test]
    fn saved_path_wins_and_stale_saved_path_falls_through() {
        let steam = steam_dir();
        let other = steam_dir();
        let mut reg = FakeRegistry::default();
        reg.set(Hive::CurrentUser, "Software\\Valve\\Steam", "SteamPath", &other.path().to_string_lossy());
        let r = resolve(&decl(), Some(&steam.path().to_string_lossy()), &reg);
        assert_eq!(r.candidates.len(), 1);
        assert_eq!(r.candidates[0].source, CandidateSource::Saved);

        let r = resolve(&decl(), Some("Z:\\renamed\\Steam"), &reg);
        assert!(!r.candidates[0].ok && r.candidates[1].ok);
    }

    #[test]
    fn nothing_found_records_every_attempt_with_reasons() {
        let r = resolve(&decl(), None, &FakeRegistry::default());
        assert!(r.path.is_none());
        assert_eq!(r.candidates.len(), 2);
        assert_eq!(r.candidates[0].reason.as_deref(), Some("Registry value not found."));
        assert_eq!(r.candidates[1].reason.as_deref(), Some("This folder doesn't exist."));
    }

    #[test]
    fn validation_messages_name_the_missing_file() {
        let t = tempfile::tempdir().unwrap();
        assert_eq!(
            validate(t.path(), &["steamapps/libraryfolders.vdf".into()]).unwrap_err(),
            "This folder has no steamapps/libraryfolders.vdf."
        );
        assert_eq!(validate(t.path(), &["*.item".into()]).unwrap_err(), "This folder has no files matching *.item.");
        std::fs::write(t.path().join("a.item"), "").unwrap();
        assert!(validate(t.path(), &["*.item".into()]).is_ok());
    }

    #[test]
    fn fake_registry_subkeys() {
        let mut reg = FakeRegistry::default();
        reg.set(Hive::LocalMachine, "SOFTWARE\\GOG.com\\Games\\111", "path", "x");
        reg.set(Hive::LocalMachine, "SOFTWARE\\GOG.com\\Games\\222", "path", "y");
        assert_eq!(reg.subkeys(Hive::LocalMachine, "software\\gog.com\\games"), ["111", "222"]);
    }
}
