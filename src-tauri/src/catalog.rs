//! The plugin catalog: plugins published outside Vellum's own releases (the showcase skins, for
//! a start), downloaded and updated from Settings → Get skins.
//!
//! The catalog is one JSON file in the `vellum-skins` repository (`CATALOG_URL`): each plugin with
//! its versions, and for each version a zip on that repository's releases, its size and SHA-256,
//! and what it needs from Vellum. A zip holds one folder named after the plugin's id.
//!
//! Downloads go to the user's plugins folder (`AppPaths::downloaded_plugins_dir`), which is shared
//! by every installed version of Vellum and searched first, so a downloaded skin outlives updates
//! of Vellum and replaces a copy bundled with it. A `.catalog.json` beside the plugin's manifest
//! records the installed version; only plugins carrying it can be removed from here.

use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::plugins::{PluginKind, API_VERSION};
use crate::versions::{self, parse_version};

/// Where the catalog is read from; `VELLUM_CATALOG_URL` points it elsewhere (tests).
pub const CATALOG_URL: &str = "https://raw.githubusercontent.com/cschanbusch/vellum-skins/main/catalog.json";
const MARKER: &str = ".catalog.json";

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub schema: u32,
    #[serde(default)]
    pub plugins: Vec<CatalogPlugin>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CatalogPlugin {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: PluginKind,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub license: Option<String>,
    /// Preview image URL (a release asset).
    #[serde(default)]
    pub preview: Option<String>,
    #[serde(default)]
    pub homepage: Option<String>,
    /// Newest first.
    #[serde(default)]
    pub versions: Vec<CatalogVersion>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CatalogVersion {
    pub version: String,
    /// The plugin API version it was written for (plugin.json `apiVersion`).
    pub api_version: u32,
    /// The oldest Vellum it works with, if it needs more than the API version says.
    #[serde(default)]
    pub min_app: Option<String>,
    pub url: String,
    pub size: u64,
    pub sha256: String,
    #[serde(default)]
    pub published: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct Marker {
    id: String,
    version: String,
    installed_at: String,
}

fn catalog_url() -> String {
    std::env::var("VELLUM_CATALOG_URL").unwrap_or_else(|_| CATALOG_URL.to_string())
}

static CATALOG: Mutex<Option<Catalog>> = Mutex::new(None);

pub fn fetch() -> Result<Catalog, String> {
    let url = catalog_url();
    let mut resp = versions::request(&url, "application/json").call().map_err(|e| format!("Couldn't reach the skin catalog: {e}"))?;
    let bytes = resp.body_mut().with_config().limit(8 * 1024 * 1024).read_to_vec().map_err(|e| format!("Couldn't read the skin catalog: {e}"))?;
    let catalog: Catalog = serde_json::from_slice(&bytes).map_err(|e| format!("The skin catalog isn't valid: {e}"))?;
    if catalog.schema != 1 {
        return Err("The skin catalog needs a newer version of Vellum.".into());
    }
    *CATALOG.lock().unwrap() = Some(catalog.clone());
    Ok(catalog)
}

fn cached_or_fetch() -> Result<Catalog, String> {
    if let Some(c) = CATALOG.lock().unwrap().clone() {
        return Ok(c);
    }
    fetch()
}

/// Why a version can't be used with this Vellum, if it can't.
pub fn incompatible(v: &CatalogVersion, running: &str) -> Option<String> {
    if v.api_version > API_VERSION {
        return Some("Needs a newer version of Vellum.".into());
    }
    if let (Some(min), Some(have)) = (v.min_app.as_deref().and_then(parse_version), parse_version(running)) {
        // A release beats its own pre-releases: 0.2.1-rc.1 doesn't satisfy 0.2.1.
        let key = |(n, pre): ((u64, u64, u64), Option<String>)| (n, pre.is_none(), pre);
        if key(have) < key(min) {
            return Some(format!("Needs Vellum {} or newer.", v.min_app.as_deref().unwrap_or("")));
        }
    }
    None
}

fn kind_dir(kind: PluginKind) -> &'static str {
    match kind {
        PluginKind::Provider => "providers",
        PluginKind::Skin => "skins",
        PluginKind::Module => "modules",
    }
}

fn plugin_dir(root: &Path, kind: PluginKind, id: &str) -> PathBuf {
    root.join(kind_dir(kind)).join(id)
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The version of `id` installed from the catalog, if any.
pub fn installed_version(root: &Path, kind: PluginKind, id: &str) -> Option<String> {
    let text = fs::read_to_string(plugin_dir(root, kind, id).join(MARKER)).ok()?;
    serde_json::from_str::<Marker>(&text).ok().map(|m| m.version)
}

/// Extracts `<id>/…` from `zip` into `into` (`into` becomes the plugin folder).
fn extract(zip: &Path, id: &str, into: &Path) -> Result<usize, String> {
    let mut archive = zip::ZipArchive::new(File::open(zip).map_err(|e| e.to_string())?).map_err(|e| format!("Not a valid zip: {e}"))?;
    let mut written = 0;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let Some(name) = entry.enclosed_name() else { continue };
        let Ok(rel) = name.strip_prefix(id) else { continue };
        if rel.as_os_str().is_empty() {
            continue;
        }
        let out = into.join(rel);
        if entry.is_dir() {
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut f = File::create(&out).map_err(|e| format!("{}: {e}", out.display()))?;
        io::copy(&mut entry, &mut f).map_err(|e| e.to_string())?;
        written += 1;
    }
    Ok(written)
}

/// Downloads and installs `version` of plugin `id` into `root` (replacing what's there).
pub fn install(root: &Path, running: &str, id: &str, version: &str, mut progress: impl FnMut(u64, u64)) -> Result<(), String> {
    if !valid_id(id) {
        return Err("Not a plugin id.".into());
    }
    let catalog = cached_or_fetch()?;
    let plugin = catalog.plugins.iter().find(|p| p.id == id).ok_or_else(|| format!("{id} isn't in the catalog."))?;
    let v = plugin.versions.iter().find(|v| v.version == version).ok_or_else(|| format!("{} {version} isn't in the catalog.", plugin.name))?;
    if let Some(why) = incompatible(v, running) {
        return Err(why);
    }
    let kind_root = root.join(kind_dir(plugin.kind));
    fs::create_dir_all(&kind_root).map_err(|e| e.to_string())?;
    let work = kind_root.join(format!(".download-{id}"));
    let _ = fs::remove_dir_all(&work);
    fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let result = (|| {
        let zip = work.join(format!("{id}-{version}.zip"));
        versions::download_to(&v.url, "application/octet-stream", &format!("{} {version}", plugin.name), v.size, Some(&v.sha256), &zip, &mut progress)?;
        let staged = work.join(id);
        if extract(&zip, id, &staged)? == 0 {
            return Err(format!("The download doesn't contain a {id} folder."));
        }
        // The manifest must be the plugin the catalog says it is.
        let manifest: serde_json::Value = fs::read_to_string(staged.join("plugin.json"))
            .ok()
            .and_then(|t| serde_json::from_str(t.trim_start_matches('\u{feff}')).ok())
            .ok_or("The download has no valid plugin.json.")?;
        if manifest.get("id").and_then(|x| x.as_str()) != Some(id) {
            return Err("The download is a different plugin than the catalog says.".into());
        }
        let marker = Marker { id: id.into(), version: version.into(), installed_at: crate::util::now_iso() };
        fs::write(staged.join(MARKER), serde_json::to_vec_pretty(&marker).unwrap()).map_err(|e| e.to_string())?;
        let dest = kind_root.join(id);
        if dest.exists() {
            fs::remove_dir_all(&dest).map_err(|e| format!("Couldn't replace the installed {}: {e}", plugin.name))?;
        }
        fs::rename(&staged, &dest).map_err(|e| e.to_string())?;
        Ok(())
    })();
    let _ = fs::remove_dir_all(&work);
    result
}

/// Removes a plugin installed from the catalog. Plugins that came with Vellum, or that the user
/// copied in by hand, are left alone.
pub fn remove(root: &Path, kind: PluginKind, id: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err("Not a plugin id.".into());
    }
    let dir = plugin_dir(root, kind, id);
    if !dir.join(MARKER).is_file() {
        return Err("Only plugins downloaded from the catalog can be removed here.".into());
    }
    fs::remove_dir_all(&dir).map_err(|e| format!("Couldn't remove it: {e}"))
}

/// A catalog plugin's preview image as a data: URL (the shell's CSP allows no remote images).
/// Only URLs the catalog lists are fetched.
pub fn preview(url: &str) -> Result<String, String> {
    let listed = CATALOG.lock().unwrap().as_ref().is_some_and(|c| c.plugins.iter().any(|p| p.preview.as_deref() == Some(url)));
    if !listed {
        return Err("Not a catalog preview.".into());
    }
    let mut resp = versions::request(url, "image/*").call().map_err(|e| e.to_string())?;
    let bytes = resp.body_mut().with_config().limit(4 * 1024 * 1024).read_to_vec().map_err(|e| e.to_string())?;
    let mime = if bytes.starts_with(b"\x89PNG") { "image/png" } else if bytes.starts_with(b"RIFF") { "image/webp" } else { "image/jpeg" };
    Ok(format!("data:{mime};base64,{}", crate::util::base64(&bytes)))
}

// ---- the Get skins page -----------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionView {
    #[serde(flatten)]
    pub version: CatalogVersion,
    pub unavailable: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginView {
    pub id: String,
    pub kind: PluginKind,
    pub name: String,
    pub description: String,
    pub author: Option<String>,
    pub license: Option<String>,
    pub preview: Option<String>,
    pub homepage: Option<String>,
    pub versions: Vec<VersionView>,
    /// Installed from the catalog, and which version.
    pub installed: Option<String>,
    /// Present some other way (bundled with Vellum, or copied in by hand), with its version.
    pub present: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogView {
    pub plugins: Vec<PluginView>,
    pub error: Option<String>,
    pub url: String,
}

/// The catalog with what's installed. `present(kind, id)` gives the version of a plugin Vellum
/// found some other way.
pub fn view(root: &Path, running: &str, fetch_now: bool, present: impl Fn(PluginKind, &str) -> Option<String>) -> CatalogView {
    let (catalog, error) = match if fetch_now { fetch() } else { cached_or_fetch() } {
        Ok(c) => (Some(c), None),
        Err(e) => (None, Some(e)),
    };
    let plugins = catalog
        .map(|c| c.plugins)
        .unwrap_or_default()
        .into_iter()
        .filter(|p| valid_id(&p.id))
        .map(|p| {
            let installed = installed_version(root, p.kind, &p.id);
            let present = if installed.is_some() { None } else { present(p.kind, &p.id) };
            PluginView {
                versions: p.versions.into_iter().map(|v| VersionView { unavailable: incompatible(&v, running), version: v }).collect(),
                installed,
                present,
                id: p.id,
                kind: p.kind,
                name: p.name,
                description: p.description,
                author: p.author,
                license: p.license,
                preview: p.preview,
                homepage: p.homepage,
            }
        })
        .collect();
    CatalogView { plugins, error, url: catalog_url() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::io::Write;

    fn version(v: &str, api: u32, min: Option<&str>) -> CatalogVersion {
        CatalogVersion { version: v.into(), api_version: api, min_app: min.map(Into::into), url: String::new(), size: 0, sha256: String::new(), published: None, notes: None }
    }

    #[test]
    fn compatibility() {
        assert!(incompatible(&version("1.0.0", 1, None), "0.2.0").is_none());
        assert!(incompatible(&version("1.0.0", API_VERSION + 1, None), "0.2.0").is_some());
        assert!(incompatible(&version("1.0.0", 1, Some("0.2.1")), "0.2.0").is_some());
        assert!(incompatible(&version("1.0.0", 1, Some("0.2.1")), "0.2.1-rc.1").is_some());
        assert!(incompatible(&version("1.0.0", 1, Some("0.2.1")), "0.2.1").is_none());
        assert!(incompatible(&version("1.0.0", 1, Some("0.2.1")), "0.3.0").is_none());
    }

    #[test]
    fn install_checks_the_download_and_removal_spares_bundled_plugins() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("frontier.zip");
        {
            let mut z = zip::ZipWriter::new(File::create(&zip_path).unwrap());
            let o: zip::write::SimpleFileOptions = Default::default();
            z.start_file("frontier/plugin.json", o).unwrap();
            z.write_all(br#"{"id":"frontier","type":"skin"}"#).unwrap();
            z.start_file("frontier/skin.css", o).unwrap();
            z.write_all(b"body{}").unwrap();
            z.finish().unwrap();
        }
        let bytes = fs::read(&zip_path).unwrap();
        let sha: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let catalog = format!(
            r#"{{"schema":1,"plugins":[{{"id":"frontier","type":"skin","name":"Frontier","versions":[
               {{"version":"1.3.0","apiVersion":1,"url":"{base}/z","size":{n},"sha256":"{sha}"}},
               {{"version":"1.2.0","apiVersion":1,"url":"{base}/z","size":{n},"sha256":"{bad}"}}]}}]}}"#,
            n = bytes.len(),
            bad = "0".repeat(64)
        );
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            for stream in listener.incoming().flatten() {
                let mut r = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                r.read_line(&mut line).unwrap();
                loop {
                    let mut h = String::new();
                    if r.read_line(&mut h).unwrap() <= 2 {
                        break;
                    }
                }
                let body = if line.contains("/catalog") { catalog.clone().into_bytes() } else { bytes.clone() };
                let mut s = stream;
                write!(s, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).unwrap();
                s.write_all(&body).unwrap();
            }
        });
        std::env::set_var("VELLUM_CATALOG_URL", format!("{base}/catalog.json"));
        let root = tmp.path().join("plugins");
        let v = view(&root, "0.2.1", true, |_, _| None);
        assert_eq!(v.plugins[0].versions.len(), 2);
        install(&root, "0.2.1", "frontier", "1.3.0", |_, _| {}).unwrap();
        assert!(root.join("skins/frontier/skin.css").is_file());
        assert_eq!(installed_version(&root, PluginKind::Skin, "frontier").as_deref(), Some("1.3.0"));
        let err = install(&root, "0.2.1", "frontier", "1.2.0", |_, _| {}).unwrap_err();
        assert!(err.contains("checksum"), "{err}");
        assert_eq!(installed_version(&root, PluginKind::Skin, "frontier").as_deref(), Some("1.3.0"), "a bad download leaves the installed one");
        // A plugin that didn't come from the catalog can't be removed from here.
        fs::create_dir_all(root.join("skins/basis")).unwrap();
        assert!(remove(&root, PluginKind::Skin, "basis").is_err());
        remove(&root, PluginKind::Skin, "frontier").unwrap();
        assert!(!root.join("skins/frontier").exists());
        std::env::remove_var("VELLUM_CATALOG_URL");
    }
}
