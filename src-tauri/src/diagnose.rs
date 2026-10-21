//! `"Vellum Game Launcher.exe" --diagnose --out report.json`: a shareable report confirming store formats on
//! a real machine. It contains structure only: which location candidates were tried, folder
//! layouts as name patterns and counts, and for each file format the keys and value types.
//! No values, titles or account ids. Denylisted files are never opened.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use crate::paths::AppPaths;
use crate::plugins::{self, PluginKind};
use crate::providers::locations::{self, Registry};
use crate::providers::model::ProviderSpec;
use crate::providers::scope::Scope;
use crate::userdata::settings;

/// Replaces anything identifying in a file or folder name: digit runs become `<n>` and long
/// hex runs become `<hash>`. `appmanifest_620.acf` → `appmanifest_<n>.acf`.
pub fn name_pattern(name: &str) -> String {
    let mut out = String::new();
    let chars: Vec<char> = name.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let hex_len = chars[i..].iter().take_while(|c| c.is_ascii_hexdigit()).count();
        let digit_len = chars[i..].iter().take_while(|c| c.is_ascii_digit()).count();
        if hex_len >= 16 && chars[i..i + hex_len].iter().any(|c| c.is_ascii_alphabetic()) {
            out.push_str("<hash>");
            i += hex_len;
        } else if digit_len >= 1 {
            out.push_str("<n>");
            i += digit_len;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

/// Keys that carry ids (`"620"`, `user-collections.uc-abc`) are reduced to patterns too.
fn key_pattern(key: &str) -> String {
    if let Some((prefix, _)) = key.split_once('.') {
        return format!("{prefix}.<id>");
    }
    name_pattern(key)
}

/// The structure of a JSON value: keys and value types, never values.
pub fn shape(v: &Value) -> Value {
    match v {
        Value::Object(m) => {
            let mut out = Map::new();
            for (k, val) in m {
                let k = key_pattern(k);
                let s = shape(val);
                let merged = match out.remove(&k) {
                    Some(prev) => merge(prev, s),
                    None => s,
                };
                out.insert(k, merged);
            }
            Value::Object(out)
        }
        Value::Array(a) => {
            let elems = a.iter().map(shape).reduce(merge);
            Value::Array(elems.into_iter().collect())
        }
        Value::String(s) => {
            let t = s.trim();
            if (t.starts_with('{') || t.starts_with('[')) && serde_json::from_str::<Value>(t).is_ok() {
                json!({ "$jsonString": shape(&serde_json::from_str::<Value>(t).unwrap()) })
            } else if !t.is_empty() && t.parse::<i64>().is_ok() {
                json!("numeric-string")
            } else {
                json!("string")
            }
        }
        Value::Number(_) => json!("number"),
        Value::Bool(_) => json!("bool"),
        Value::Null => json!("null"),
    }
}

fn merge(a: Value, b: Value) -> Value {
    match (a, b) {
        (Value::Object(mut x), Value::Object(y)) => {
            for (k, v) in y {
                let merged = match x.remove(&k) {
                    Some(prev) => merge(prev, v),
                    None => v,
                };
                x.insert(k, merged);
            }
            Value::Object(x)
        }
        (Value::Array(x), Value::Array(y)) => Value::Array(x.into_iter().chain(y).reduce(merge).into_iter().collect()),
        (a, b) if a == b => a,
        (Value::String(x), Value::String(y)) => {
            let mut parts: Vec<&str> = x.split('|').chain(y.split('|')).collect();
            parts.sort();
            parts.dedup();
            json!(parts.join("|"))
        }
        _ => json!("mixed"),
    }
}

/// Replaces the user's profile folder so paths don't reveal the Windows user name.
fn sanitize_path(p: &str) -> String {
    if let Some(home) = dirs::home_dir() {
        let home = home.to_string_lossy().replace('/', "\\");
        let norm = p.replace('/', "\\");
        if norm.to_lowercase().starts_with(&home.to_lowercase()) {
            return format!("%USERPROFILE%{}", &norm[home.len()..]);
        }
    }
    p.to_string()
}

fn count_patterns(dir: &Path, scope: &Scope) -> BTreeMap<String, u64> {
    let mut counts = BTreeMap::new();
    for e in std::fs::read_dir(dir).into_iter().flatten().filter_map(Result::ok) {
        if scope.is_denied(&e.path()) {
            continue;
        }
        let suffix = if e.path().is_dir() { "/" } else { "" };
        *counts.entry(format!("{}{suffix}", name_pattern(&e.file_name().to_string_lossy()))).or_default() += 1;
    }
    counts
}

fn read_vdf(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    crate::formats::vdf::parse(&text).ok()
}

fn steam_probe(root: &Path, scope: &Scope, summary: &mut Vec<String>) -> Value {
    let mut out = Map::new();

    // Library folders.
    let lf_path = root.join("steamapps").join("libraryfolders.vdf");
    let lf = read_vdf(&lf_path);
    let mut libraries: Vec<PathBuf> = vec![root.to_path_buf()];
    if let Some(doc) = &lf {
        out.insert("libraryfoldersShape".into(), shape(doc));
        let listed = doc.get("libraryfolders").and_then(Value::as_object).cloned().unwrap_or_default();
        for v in listed.values() {
            let p = v.as_str().or_else(|| v.get("path").and_then(Value::as_str));
            if let Some(p) = p {
                let pb = PathBuf::from(p);
                let dup = libraries.iter().any(|l| l.canonicalize().ok() == pb.canonicalize().ok() && pb.exists());
                if !dup {
                    libraries.push(pb);
                }
            }
        }
    } else {
        out.insert("libraryfoldersShape".into(), json!("unreadable"));
    }

    let mut acf_shape: Option<Value> = None;
    let (mut acf_files, mut acf_failed, mut installed) = (0u64, 0u64, 0u64);
    let mut libs = Vec::new();
    for (i, lib) in libraries.iter().enumerate() {
        let steamapps = lib.join("steamapps");
        let exists = steamapps.is_dir();
        let mut info = json!({ "name": format!("<library-{}>", i + 1), "isInstallFolder": i == 0, "available": exists });
        if exists {
            let mut manifests = 0;
            for m in crate::providers::scope::glob(&steamapps, "appmanifest_*.acf") {
                manifests += 1;
                acf_files += 1;
                match read_vdf(&m) {
                    Some(doc) => {
                        let state = doc.get("AppState").cloned().unwrap_or(Value::Null);
                        let flags = state.get("StateFlags").and_then(Value::as_str).and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
                        if flags & 4 != 0 {
                            installed += 1;
                        }
                        let s = shape(&state);
                        acf_shape = Some(match acf_shape.take() {
                            Some(prev) => merge(prev, s),
                            None => s,
                        });
                    }
                    None => acf_failed += 1,
                }
            }
            let common = std::fs::read_dir(steamapps.join("common")).map(|rd| rd.count()).unwrap_or(0);
            info["appmanifestFiles"] = json!(manifests);
            info["commonFolders"] = json!(common);
            info["steamappsLayout"] = json!(count_patterns(&steamapps, scope));
        }
        libs.push(info);
    }
    out.insert("libraries".into(), Value::Array(libs));
    out.insert(
        "appmanifest".into(),
        json!({ "files": acf_files, "unreadable": acf_failed, "fullyInstalled": installed, "appStateShape": acf_shape }),
    );
    summary.push(format!(
        "steam: {} library folder(s), {} app manifest(s), {} fully installed, {} unreadable",
        libraries.len(),
        acf_files,
        installed,
        acf_failed
    ));

    // Accounts: folder names replaced; only safe files are opened.
    let userdata = root.join("userdata");
    let mut accounts: Vec<PathBuf> = std::fs::read_dir(&userdata)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|e| e.path().is_dir() && e.file_name().to_string_lossy().chars().all(|c| c.is_ascii_digit()))
        .map(|e| e.path())
        .collect();
    accounts.sort();
    let mut acc = Vec::new();
    for (i, a) in accounts.iter().enumerate() {
        let config = a.join("config");
        let localconfig = std::fs::metadata(config.join("localconfig.vdf")).map(|m| m.len()).ok();
        let cloud = config.join("cloudstorage").join("cloud-storage-namespace-1.json");
        let cloud_info = match std::fs::read(&cloud).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()) {
            Some(Value::Array(pairs)) => {
                let mut keys: BTreeMap<String, u64> = BTreeMap::new();
                let mut entry_shape: Option<Value> = None;
                let (mut deleted, mut dynamic) = (0u64, 0u64);
                for p in &pairs {
                    let Some(k) = p.get(0).and_then(Value::as_str) else { continue };
                    *keys.entry(key_pattern(k)).or_default() += 1;
                    if let Some(e) = p.get(1) {
                        if e.get("is_deleted").and_then(Value::as_bool) == Some(true) {
                            deleted += 1;
                        }
                        if e.get("value").and_then(Value::as_str).is_some_and(|v| v.contains("\"filterSpec\"")) {
                            dynamic += 1;
                        }
                        let s = shape(e);
                        entry_shape = Some(match entry_shape.take() {
                            Some(prev) => merge(prev, s),
                            None => s,
                        });
                    }
                }
                json!({ "present": true, "entries": pairs.len(), "keyPatterns": keys, "deleted": deleted, "dynamic": dynamic, "entryShape": entry_shape })
            }
            Some(_) => json!({ "present": true, "error": "not a JSON array" }),
            None if cloud.exists() => json!({ "present": true, "error": "unreadable" }),
            None => json!({ "present": false }),
        };
        let grid = config.join("grid");
        acc.push(json!({
            "name": format!("<account-{}>", i + 1),
            "localconfigBytes": localconfig,
            "cloudStorage": cloud_info,
            "grid": if grid.is_dir() { json!(count_patterns(&grid, scope)) } else { Value::Null },
        }));
    }
    summary.push(format!("steam: {} account folder(s)", accounts.len()));
    out.insert("accounts".into(), Value::Array(acc));

    // Art cache layouts: flat `<appid>_library_600x900.jpg` and per-app folders.
    let cache = root.join("appcache").join("librarycache");
    if cache.is_dir() {
        let mut flat = BTreeMap::new();
        let mut nested: BTreeMap<String, u64> = BTreeMap::new();
        let mut app_folders = 0u64;
        for e in std::fs::read_dir(&cache).into_iter().flatten().filter_map(Result::ok) {
            let p = e.path();
            if p.is_dir() {
                app_folders += 1;
                for f in crate::providers::scope::glob(&p, "**/*") {
                    if f.is_file() {
                        let rel = f.strip_prefix(&p).unwrap_or(&f).to_string_lossy().replace('\\', "/");
                        let pattern: Vec<String> = rel.split('/').map(name_pattern).collect();
                        *nested.entry(pattern.join("/")).or_default() += 1;
                    }
                }
            } else {
                *flat.entry(name_pattern(&e.file_name().to_string_lossy())).or_insert(0u64) += 1;
            }
        }
        summary.push(format!("steam: art cache has {} flat file pattern(s) and {} per-app folder(s)", flat.len(), app_folders));
        out.insert("librarycache".into(), json!({ "flatFiles": flat, "appFolders": app_folders, "nestedFiles": nested }));
    } else {
        out.insert("librarycache".into(), json!(null));
    }
    Value::Object(out)
}

fn epic_probe(manifests: &Path, summary: &mut Vec<String>) -> Value {
    let mut item_shape: Option<Value> = None;
    let (mut files, mut bad) = (0u64, 0u64);
    for f in crate::providers::scope::glob(manifests, "*.item") {
        files += 1;
        match std::fs::read(&f).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()) {
            Some(v) => {
                let s = shape(&v);
                item_shape = Some(match item_shape.take() {
                    Some(prev) => merge(prev, s),
                    None => s,
                });
            }
            None => bad += 1,
        }
    }
    summary.push(format!("epic: {files} .item manifest(s), {bad} unreadable"));
    json!({ "itemFiles": files, "unreadable": bad, "itemShape": item_shape })
}

/// Builds the report. Never writes anything except the caller's output file.
pub fn report(paths: &AppPaths, registry: &dyn Registry) -> (Value, Vec<String>) {
    let saved = settings::load(&paths.data_dir.join("settings.json"), std::fs::read(paths.data_dir.join("settings.json")).ok());
    let mut summary = Vec::new();
    let mut providers = Vec::new();
    for rec in plugins::discover(std::slice::from_ref(&paths.plugins_dir)) {
        if rec.kind != PluginKind::Provider || !rec.is_valid() {
            continue;
        }
        let Some(spec) = ProviderSpec::from_record(&rec, &Map::new()) else { continue };
        let saved_locs = saved.plugins.providers.get(&spec.id).map(|e| e.locations.clone()).unwrap_or_default();
        let mut locs = Vec::new();
        let mut found = BTreeMap::new();
        for decl in &spec.locations {
            let r = locations::resolve(decl, saved_locs.get(&decl.key).map(String::as_str), registry);
            let candidates: Vec<Value> = r
                .candidates
                .iter()
                .map(|c| json!({ "source": c.source, "path": sanitize_path(&c.path), "ok": c.ok, "reason": c.reason }))
                .collect();
            summary.push(format!(
                "{}: location \"{}\" {}",
                spec.id,
                decl.key,
                match r.candidates.iter().find(|c| c.ok) {
                    Some(c) => format!("found via {:?}", c.source).to_lowercase(),
                    None => format!("NOT found after {} candidate(s)", r.candidates.len()),
                }
            ));
            locs.push(json!({ "key": decl.key, "label": decl.label, "required": decl.required, "found": r.path.is_some(), "candidates": candidates }));
            if let Some(p) = r.path {
                found.insert(decl.key.clone(), p);
            }
        }
        let scope = Scope::new(found.values().cloned(), &spec.deny_files);
        let probe = match (spec.id.as_str(), found.get("root"), found.get("manifests")) {
            ("steam", Some(root), _) => steam_probe(root, &scope, &mut summary),
            ("epic", _, Some(m)) => epic_probe(m, &mut summary),
            _ => Value::Null,
        };
        providers.push(json!({ "id": spec.id, "version": rec.version, "locations": locs, "probe": probe }));
    }
    let report = json!({
        "tool": format!("{} --diagnose", crate::APP_NAME),
        "version": crate::APP_VERSION,
        "generatedAt": crate::util::now_iso(),
        "note": "Structure only: names are reduced to patterns, account folders to <account-n>, file contents to key/type shapes. Review before sharing.",
        "providers": providers,
        "summary": summary,
    });
    (report, summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_lose_ids_and_hashes() {
        assert_eq!(name_pattern("appmanifest_620.acf"), "appmanifest_<n>.acf");
        assert_eq!(name_pattern("413150_library_600x900.jpg"), "<n>_library_<n>x<n>.jpg");
        assert_eq!(name_pattern("0a1b2c3d4e5f60718293a4b5c6d7e8f9.jpg"), "<hash>.jpg");
        assert_eq!(name_pattern("libraryfolders.vdf"), "libraryfolders.vdf");
        assert_eq!(key_pattern("user-collections.uc-x1"), "user-collections.<id>");
    }

    #[test]
    fn shapes_have_no_values() {
        let v = json!({
            "AppState": { "appid": "620", "name": "Portal 2", "InstalledDepots": { "621": { "manifest": "1" }, "622": { "manifest": "2", "size": "3" } } },
            "list": [1, "x"],
            "nested": "{\"id\":\"favorite\",\"added\":[620]}"
        });
        let s = shape(&v);
        let text = s.to_string();
        assert!(!text.contains("Portal") && !text.contains("620"), "{text}");
        assert_eq!(s["AppState"]["appid"], "numeric-string");
        assert_eq!(s["AppState"]["InstalledDepots"]["<n>"], json!({ "manifest": "numeric-string", "size": "numeric-string" }));
        assert_eq!(s["list"], json!(["number|string"]));
        assert_eq!(s["nested"]["$jsonString"]["added"], json!(["number"]));
    }
}
