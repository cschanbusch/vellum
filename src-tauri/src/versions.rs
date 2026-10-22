//! Version management: installing Vellum releases from GitHub side by side, and switching
//! between them.
//!
//! A managed install looks like this:
//!
//! ```text
//! Vellum/
//!   Vellum Game Launcher.exe     the starter (../starter): launches the active version
//!   active.json                  { active, previous, trial, failedStarts, rolledBackFrom }
//!   versions/<version>/          Vellum Game Launcher.exe, plugins/, licences
//!   plugins/                     the user's own plugins, shared by every version
//!   data/                        when portable.flag sits beside the starter
//! ```
//!
//! Release zips use that same layout, so the updater takes `Vellum/versions/<version>/` out of
//! a release's core zip (and extras zip) and nothing else. Activating a version writes
//! `active.json` with `trial: true` and restarts through the starter. The starter counts failed
//! starts and falls back to the previous version after two; a version that reaches its window
//! confirms itself (`confirm_start`).
//!
//! Downloads are checked against the SHA-256 digest GitHub publishes for each asset. There is
//! no signing: the GitHub account is the trust anchor, and nothing installs unless the user asks.

use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::APP_VERSION;

pub const ACTIVE_FILE: &str = "active.json";
pub const VERSIONS_DIR: &str = "versions";
pub const EXE_NAME: &str = "Vellum Game Launcher.exe";
/// The GitHub repository releases come from.
pub const REPO: &str = "cschanbusch/vellum";
/// The first release laid out for version management. Older releases can't be installed here.
pub const FIRST_MANAGED: (u64, u64, u64) = (0, 2, 0);
/// Data backups kept before switching versions.
const BACKUPS_KEPT: usize = 5;

/// The install root, when `exe_dir` is `<root>/versions/<version>` and the root has active.json.
pub fn managed_root(exe_dir: &Path) -> Option<PathBuf> {
    let parent = exe_dir.parent()?;
    if !parent.file_name()?.eq_ignore_ascii_case(VERSIONS_DIR) {
        return None;
    }
    let root = parent.parent()?;
    root.join(ACTIVE_FILE).is_file().then(|| root.to_path_buf())
}

// ---- active.json ------------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Active {
    pub active: String,
    pub previous: Option<String>,
    /// Set when a version is activated; cleared once it starts successfully.
    pub trial: bool,
    /// Starts of a trial version that never confirmed (counted by the starter).
    pub failed_starts: u32,
    /// Set by the starter when it fell back from a version that wouldn't start.
    pub rolled_back_from: Option<String>,
}

pub fn read_active(root: &Path) -> Option<Active> {
    let text = fs::read_to_string(root.join(ACTIVE_FILE)).ok()?;
    serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()
}

fn write_active(root: &Path, a: &Active) -> io::Result<()> {
    let tmp = root.join(format!("{ACTIVE_FILE}.tmp"));
    fs::write(&tmp, serde_json::to_vec_pretty(a).unwrap())?;
    fs::rename(&tmp, root.join(ACTIVE_FILE))
}

/// Which installed version this process is: its folder's name in a managed install (the folder
/// is what active.json names), else the built-in version.
pub fn running_version(exe_dir: &Path) -> String {
    managed_root(exe_dir)
        .and(exe_dir.file_name())
        .and_then(|n| n.to_str())
        .map(str::to_string)
        .unwrap_or_else(|| APP_VERSION.to_string())
}

/// The running version reached its window: it is no longer on trial.
pub fn confirm_start(root: &Path, running: &str) {
    let Some(mut a) = read_active(root) else { return };
    if a.active == running && (a.trial || a.failed_starts > 0) {
        a.trial = false;
        a.failed_starts = 0;
        if let Err(e) = write_active(root, &a) {
            tracing::warn!(error = %e, "could not confirm this version in active.json");
        }
    }
}

// ---- versions ---------------------------------------------------------------------------------

/// `"v0.2.0"`, `"0.2.0-beta.1"` → ((0, 2, 0), Some("beta.1")).
pub fn parse_version(s: &str) -> Option<((u64, u64, u64), Option<String>)> {
    let s = s.trim().trim_start_matches(['v', 'V']);
    let (core, pre) = match s.split_once('-') {
        Some((c, p)) => (c, Some(p.to_string())),
        None => (s, None),
    };
    let mut it = core.split('.').map(|n| n.parse::<u64>().ok());
    let v = (it.next()??, it.next().flatten().unwrap_or(0), it.next().flatten().unwrap_or(0));
    Some((v, pre))
}

/// Newest first; a release beats its own pre-releases.
fn version_order(a: &str, b: &str) -> std::cmp::Ordering {
    let key = |s: &str| parse_version(s).map(|(v, pre)| (v, pre.is_none(), pre));
    key(b).cmp(&key(a))
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InstallRecord {
    pub tag: String,
    pub extras: bool,
    pub installed_at: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    pub version: String,
    pub extras: bool,
    pub installed_at: Option<String>,
    pub size_bytes: u64,
}

fn dir_size(p: &Path) -> u64 {
    let Ok(rd) = fs::read_dir(p) else { return 0 };
    rd.flatten()
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => dir_size(&e.path()),
            Ok(_) => e.metadata().map(|m| m.len()).unwrap_or(0),
            Err(_) => 0,
        })
        .sum()
}

pub fn installed(root: &Path) -> Vec<Installed> {
    let mut out: Vec<Installed> = fs::read_dir(root.join(VERSIONS_DIR))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().join(EXE_NAME).is_file())
        .filter_map(|e| {
            let version = e.file_name().to_str()?.to_string();
            let rec: Option<InstallRecord> = fs::read_to_string(e.path().join(".install.json")).ok().and_then(|t| serde_json::from_str(&t).ok());
            Some(Installed {
                extras: rec.as_ref().map(|r| r.extras).unwrap_or_else(|| e.path().join("plugins").join("skins").join("synthwave").is_dir()),
                installed_at: rec.map(|r| r.installed_at),
                size_bytes: dir_size(&e.path()),
                version,
            })
        })
        .collect();
    out.sort_by(|a, b| version_order(&a.version, &b.version));
    out
}

// ---- GitHub releases --------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub name: String,
    pub size: u64,
    /// The API URL; downloads it with `Accept: application/octet-stream` (works for private repos
    /// with a token, too).
    pub api_url: String,
    /// `sha256:<hex>`, when GitHub provides it.
    pub digest: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    pub tag: String,
    pub version: String,
    pub name: String,
    pub prerelease: bool,
    pub published_at: Option<String>,
    pub notes: String,
    pub url: String,
    pub core: Option<Asset>,
    pub extras: Option<Asset>,
    /// Why it can't be installed here, if it can't.
    pub unavailable: Option<String>,
}

#[derive(Deserialize)]
struct GhAsset {
    name: String,
    size: u64,
    url: String,
    #[serde(default)]
    digest: Option<String>,
}

#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    body: Option<String>,
    html_url: String,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

/// Where releases are read from: GitHub's API, or a test server (`VELLUM_RELEASES_API`).
fn api_base() -> String {
    std::env::var("VELLUM_RELEASES_API").unwrap_or_else(|_| format!("https://api.github.com/repos/{REPO}"))
}

pub(crate) fn request(url: &str, accept: &str) -> ureq::RequestBuilder<ureq::typestate::WithoutBody> {
    let mut req = ureq::get(url)
        .header("User-Agent", concat!("Vellum-Game-Launcher/", env!("CARGO_PKG_VERSION")))
        .header("Accept", accept)
        .header("X-GitHub-Api-Version", "2022-11-28");
    // For trying this against a private repository; never needed once it is public.
    if let Ok(token) = std::env::var("VELLUM_GITHUB_TOKEN") {
        if !token.trim().is_empty() {
            req = req.header("Authorization", format!("Bearer {}", token.trim()));
        }
    }
    req
}

fn to_release(r: GhRelease) -> Option<Release> {
    if r.draft {
        return None;
    }
    let (v, _) = parse_version(&r.tag_name)?;
    let version = r.tag_name.trim_start_matches(['v', 'V']).to_string();
    let pick = |suffix: &str| {
        r.assets.iter().find(|a| a.name.ends_with(suffix)).map(|a| Asset {
            name: a.name.clone(),
            size: a.size,
            api_url: a.url.clone(),
            digest: a.digest.clone(),
        })
    };
    let core = pick("-windows-x64.zip");
    let extras = pick("-extras.zip");
    let unavailable = if v < FIRST_MANAGED {
        Some("This release predates version management; download it from GitHub instead.".into())
    } else if core.is_none() {
        Some("This release has no Windows download.".into())
    } else {
        None
    };
    Some(Release {
        name: r.name.filter(|n| !n.trim().is_empty()).unwrap_or_else(|| r.tag_name.clone()),
        tag: r.tag_name,
        version,
        prerelease: r.prerelease,
        published_at: r.published_at,
        notes: r.body.unwrap_or_default(),
        url: r.html_url,
        core,
        extras,
        unavailable,
    })
}

static RELEASES: Mutex<Option<Vec<Release>>> = Mutex::new(None);

/// The repository's releases, newest first (cached for the session after a successful fetch).
pub fn fetch_releases() -> Result<Vec<Release>, String> {
    let url = format!("{}/releases?per_page=50", api_base());
    let mut resp = request(&url, "application/vnd.github+json").call().map_err(|e| match e {
        ureq::Error::StatusCode(404) => "No releases found. If the repository is private, set VELLUM_GITHUB_TOKEN.".to_string(),
        ureq::Error::StatusCode(403) => "GitHub's rate limit was reached; try again in an hour.".to_string(),
        e => format!("Couldn't reach GitHub: {e}"),
    })?;
    let bytes = resp.body_mut().with_config().limit(16 * 1024 * 1024).read_to_vec().map_err(|e| format!("Couldn't read GitHub's reply: {e}"))?;
    let list: Vec<GhRelease> = serde_json::from_slice(&bytes).map_err(|e| format!("Unexpected reply from GitHub: {e}"))?;
    let mut out: Vec<Release> = list.into_iter().filter_map(to_release).collect();
    out.sort_by(|a, b| version_order(&a.version, &b.version));
    *RELEASES.lock().unwrap() = Some(out.clone());
    Ok(out)
}

fn cached_release(tag: &str) -> Result<Release, String> {
    if let Some(r) = RELEASES.lock().unwrap().as_ref().and_then(|l| l.iter().find(|r| r.tag == tag).cloned()) {
        return Ok(r);
    }
    fetch_releases()?.into_iter().find(|r| r.tag == tag).ok_or_else(|| format!("Release {tag} not found."))
}

// ---- installing -------------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub tag: String,
    /// "download", "extract" or "done".
    pub phase: &'static str,
    pub file: String,
    pub done: u64,
    pub total: u64,
}

/// Downloads `asset` to `dest`, checking GitHub's SHA-256 digest when there is one.
fn download(asset: &Asset, dest: &Path, progress: impl FnMut(u64, u64)) -> Result<(), String> {
    let want = asset.digest.as_deref().and_then(|d| d.strip_prefix("sha256:"));
    download_to(&asset.api_url, "application/octet-stream", &asset.name, asset.size, want, dest, progress)
}

/// Downloads `url` to `dest`, checking the size (when known) and the SHA-256 (when given).
pub(crate) fn download_to(url: &str, accept: &str, name: &str, size: u64, sha256: Option<&str>, dest: &Path, mut progress: impl FnMut(u64, u64)) -> Result<(), String> {
    let asset = Asset { name: name.into(), size, api_url: url.into(), digest: sha256.map(|d| format!("sha256:{d}")) };
    let mut resp = request(url, accept).call().map_err(|e| format!("Download of {name} failed: {e}"))?;
    let mut reader = resp.body_mut().with_config().limit(u64::MAX).reader();
    let mut file = File::create(dest).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    let mut done = 0u64;
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("Download of {} failed: {e}", asset.name))?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        done += n as u64;
        progress(done, asset.size);
    }
    file.flush().map_err(|e| e.to_string())?;
    if asset.size > 0 && done != asset.size {
        return Err(format!("{} was cut short ({done} of {} bytes).", asset.name, asset.size));
    }
    if let Some(want) = asset.digest.as_deref().and_then(|d| d.strip_prefix("sha256:")) {
        let got: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
        if !got.eq_ignore_ascii_case(want) {
            return Err(format!("{} doesn't match the checksum GitHub published for it.", asset.name));
        }
    }
    Ok(())
}

/// Extracts `Vellum/versions/<version>/…` from `zip` into `into`. Returns the files written.
fn extract(zip: &Path, version: &str, into: &Path) -> Result<usize, String> {
    let file = File::open(zip).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Not a valid zip: {e}"))?;
    let prefix = PathBuf::from("Vellum").join(VERSIONS_DIR).join(version);
    let mut written = 0;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        // enclosed_name rejects absolute paths and `..`.
        let Some(name) = entry.enclosed_name() else { continue };
        let Ok(rel) = name.strip_prefix(&prefix) else { continue };
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

/// Downloads and installs a release (and its extras, if asked) into `versions/<version>/`,
/// replacing an existing copy of that version. Never touches the running version.
pub fn install(root: &Path, running: &str, tag: &str, with_extras: bool, mut progress: impl FnMut(Progress)) -> Result<Installed, String> {
    let rel = cached_release(tag)?;
    if let Some(why) = &rel.unavailable {
        return Err(why.clone());
    }
    if rel.version == running {
        return Err("This is the version that's running. Switch to another version to download it again.".into());
    }
    let versions = root.join(VERSIONS_DIR);
    let work = versions.join(".download");
    let _ = fs::remove_dir_all(&work);
    fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let staged = work.join(&rel.version);
    let result = (|| {
        let mut assets = vec![rel.core.clone().unwrap()];
        if with_extras {
            assets.extend(rel.extras.clone());
        }
        for asset in &assets {
            let zip = work.join(&asset.name);
            download(asset, &zip, |done, total| {
                progress(Progress { tag: tag.into(), phase: "download", file: asset.name.clone(), done, total })
            })?;
            progress(Progress { tag: tag.into(), phase: "extract", file: asset.name.clone(), done: 0, total: 0 });
            let n = extract(&zip, &rel.version, &staged)?;
            if n == 0 {
                return Err(format!("{} doesn't contain Vellum/versions/{}/.", asset.name, rel.version));
            }
            let _ = fs::remove_file(&zip);
        }
        if !staged.join(EXE_NAME).is_file() {
            return Err(format!("The release doesn't contain {EXE_NAME}."));
        }
        let record = InstallRecord { tag: tag.into(), extras: with_extras && rel.extras.is_some(), installed_at: crate::util::now_iso() };
        fs::write(staged.join(".install.json"), serde_json::to_vec_pretty(&record).unwrap()).map_err(|e| e.to_string())?;
        let dest = versions.join(&rel.version);
        if dest.exists() {
            fs::remove_dir_all(&dest).map_err(|e| format!("Couldn't replace the installed {}: {e}", rel.version))?;
        }
        fs::rename(&staged, &dest).map_err(|e| e.to_string())?;
        Ok(())
    })();
    let _ = fs::remove_dir_all(&work);
    result?;
    progress(Progress { tag: tag.into(), phase: "done", file: String::new(), done: 0, total: 0 });
    installed(root).into_iter().find(|i| i.version == rel.version).ok_or_else(|| "Installed, but not found afterwards.".into())
}

/// Deletes an installed version. The running and the active version can't be removed.
pub fn remove(root: &Path, running: &str, version: &str) -> Result<(), String> {
    if version == running {
        return Err("That's the version that's running.".into());
    }
    if read_active(root).is_some_and(|a| a.active == version) {
        return Err("That's the version Vellum starts with. Switch to another version first.".into());
    }
    if version.is_empty() || version.contains(['/', '\\']) || version.starts_with('.') {
        return Err("Not a version.".into());
    }
    let dir = root.join(VERSIONS_DIR).join(version);
    if !dir.join(EXE_NAME).is_file() {
        return Err(format!("{version} isn't installed."));
    }
    fs::remove_dir_all(&dir).map_err(|e| format!("Couldn't delete {version}: {e}"))?;
    let mut a = read_active(root).unwrap_or_default();
    if a.previous.as_deref() == Some(version) {
        a.previous = None;
        let _ = write_active(root, &a);
    }
    Ok(())
}

/// Makes `version` the one the starter launches, on trial until it starts successfully.
/// Backs up the data folder first. The caller then restarts through the starter.
pub fn activate(root: &Path, running: &str, data_dir: &Path, version: &str) -> Result<(), String> {
    if !root.join(VERSIONS_DIR).join(version).join(EXE_NAME).is_file() {
        return Err(format!("{version} isn't installed."));
    }
    let current = read_active(root).map(|a| a.active).unwrap_or_else(|| running.to_string());
    if let Err(e) = backup_data(data_dir, &current, version) {
        tracing::warn!(error = %e, "data backup before switching versions failed");
    }
    write_active(root, &Active { active: version.into(), previous: Some(current).filter(|c| c != version), trial: true, failed_starts: 0, rolled_back_from: None })
        .map_err(|e| format!("Couldn't write {ACTIVE_FILE}: {e}"))
}

/// Copies the data folder (settings, library, skin data; not caches or logs) to
/// `data/backups/<time> <from> to <to>/`, keeping the newest few.
fn backup_data(data_dir: &Path, from: &str, to: &str) -> io::Result<()> {
    let backups = data_dir.join("backups");
    let stamp = crate::util::now_iso().replace([':', 'T'], "-").chars().take(19).collect::<String>();
    let dest = backups.join(format!("{stamp} {from} to {to}"));
    fn copy(from: &Path, to: &Path, top: bool) -> io::Result<()> {
        fs::create_dir_all(to)?;
        for e in fs::read_dir(from)?.flatten() {
            let name = e.file_name();
            if top && matches!(name.to_str(), Some("cache" | "logs" | "backups" | "EBWebView")) {
                continue;
            }
            let t = e.file_type()?;
            if t.is_dir() {
                copy(&e.path(), &to.join(&name), false)?;
            } else if t.is_file() {
                fs::copy(e.path(), to.join(&name))?;
            }
        }
        Ok(())
    }
    copy(data_dir, &dest, true)?;
    let mut all: Vec<PathBuf> = fs::read_dir(&backups)?.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
    all.sort();
    while all.len() > BACKUPS_KEPT {
        let _ = fs::remove_dir_all(all.remove(0));
    }
    Ok(())
}

// ---- the Versions page ------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionsView {
    /// False when Vellum runs outside a managed install (a dev build, or an old layout).
    pub managed: bool,
    pub running: String,
    pub active: Option<Active>,
    pub installed: Vec<Installed>,
    pub releases: Option<Vec<Release>>,
    pub releases_error: Option<String>,
    pub repo: &'static str,
}

pub fn view(root: Option<&Path>, running: &str, fetch: bool) -> VersionsView {
    let (releases, releases_error) = if fetch {
        match fetch_releases() {
            Ok(r) => (Some(r), None),
            Err(e) => (None, Some(e)),
        }
    } else {
        (RELEASES.lock().unwrap().clone(), None)
    };
    VersionsView {
        managed: root.is_some(),
        running: running.into(),
        active: root.and_then(read_active),
        installed: root.map(installed).unwrap_or_default(),
        releases,
        releases_error,
        repo: REPO,
    }
}

/// Install sizes by version, for tests and logs.
pub fn summary(root: &Path) -> BTreeMap<String, u64> {
    installed(root).into_iter().map(|i| (i.version, i.size_bytes)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_parse_and_order_newest_first() {
        assert_eq!(parse_version("v0.2.0"), Some(((0, 2, 0), None)));
        assert_eq!(parse_version("0.3.1-beta.2"), Some(((0, 3, 1), Some("beta.2".into()))));
        let mut v = vec!["0.2.0", "0.10.0", "0.3.0-beta.1", "0.3.0", "0.1.0"];
        v.sort_by(|a, b| version_order(a, b));
        assert_eq!(v, ["0.10.0", "0.3.0", "0.3.0-beta.1", "0.2.0", "0.1.0"]);
    }

    #[test]
    fn managed_root_needs_versions_folder_and_active_json() {
        let root = tempfile::tempdir().unwrap();
        let exe = root.path().join("versions").join("0.2.0");
        fs::create_dir_all(&exe).unwrap();
        assert_eq!(managed_root(&exe), None);
        fs::write(root.path().join(ACTIVE_FILE), "{}").unwrap();
        assert_eq!(managed_root(&exe).as_deref(), Some(root.path()));
        assert_eq!(managed_root(root.path()), None);
    }

    fn release_zip(path: &Path, version: &str, files: &[(&str, &str)]) {
        let mut z = zip::ZipWriter::new(File::create(path).unwrap());
        let opts: zip::write::SimpleFileOptions = Default::default();
        for (name, body) in files {
            z.start_file(format!("Vellum/versions/{version}/{name}"), opts).unwrap();
            z.write_all(body.as_bytes()).unwrap();
        }
        z.start_file("Vellum/Vellum Game Launcher.exe", opts).unwrap(); // the starter: not taken
        z.write_all(b"starter").unwrap();
        z.finish().unwrap();
    }

    #[test]
    fn extract_takes_only_the_versions_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let zip = tmp.path().join("r.zip");
        release_zip(&zip, "0.3.0", &[(EXE_NAME, "exe"), ("plugins/skins/basis/plugin.json", "{}")]);
        let into = tmp.path().join("out");
        assert_eq!(extract(&zip, "0.3.0", &into).unwrap(), 2);
        assert!(into.join(EXE_NAME).is_file());
        assert!(into.join("plugins/skins/basis/plugin.json").is_file());
        assert_eq!(extract(&zip, "0.4.0", &tmp.path().join("none")).unwrap(), 0);
    }

    #[test]
    fn activate_backs_up_data_and_remove_protects_the_active_version() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        fs::create_dir_all(data.join("cache")).unwrap();
        fs::write(data.join("settings.json"), "{}").unwrap();
        fs::write(data.join("cache").join("big.bin"), "x").unwrap();
        for v in ["0.2.0", "0.3.0"] {
            let d = root.path().join(VERSIONS_DIR).join(v);
            fs::create_dir_all(&d).unwrap();
            fs::write(d.join(EXE_NAME), "").unwrap();
        }
        write_active(root.path(), &Active { active: "0.2.0".into(), ..Default::default() }).unwrap();
        activate(root.path(), "0.2.0", &data, "0.3.0").unwrap();
        let a = read_active(root.path()).unwrap();
        assert_eq!((a.active.as_str(), a.previous.as_deref(), a.trial), ("0.3.0", Some("0.2.0"), true));
        let backup = fs::read_dir(data.join("backups")).unwrap().next().unwrap().unwrap().path();
        assert!(backup.join("settings.json").is_file());
        assert!(!backup.join("cache").exists(), "caches aren't backed up");
        assert!(remove(root.path(), "0.2.0", "0.3.0").is_err(), "the active version can't be removed");
        assert!(remove(root.path(), "0.2.0", "0.2.0").is_err(), "the running version can't be removed");
        remove(root.path(), "0.9.0", "0.2.0").unwrap();
        assert_eq!(read_active(root.path()).unwrap().previous, None);
        assert_eq!(summary(root.path()).keys().collect::<Vec<_>>(), ["0.3.0"]);
    }

    /// A stand-in for GitHub's API: the release list, and the assets by path.
    fn serve(routes: Vec<(String, Vec<u8>)>) -> String {
        use std::io::{BufRead, BufReader};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let path = line.split_whitespace().nth(1).unwrap_or("").to_string();
                loop {
                    let mut h = String::new();
                    if reader.read_line(&mut h).unwrap() <= 2 {
                        break;
                    }
                }
                let body = routes.iter().find(|(p, _)| path.starts_with(p.as_str())).map(|(_, b)| b.clone());
                let mut s = stream;
                match body {
                    Some(b) => {
                        write!(s, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", b.len()).unwrap();
                        s.write_all(&b).unwrap();
                    }
                    None => write!(s, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap(),
                }
            }
        });
        base
    }

    #[test]
    fn install_downloads_checks_and_unpacks_a_release() {
        let tmp = tempfile::tempdir().unwrap();
        let zip = tmp.path().join("core.zip");
        release_zip(&zip, "9.9.0", &[(EXE_NAME, "exe"), ("plugins/providers/steam/plugin.json", "{}")]);
        let bytes = fs::read(&zip).unwrap();
        let digest: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
        let bad = "0".repeat(64);
        // The listing is built after binding, since it holds the server's own URLs.
        let listener_base = {
            let routes = vec![("/assets/core".to_string(), bytes.clone()), ("/assets/bad".to_string(), bytes.clone())];
            serve(routes)
        };
        let list = format!(
            r#"[{{"tag_name":"v9.9.0","html_url":"h","assets":[{{"name":"Vellum-Game-Launcher-9.9.0-windows-x64.zip","size":{n},"url":"{b}/assets/core","digest":"sha256:{digest}"}}]}},
               {{"tag_name":"v9.8.0","html_url":"h","assets":[{{"name":"Vellum-Game-Launcher-9.8.0-windows-x64.zip","size":{n},"url":"{b}/assets/bad","digest":"sha256:{bad}"}}]}}]"#,
            n = bytes.len(),
            b = listener_base
        );
        let api = serve(vec![("/releases".to_string(), list.into_bytes())]);
        std::env::set_var("VELLUM_RELEASES_API", &api);

        let root = tmp.path().join("Vellum");
        fs::create_dir_all(root.join(VERSIONS_DIR)).unwrap();
        let releases = fetch_releases().unwrap();
        assert_eq!(releases.iter().map(|r| r.version.as_str()).collect::<Vec<_>>(), ["9.9.0", "9.8.0"]);
        let mut phases = Vec::new();
        let got = install(&root, "0.1.0", "v9.9.0", false, |p| phases.push(p.phase)).unwrap();
        assert_eq!(got.version, "9.9.0");
        assert!(root.join("versions/9.9.0").join(EXE_NAME).is_file());
        assert!(root.join("versions/9.9.0/plugins/providers/steam/plugin.json").is_file());
        assert!(!root.join("versions/.download").exists());
        assert_eq!(phases.last(), Some(&"done"));
        let err = install(&root, "0.1.0", "v9.8.0", false, |_| {}).unwrap_err();
        assert!(err.contains("checksum"), "{err}");
        assert!(!root.join("versions/9.8.0").exists(), "a bad download installs nothing");
        std::env::remove_var("VELLUM_RELEASES_API");
    }

    #[test]
    fn releases_before_version_management_are_listed_but_not_installable() {
        let gh = |tag: &str| GhRelease {
            tag_name: tag.into(),
            name: None,
            prerelease: false,
            draft: false,
            published_at: None,
            body: None,
            html_url: String::new(),
            assets: vec![GhAsset { name: format!("Vellum-Game-Launcher-{}-windows-x64.zip", &tag[1..]), size: 1, url: "u".into(), digest: None }],
        };
        assert!(to_release(gh("v0.1.0")).unwrap().unavailable.is_some());
        let r = to_release(gh("v0.2.0")).unwrap();
        assert!(r.unavailable.is_none());
        assert_eq!(r.version, "0.2.0");
        assert!(r.extras.is_none());
    }
}
