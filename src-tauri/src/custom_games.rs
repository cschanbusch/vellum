//! Hand-added games. The custom provider reads this list from its settings (`games`); only
//! the shell's commands write it, and every path is checked here first.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::userdata::settings::Settings;

pub const PROVIDER: &str = "custom";
const GAMES_KEY: &str = "games";
const MAX_TITLE: usize = 200;
const MAX_ARGS: usize = 4096;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CustomGame {
    /// Empty when adding; the record id is `custom:<id>`.
    pub id: String,
    pub title: String,
    pub exe: String,
    pub args: String,
    pub cwd: String,
}

/// Shortcuts open through the Windows shell, which takes no arguments or working folder here.
pub fn is_shortcut(path: &Path) -> bool {
    has_extension(path, &["lnk", "url"])
}

fn has_extension(path: &Path, allowed: &[&str]) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| allowed.iter().any(|a| e.eq_ignore_ascii_case(a)))
}

/// Trims the fields and checks them; the error is a sentence for the dialog.
pub fn validate(mut g: CustomGame) -> Result<CustomGame, String> {
    g.title = g.title.trim().to_string();
    g.exe = g.exe.trim().trim_matches('"').to_string();
    g.args = g.args.trim().to_string();
    g.cwd = g.cwd.trim().trim_matches('"').to_string();
    if g.title.is_empty() {
        return Err("Give the game a title.".into());
    }
    if g.title.chars().count() > MAX_TITLE {
        return Err(format!("That title is too long (the limit is {MAX_TITLE} characters)."));
    }
    let exe = Path::new(&g.exe);
    if !exe.is_absolute() {
        return Err("Choose the program or shortcut to start.".into());
    }
    if !has_extension(exe, &["exe", "lnk", "url"]) {
        return Err("Choose a program (.exe) or a shortcut (.lnk, .url).".into());
    }
    if !exe.is_file() {
        return Err(format!("That file doesn't exist: {}", g.exe));
    }
    if g.args.len() > MAX_ARGS {
        return Err("Those arguments are too long.".into());
    }
    if is_shortcut(exe) {
        g.args.clear();
        g.cwd.clear();
    }
    if !g.cwd.is_empty() && !Path::new(&g.cwd).is_dir() {
        return Err(format!("That working folder doesn't exist: {}", g.cwd));
    }
    Ok(g)
}

pub fn list(s: &Settings) -> Vec<CustomGame> {
    s.plugins
        .providers
        .get(PROVIDER)
        .and_then(|e| e.values.get(GAMES_KEY))
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default()
}

fn store(s: &mut Settings, games: &[CustomGame]) {
    let value = serde_json::to_value(games).unwrap_or(Value::Array(Vec::new()));
    s.plugins.providers.entry(PROVIDER.to_string()).or_default().values.insert(GAMES_KEY.to_string(), value);
}

fn new_id(existing: &[CustomGame]) -> String {
    let mut n = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    loop {
        let id = format!("{n:x}");
        if !existing.iter().any(|g| g.id == id) {
            return id;
        }
        n += 1;
    }
}

/// Adds a game (empty id) or replaces one, and returns its id. `g` must be validated.
pub fn upsert(s: &mut Settings, mut g: CustomGame) -> Result<String, String> {
    let mut games = list(s);
    if g.id.is_empty() {
        g.id = new_id(&games);
        games.push(g.clone());
    } else {
        let slot = games.iter_mut().find(|x| x.id == g.id).ok_or("That game is no longer in the list.")?;
        *slot = g.clone();
    }
    store(s, &games);
    Ok(g.id)
}

/// Removes a game; returns whether it was there.
pub fn remove(s: &mut Settings, id: &str) -> bool {
    let mut games = list(s);
    let before = games.len();
    games.retain(|g| g.id != id);
    let found = games.len() != before;
    if found {
        store(s, &games);
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_file(name: &str) -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join(name);
        std::fs::write(&p, b"x").unwrap();
        let s = p.to_string_lossy().into_owned();
        (dir, s)
    }

    #[test]
    fn validation_explains_each_problem() {
        let (dir, exe) = with_file("game.exe");
        let good = CustomGame { title: "  Hades ".into(), exe: format!("\"{exe}\""), args: " -x ".into(), ..Default::default() };
        let v = validate(good.clone()).unwrap();
        assert_eq!((v.title.as_str(), v.exe.as_str(), v.args.as_str()), ("Hades", exe.as_str(), "-x"));

        assert!(validate(CustomGame { title: " ".into(), ..good.clone() }).unwrap_err().contains("title"));
        assert!(validate(CustomGame { exe: "game.exe".into(), ..good.clone() }).unwrap_err().contains("Choose the program"));
        assert!(validate(CustomGame { exe: dir.path().join("gone.exe").to_string_lossy().into(), ..good.clone() }).unwrap_err().contains("doesn't exist"));
        assert!(validate(CustomGame { cwd: dir.path().join("nope").to_string_lossy().into(), ..good.clone() }).unwrap_err().contains("working folder"));
        let (_d, txt) = with_file("notes.txt");
        assert!(validate(CustomGame { exe: txt, ..good }).unwrap_err().contains(".exe"));
    }

    #[test]
    fn shortcuts_drop_arguments_and_folder() {
        let (_d, lnk) = with_file("Game.LNK");
        let v = validate(CustomGame { title: "G".into(), exe: lnk, args: "-x".into(), cwd: "C:\\nope".into(), ..Default::default() }).unwrap();
        assert!(v.args.is_empty() && v.cwd.is_empty());
    }

    #[test]
    fn add_edit_remove() {
        let mut s = Settings::default();
        let id = upsert(&mut s, CustomGame { title: "A".into(), exe: "a.exe".into(), ..Default::default() }).unwrap();
        let other = upsert(&mut s, CustomGame { title: "B".into(), exe: "b.exe".into(), ..Default::default() }).unwrap();
        assert_ne!(id, other);
        upsert(&mut s, CustomGame { id: id.clone(), title: "A2".into(), exe: "a.exe".into(), ..Default::default() }).unwrap();
        assert_eq!(list(&s).iter().map(|g| g.title.as_str()).collect::<Vec<_>>(), ["A2", "B"]);
        assert!(upsert(&mut s, CustomGame { id: "gone".into(), ..Default::default() }).is_err());
        assert!(remove(&mut s, &id) && !remove(&mut s, &id));
        assert_eq!(list(&s).len(), 1);
    }
}
