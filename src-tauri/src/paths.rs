use std::path::{Path, PathBuf};

use crate::cli::Args;
use crate::APP_NAME;

pub const PORTABLE_FLAG: &str = "portable.flag";

/// Where everything lives on disk for this run.
#[derive(Debug, Clone)]
pub struct AppPaths {
    pub exe_dir: PathBuf,
    pub data_dir: PathBuf,
    pub portable: bool,
    pub plugins_dir: PathBuf,
    /// The repo's `extras/` folder (optional skins, modules and the mock provider). Debug builds
    /// running from the repo scan it beside `plugins/`; a package copies extras into `plugins/`.
    pub extras_dir: Option<PathBuf>,
    /// Debug builds also scan `tests/fixtures/dev-plugins` so broken example plugins
    /// show up in the Plugins page without ever being shipped.
    pub dev_plugins_dir: Option<PathBuf>,
    /// The install root when this is a managed version (`<root>/versions/<version>/` with
    /// `<root>/active.json`); see versions.rs. Data, `portable.flag` and the user's own plugins
    /// then live at the root, shared by every version.
    pub version_root: Option<PathBuf>,
    /// `<root>/plugins`: plugins the user added, shared by every installed version.
    pub shared_plugins_dir: Option<PathBuf>,
}

impl AppPaths {
    pub fn resolve(args: &Args) -> Result<Self, String> {
        let exe = std::env::current_exe().map_err(|e| format!("cannot locate executable: {e}"))?;
        let exe_dir = exe.parent().ok_or("executable has no parent folder")?.to_path_buf();
        let roaming = dirs::config_dir().ok_or("cannot locate %APPDATA%")?;
        let repo = cfg!(debug_assertions).then(|| Path::new(env!("CARGO_MANIFEST_DIR")).join(".."));
        let paths = Self::resolve_from(&exe_dir, &roaming, repo.as_deref(), args);
        std::fs::create_dir_all(&paths.data_dir)
            .map_err(|e| format!("cannot create data folder {}: {e}", paths.data_dir.display()))?;
        Ok(paths)
    }

    /// Pure resolution logic, separated for tests.
    pub fn resolve_from(exe_dir: &Path, roaming: &Path, repo: Option<&Path>, args: &Args) -> Self {
        let version_root = crate::versions::managed_root(exe_dir);
        let base = version_root.as_deref().unwrap_or(exe_dir);
        let portable = base.join(PORTABLE_FLAG).is_file();
        let data_dir = match &args.data_dir {
            Some(d) => d.clone(),
            None if portable => base.join("data"),
            None => roaming.join(APP_NAME),
        };

        let beside_exe = exe_dir.join("plugins");
        let plugins_dir = match (&args.plugins_dir, repo) {
            (Some(d), _) => d.clone(),
            (None, Some(repo)) if !beside_exe.is_dir() => repo.join("plugins"),
            _ => beside_exe,
        };
        let extras_dir = repo
            .filter(|r| plugins_dir == r.join("plugins"))
            .map(|r| r.join("extras"))
            .filter(|d| d.is_dir());
        let dev_plugins_dir = repo
            .map(|r| r.join("tests").join("fixtures").join("dev-plugins"))
            .filter(|d| d.is_dir() && std::env::var_os("VELLUM_NO_DEV_PLUGINS").is_none());

        let shared_plugins_dir = version_root.as_ref().map(|r| r.join("plugins"));
        AppPaths { exe_dir: exe_dir.to_path_buf(), data_dir, portable, plugins_dir, extras_dir, dev_plugins_dir, version_root, shared_plugins_dir }
    }

    /// The folder for plugins the user adds: shared by every version when versions are managed.
    pub fn user_plugins_dir(&self) -> &Path {
        self.shared_plugins_dir.as_deref().unwrap_or(&self.plugins_dir)
    }

    pub fn plugin_roots(&self) -> Vec<PathBuf> {
        std::iter::once(self.plugins_dir.clone())
            .chain(self.shared_plugins_dir.clone().filter(|d| d.is_dir()))
            .chain(self.extras_dir.clone())
            .chain(self.dev_plugins_dir.clone())
            .collect()
    }

    pub fn logs_dir(&self) -> PathBuf {
        self.data_dir.join("logs")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appdata_by_default() {
        let exe = tempfile::tempdir().unwrap();
        let p = AppPaths::resolve_from(exe.path(), Path::new("R:\\Roaming"), None, &Args::default());
        assert!(!p.portable);
        assert_eq!(p.data_dir, Path::new("R:\\Roaming").join(APP_NAME));
        assert_eq!(p.plugins_dir, exe.path().join("plugins"));
    }

    #[test]
    fn portable_flag_moves_data_beside_exe() {
        let exe = tempfile::tempdir().unwrap();
        std::fs::write(exe.path().join(PORTABLE_FLAG), "").unwrap();
        let p = AppPaths::resolve_from(exe.path(), Path::new("R:\\Roaming"), None, &Args::default());
        assert!(p.portable);
        assert_eq!(p.data_dir, exe.path().join("data"));
    }

    #[test]
    fn data_dir_flag_wins_over_portable() {
        let exe = tempfile::tempdir().unwrap();
        std::fs::write(exe.path().join(PORTABLE_FLAG), "").unwrap();
        let args = Args { data_dir: Some("X:\\custom".into()), ..Args::default() };
        let p = AppPaths::resolve_from(exe.path(), Path::new("R:\\Roaming"), None, &args);
        assert_eq!(p.data_dir, Path::new("X:\\custom"));
    }

    #[test]
    fn dev_builds_fall_back_to_repo_plugins() {
        let exe = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        let p = AppPaths::resolve_from(exe.path(), Path::new("R:\\"), Some(repo.path()), &Args::default());
        assert_eq!(p.plugins_dir, repo.path().join("plugins"));
        assert_eq!(p.extras_dir, None);
        std::fs::create_dir(repo.path().join("extras")).unwrap();
        let p = AppPaths::resolve_from(exe.path(), Path::new("R:\\"), Some(repo.path()), &Args::default());
        assert_eq!(p.extras_dir, Some(repo.path().join("extras")));
        std::fs::create_dir(exe.path().join("plugins")).unwrap();
        let p = AppPaths::resolve_from(exe.path(), Path::new("R:\\"), Some(repo.path()), &Args::default());
        assert_eq!(p.plugins_dir, exe.path().join("plugins"));
        assert_eq!(p.extras_dir, None, "a packaged plugins folder already holds its extras");
    }

    #[test]
    fn a_managed_version_keeps_data_and_user_plugins_at_the_root() {
        let root = tempfile::tempdir().unwrap();
        let exe = root.path().join("versions").join("0.2.0");
        std::fs::create_dir_all(&exe).unwrap();
        std::fs::write(root.path().join("active.json"), r#"{"active":"0.2.0"}"#).unwrap();
        std::fs::write(root.path().join(PORTABLE_FLAG), "").unwrap();
        let p = AppPaths::resolve_from(&exe, Path::new("R:\\"), None, &Args::default());
        assert_eq!(p.version_root.as_deref(), Some(root.path()));
        assert!(p.portable);
        assert_eq!(p.data_dir, root.path().join("data"));
        assert_eq!(p.plugins_dir, exe.join("plugins"));
        assert_eq!(p.user_plugins_dir(), root.path().join("plugins"));
    }
}
