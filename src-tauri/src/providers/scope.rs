//! File-system scope for one provider: the folders it may read and the files it may never
//! open, checked on canonical paths so `..`, symlinks and junctions cannot escape.

use std::path::{Component, Path, PathBuf};
use std::sync::RwLock;

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum ScopeError {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("outside the provider's allowed locations: {0}")]
    Outside(String),
    #[error("access to this file is denied: {0}")]
    Denied(String),
}

/// Paths given to providers and shown to users never carry the `\\?\` verbatim prefix
/// that `canonicalize` adds on Windows.
pub fn simplify(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => PathBuf::from(rest),
        Some(rest) if rest.starts_with("UNC\\") => PathBuf::from(format!(r"\\{}", &rest[4..])),
        _ => p.to_path_buf(),
    }
}

pub fn canonical(p: &Path) -> Option<PathBuf> {
    p.canonicalize().ok()
}

/// Case-insensitive `*` / `?` matching of one path segment (Windows file names).
pub fn glob_match(pattern: &str, name: &str) -> bool {
    let p: Vec<char> = pattern.to_lowercase().chars().collect();
    let n: Vec<char> = name.to_lowercase().chars().collect();
    let (mut pi, mut ni) = (0, 0);
    let (mut star, mut mark) = (None, 0);
    while ni < n.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == n[ni]) {
            pi += 1;
            ni += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ni;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ni = mark;
        } else {
            return false;
        }
    }
    p[pi..].iter().all(|&c| c == '*')
}

const GLOB_MAX_RESULTS: usize = 20_000;
const GLOB_MAX_DEPTH: usize = 12;

/// Matches `pattern` (segments separated by `/`, `**` = any number of folders) under `dir`.
/// Returns full paths, sorted. Symlinked folders are not followed.
pub fn glob(dir: &Path, pattern: &str) -> Vec<PathBuf> {
    let segs: Vec<&str> = pattern.split(['/', '\\']).filter(|s| !s.is_empty() && *s != ".").collect();
    let mut out = Vec::new();
    walk(dir, &segs, 0, &mut out);
    out.sort();
    out.dedup();
    out
}

fn walk(dir: &Path, segs: &[&str], depth: usize, out: &mut Vec<PathBuf>) {
    if out.len() >= GLOB_MAX_RESULTS || depth > GLOB_MAX_DEPTH {
        return;
    }
    let Some((&seg, rest)) = segs.split_first() else { return };
    if seg == "**" {
        walk(dir, rest, depth, out);
        for sub in children(dir).into_iter().filter(|(_, is_dir)| *is_dir) {
            walk(&sub.0, segs, depth + 1, out);
        }
        return;
    }
    let literal = !seg.contains(['*', '?']);
    let candidates = if literal {
        let p = dir.join(seg);
        if p.exists() { vec![(p.clone(), p.is_dir())] } else { vec![] }
    } else {
        children(dir)
            .into_iter()
            .filter(|(p, _)| p.file_name().is_some_and(|n| glob_match(seg, &n.to_string_lossy())))
            .collect()
    };
    for (path, is_dir) in candidates {
        if rest.is_empty() {
            out.push(path);
        } else if is_dir {
            walk(&path, rest, depth + 1, out);
        }
    }
}

fn children(dir: &Path) -> Vec<(PathBuf, bool)> {
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(Result::ok)
                .filter_map(|e| {
                    let ft = e.file_type().ok()?;
                    (!ft.is_symlink()).then(|| (e.path(), ft.is_dir()))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// One `denyFiles` rule from the manifest: `ssfn*` matches a file name anywhere in scope;
/// `config/loginusers.vdf` matches a path ending in those segments.
#[derive(Debug, Clone)]
pub struct DenyRule(Vec<String>);

impl DenyRule {
    pub fn new(pattern: &str) -> Self {
        DenyRule(pattern.split(['/', '\\']).filter(|s| !s.is_empty()).map(str::to_lowercase).collect())
    }

    fn matches(&self, path: &Path) -> bool {
        let comps: Vec<String> = path
            .components()
            .filter_map(|c| match c {
                Component::Normal(s) => Some(s.to_string_lossy().to_lowercase()),
                _ => None,
            })
            .collect();
        if self.0.is_empty() || comps.len() < self.0.len() {
            return false;
        }
        let tail = &comps[comps.len() - self.0.len()..];
        tail.iter().zip(&self.0).all(|(name, pat)| glob_match(pat, name))
    }
}

#[derive(Debug, Default)]
pub struct Scope {
    roots: RwLock<Vec<PathBuf>>,
    deny: Vec<DenyRule>,
}

impl Scope {
    pub fn new(roots: impl IntoIterator<Item = PathBuf>, deny: &[String]) -> Self {
        let s = Scope { roots: RwLock::new(Vec::new()), deny: deny.iter().map(|d| DenyRule::new(d)).collect() };
        for r in roots {
            s.add_root(&r);
        }
        s
    }

    /// Adds an existing folder as an allowed root; returns its canonical path.
    pub fn add_root(&self, dir: &Path) -> Option<PathBuf> {
        let c = canonical(dir).filter(|c| c.is_dir())?;
        let mut roots = self.roots.write().unwrap();
        if !roots.contains(&c) {
            roots.push(c.clone());
        }
        Some(c)
    }

    pub fn roots(&self) -> Vec<PathBuf> {
        self.roots.read().unwrap().iter().map(|r| simplify(r)).collect()
    }

    fn inside(&self, c: &Path) -> bool {
        self.roots.read().unwrap().iter().any(|r| c.starts_with(r))
    }

    pub fn is_denied(&self, path: &Path) -> bool {
        self.deny.iter().any(|d| d.matches(path))
    }

    /// Checks that `path` exists, is inside an allowed root, and is not denied.
    /// Returns the canonical path to open.
    pub fn check(&self, path: &str) -> Result<PathBuf, ScopeError> {
        let c = canonical(Path::new(path)).ok_or_else(|| ScopeError::NotFound(path.to_string()))?;
        if self.is_denied(&c) {
            return Err(ScopeError::Denied(path.to_string()));
        }
        if !self.inside(&c) {
            return Err(ScopeError::Outside(path.to_string()));
        }
        Ok(c)
    }

    /// True when `path` (which must exist) lies inside an allowed root or `extra`.
    pub fn contains(&self, path: &Path, extra: Option<&Path>) -> bool {
        let Some(c) = canonical(path) else { return false };
        self.inside(&c) || extra.and_then(canonical).is_some_and(|e| c.starts_with(e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_matching() {
        assert!(glob_match("appmanifest_*.acf", "appmanifest_620.acf"));
        assert!(glob_match("*.ITEM", "abc.item"));
        assert!(glob_match("ssfn*", "ssfn123"));
        assert!(glob_match("a?c", "abc") && !glob_match("a?c", "ac"));
        assert!(glob_match("*", "") && glob_match("**", "x"));
        assert!(!glob_match("*.acf", "x.acf.bak"));
        assert!(glob_match("library_hero*", "library_hero_blur.jpg"));
    }

    fn tree() -> tempfile::TempDir {
        let t = tempfile::tempdir().unwrap();
        for f in ["root/steamapps/appmanifest_1.acf", "root/steamapps/appmanifest_2.acf", "root/config/loginusers.vdf", "root/ssfn42", "root/a/b/c/library_hero.jpg", "outside/secret.txt"] {
            let p = t.path().join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, "x").unwrap();
        }
        t
    }

    #[test]
    fn glob_walks_segments_and_double_star() {
        let t = tree();
        let root = t.path().join("root");
        assert_eq!(glob(&root, "steamapps/appmanifest_*.acf").len(), 2);
        assert_eq!(glob(&root, "**/library_hero*").len(), 1);
        assert_eq!(glob(&root, "nothing/*").len(), 0);
    }

    #[test]
    fn scope_blocks_traversal_outside_and_denylist() {
        let t = tree();
        let root = t.path().join("root");
        let scope = Scope::new([root.clone()], &["config/loginusers.vdf".into(), "ssfn*".into()]);
        let ok = root.join("steamapps").join("appmanifest_1.acf");
        assert!(scope.check(&ok.to_string_lossy()).is_ok());

        let escape = root.join("..").join("outside").join("secret.txt");
        assert!(matches!(scope.check(&escape.to_string_lossy()), Err(ScopeError::Outside(_))));
        assert!(matches!(scope.check(&root.join("config/loginusers.vdf").to_string_lossy()), Err(ScopeError::Denied(_))));
        assert!(matches!(scope.check(&root.join("SSFN42").to_string_lossy()), Err(ScopeError::Denied(_))));
        assert!(matches!(scope.check(&root.join("nope").to_string_lossy()), Err(ScopeError::NotFound(_))));
    }

    #[test]
    fn added_roots_extend_scope() {
        let t = tree();
        let scope = Scope::new([t.path().join("root")], &[]);
        let secret = t.path().join("outside").join("secret.txt");
        assert!(scope.check(&secret.to_string_lossy()).is_err());
        scope.add_root(&t.path().join("outside")).unwrap();
        assert!(scope.check(&secret.to_string_lossy()).is_ok());
        assert!(scope.add_root(&t.path().join("missing")).is_none());
    }

    #[cfg(windows)]
    #[test]
    fn junctions_cannot_escape() {
        let t = tree();
        let root = t.path().join("root");
        let link = root.join("link");
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(t.path().join("outside"))
            .output()
            .unwrap();
        assert!(status.status.success(), "mklink failed");
        let scope = Scope::new([root.clone()], &[]);
        let via_link = link.join("secret.txt");
        assert!(matches!(scope.check(&via_link.to_string_lossy()), Err(ScopeError::Outside(_))));
    }

    #[test]
    fn simplify_strips_verbatim_prefix() {
        assert_eq!(simplify(Path::new(r"\\?\C:\Steam")), PathBuf::from(r"C:\Steam"));
        assert_eq!(simplify(Path::new(r"\\?\UNC\server\share")), PathBuf::from(r"\\server\share"));
        assert_eq!(simplify(Path::new(r"D:\x")), PathBuf::from(r"D:\x"));
    }
}
