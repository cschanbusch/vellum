use std::path::PathBuf;

/// Command-line flags. Hand-parsed: there are few, and unknown ones are ignored so
/// later flags (`--dev`, `--couch`, `--diagnose`) can be added without breaking anything.
#[derive(Debug, Default, Clone)]
pub struct Args {
    /// Overrides where user data is stored (tests, multiple profiles).
    pub data_dir: Option<PathBuf>,
    /// Overrides the plugins folder normally found beside the exe.
    pub plugins_dir: Option<PathBuf>,
    /// Print discovered plugins as JSON and exit without opening a window.
    pub print_plugins: bool,
    /// Write a structure-only diagnostics report (to `--out`, default `vellum-diagnostics.json`).
    pub diagnose: bool,
    /// Output file for report-style flags.
    pub out: Option<PathBuf>,
    /// Developer mode for this run (skin file watching, DevTools, error overlay).
    pub dev: bool,
}

impl Args {
    pub fn parse(mut it: impl Iterator<Item = String>) -> Self {
        let mut args = Args::default();
        while let Some(a) = it.next() {
            match a.as_str() {
                "--data-dir" => args.data_dir = it.next().map(PathBuf::from),
                "--plugins-dir" => args.plugins_dir = it.next().map(PathBuf::from),
                "--print-plugins" => args.print_plugins = true,
                "--diagnose" => args.diagnose = true,
                "--out" => args.out = it.next().map(PathBuf::from),
                "--dev" => args.dev = true,
                _ => {}
            }
        }
        args
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_known_flags_and_ignores_others() {
        let a = Args::parse(
            ["--dev", "--data-dir", "D:\\v", "--print-plugins", "--out", "x.json"]
                .into_iter()
                .map(String::from),
        );
        assert_eq!(a.data_dir, Some(PathBuf::from("D:\\v")));
        assert!(a.print_plugins);
        assert_eq!(a.out, Some(PathBuf::from("x.json")));
        assert!(a.plugins_dir.is_none());
        assert!(a.dev);
    }
}
