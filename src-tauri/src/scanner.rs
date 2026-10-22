//! Scan scheduling, provider status, location prompts, file watching and actions.
//!
//! Startup shows the last snapshot immediately, then every enabled provider scans on its own
//! thread and its results replace its part of the library as soon as it finishes. A provider
//! that throws or times out keeps its previous results and gets an error status; nothing
//! else is affected.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::library::{self, ProviderRecords};
use crate::plugins::PluginKind;
use crate::providers::host::{self, HostError, Invocation, Method};
use crate::providers::locations::{self, Resolution};
use crate::providers::model::{parse_scan, ProviderSpec};
use crate::providers::scope::{glob_match, Scope};
use crate::util::now_iso;
use crate::AppState;

pub const EVENT_LIBRARY_CHANGED: &str = "vellum://library-changed";
pub const EVENT_PROVIDERS_CHANGED: &str = "vellum://providers-changed";
const WATCH_DEBOUNCE: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderState {
    Idle,
    Scanning,
    Ready,
    /// A required location is missing; the provider waits for the user.
    Inactive,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub id: String,
    pub state: ProviderState,
    pub message: Option<String>,
    pub games: usize,
    pub scanned_at: Option<String>,
    pub duration_ms: Option<u64>,
    pub locations: Vec<Resolution>,
}

#[derive(Debug)]
pub struct ProviderRuntime {
    pub status: ProviderStatus,
    pub locations: BTreeMap<String, PathBuf>,
    pub derived: Vec<PathBuf>,
    /// Bumped on every scan start; results from an older scan are discarded.
    generation: u64,
}

impl ProviderRuntime {
    fn new(id: &str) -> Self {
        ProviderRuntime {
            status: ProviderStatus {
                id: id.to_string(),
                state: ProviderState::Idle,
                message: None,
                games: 0,
                scanned_at: None,
                duration_ms: None,
                locations: Vec::new(),
            },
            locations: BTreeMap::new(),
            derived: Vec::new(),
            generation: 0,
        }
    }
}

/// "Vellum couldn't find the Steam installation folder" with Browse / Skip / Disable.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    pub id: String,
    pub provider: String,
    pub provider_name: String,
    pub key: String,
    pub label: String,
    pub message: String,
}

#[derive(Default)]
pub struct Notices {
    pub list: Vec<Notice>,
    /// Skipped for this session.
    pub dismissed: HashSet<String>,
}

#[derive(Default)]
pub struct Runtime {
    pub providers: Mutex<HashMap<String, ProviderRuntime>>,
    pub notices: Mutex<Notices>,
    watchers: Mutex<HashMap<String, Debouncer<RecommendedWatcher>>>,
}

fn notice_id(provider: &str, key: &str) -> String {
    format!("locate:{provider}:{key}")
}

impl AppState {
    /// The provider spec for an enabled, valid provider plugin.
    pub fn provider_spec(&self, id: &str) -> Option<ProviderSpec> {
        let plugins = self.plugins.read().unwrap();
        let rec = plugins.iter().find(|p| p.kind == PluginKind::Provider && p.id == id && p.is_valid())?;
        self.settings.read(|s| {
            if !s.plugin_enabled(PluginKind::Provider, id) {
                return None;
            }
            let saved = s.plugins.providers.get(id).map(|e| e.values.clone()).unwrap_or_default();
            ProviderSpec::from_record(rec, &saved)
        })
    }

    pub fn enabled_providers(&self) -> Vec<String> {
        let plugins = self.plugins.read().unwrap();
        self.settings.read(|s| {
            plugins
                .iter()
                .filter(|p| p.kind == PluginKind::Provider && p.is_valid() && s.plugin_enabled(PluginKind::Provider, &p.id))
                .map(|p| p.id.clone())
                .collect()
        })
    }

    /// Providers whose games are shown: enabled, valid, and not waiting for a location.
    pub fn active_providers(&self) -> HashSet<String> {
        let rt = self.runtime.providers.lock().unwrap();
        self.enabled_providers()
            .into_iter()
            .filter(|id| rt.get(id).is_none_or(|r| r.status.state != ProviderState::Inactive))
            .collect()
    }

    pub fn entries(&self) -> Vec<library::Entry> {
        let active = self.active_providers();
        self.library.read(|snap| self.userdata.read(|ud| library::build_entries(snap, ud, &|p| active.contains(p))))
    }

    pub fn entry(&self, id: &str) -> Option<library::Entry> {
        self.entries().into_iter().find(|e| e.id == id)
    }

    pub fn provider_statuses(&self) -> Vec<ProviderStatus> {
        let rt = self.runtime.providers.lock().unwrap();
        let mut v: Vec<ProviderStatus> = rt.values().map(|r| r.status.clone()).collect();
        v.sort_by(|a, b| a.id.cmp(&b.id));
        v
    }

    pub fn notices(&self) -> Vec<Notice> {
        self.runtime.notices.lock().unwrap().list.clone()
    }

    fn with_runtime<R>(&self, id: &str, f: impl FnOnce(&mut ProviderRuntime) -> R) -> R {
        let mut rt = self.runtime.providers.lock().unwrap();
        f(rt.entry(id.to_string()).or_insert_with(|| ProviderRuntime::new(id)))
    }
}

fn emit_providers(app: &AppHandle) {
    let _ = app.emit(EVENT_PROVIDERS_CHANGED, ());
}

fn emit_library(app: &AppHandle) {
    let _ = app.emit(EVENT_LIBRARY_CHANGED, ());
}

/// Scans every enabled provider in parallel.
pub fn scan_all(app: &AppHandle) {
    let ids = app.state::<AppState>().enabled_providers();
    for id in ids {
        spawn_scan(app, id);
    }
}

pub fn spawn_scan(app: &AppHandle, id: String) {
    let app = app.clone();
    let _ = std::thread::Builder::new().name(format!("scan-{id}")).spawn(move || scan_one(&app, &id));
}

/// Resolves locations and runs one provider's `scan`.
pub fn scan_one(app: &AppHandle, id: &str) {
    let state = app.state::<AppState>();
    let Some(spec) = state.provider_spec(id) else { return };
    let generation = state.with_runtime(id, |r| {
        r.generation += 1;
        r.status.state = ProviderState::Scanning;
        r.status.message = None;
        r.generation
    });
    emit_providers(app);

    // 1. Locations.
    let saved: BTreeMap<String, String> =
        state.settings.read(|s| s.plugins.providers.get(id).map(|e| e.locations.clone()).unwrap_or_default());
    let mut resolved = BTreeMap::new();
    let mut resolutions = Vec::new();
    let mut missing = Vec::new();
    for decl in &spec.locations {
        let r = locations::resolve(decl, saved.get(&decl.key).map(String::as_str), state.env.registry.as_ref());
        match &r.path {
            Some(p) => {
                resolved.insert(decl.key.clone(), p.clone());
                let p = p.to_string_lossy().into_owned();
                if saved.get(&decl.key) != Some(&p) {
                    state.settings.update(|s| {
                        s.plugins.providers.entry(id.to_string()).or_default().locations.insert(decl.key.clone(), p);
                    });
                }
            }
            None if decl.required => missing.push(r.clone()),
            None => {}
        }
        resolutions.push(r);
    }

    {
        let mut n = state.runtime.notices.lock().unwrap();
        n.list.retain(|x| x.provider != id || missing.iter().any(|m| notice_id(id, &m.key) == x.id));
        for m in &missing {
            let nid = notice_id(id, &m.key);
            if !n.dismissed.contains(&nid) && !n.list.iter().any(|x| x.id == nid) {
                n.list.push(Notice {
                    id: nid,
                    provider: id.to_string(),
                    provider_name: spec.name.clone(),
                    key: m.key.clone(),
                    label: m.label.clone(),
                    message: format!("{} couldn't find the {}", crate::APP_NAME, m.label),
                });
            }
        }
    }

    if !missing.is_empty() {
        let labels: Vec<&str> = missing.iter().map(|m| m.label.as_str()).collect();
        tracing::warn!(provider = id, "inactive: missing {}", labels.join(", "));
        state.with_runtime(id, |r| {
            r.status.state = ProviderState::Inactive;
            r.status.message = Some(format!("Couldn't find the {}", labels.join(", ")));
            r.status.locations = resolutions;
            r.locations.clear();
        });
        stop_watch(&state, id);
        emit_providers(app);
        emit_library(app);
        return;
    }

    // 2. Scan.
    let started = Instant::now();
    let result = {
        let inv = Invocation { spec: &spec, locations: &resolved, derived: &[], env: &state.env, timeout: None };
        host::invoke(&inv, Method::Scan, None)
    };
    let elapsed = started.elapsed().as_millis() as u64;
    if state.with_runtime(id, |r| r.generation) != generation {
        return; // a newer scan superseded this one
    }

    match result.map_err(|e| e.to_string()).and_then(|out| parse_scan(out.value).map(|s| (s, out.derived))) {
        Ok((scan, derived)) => {
            for s in &scan.skipped {
                tracing::warn!(provider = id, "skipped game: {s}");
            }
            let count = scan.games.len();
            let games = scan.games.clone();
            let now = now_iso();
            state.userdata.update(|ud| {
                library::note_first_seen(ud, id, &scan.games, &now);
            });
            // Watched store files change often (Steam rewrites its config while games run); a
            // rescan that finds the same games isn't a library change, so views aren't redrawn.
            let changed = state.library.read(|snap| match snap.providers.get(id) {
                Some(prev) => prev.games != scan.games || prev.provider_name != spec.name || prev.capabilities != spec.capabilities,
                None => true,
            });
            state.library.update(|snap| {
                snap.providers.insert(
                    id.to_string(),
                    ProviderRecords {
                        provider_name: spec.name.clone(),
                        capabilities: spec.capabilities.clone(),
                        scanned_at: now.clone(),
                        games: scan.games,
                        // Keep the previous art until refresh_art replaces it.
                        art: snap.providers.get(id).map(|r| r.art.clone()).unwrap_or_default(),
                    },
                );
            });
            state.with_runtime(id, |r| {
                r.status.state = ProviderState::Ready;
                r.status.message = (!scan.skipped.is_empty()).then(|| format!("{} game(s) skipped as malformed", scan.skipped.len()));
                r.status.games = count;
                r.status.scanned_at = Some(now);
                r.status.duration_ms = Some(elapsed);
                r.status.locations = resolutions;
                r.locations = resolved;
                r.derived = derived;
            });
            tracing::info!(provider = id, games = count, ms = elapsed, changed, "scan finished");
            if changed {
                emit_library(app);
            }
            emit_providers(app);
            refresh_art(app, &spec, &games, generation);
            if spec.can("watch") {
                start_watch(app, &spec);
            }
        }
        Err(e) => {
            tracing::error!(provider = id, error = %e, "scan failed");
            state.with_runtime(id, |r| {
                r.status.state = ProviderState::Error;
                r.status.message = Some(e);
                r.status.duration_ms = Some(elapsed);
                r.status.locations = resolutions;
                r.locations = resolved;
            });
            emit_providers(app);
        }
    }
}

/// Asks the provider for art candidates (one `art()` call per game, in one runtime), keeps
/// the safe ones and updates the snapshot. Providers without `art()` simply have none.
fn refresh_art(app: &AppHandle, spec: &ProviderSpec, games: &[crate::providers::model::ProviderGame], generation: u64) {
    let state = app.state::<AppState>();
    let (locs, derived) = state.with_runtime(&spec.id, |r| (r.locations.clone(), r.derived.clone()));
    let args: Vec<Option<Value>> = games.iter().map(|g| serde_json::to_value(g).ok()).collect();
    let inv = Invocation { spec, locations: &locs, derived: &derived, env: &state.env, timeout: None };
    let started = Instant::now();
    let batch = match host::invoke_each(&inv, Method::Art, &args) {
        Ok(b) => b,
        Err(HostError::Missing(_)) => return,
        Err(e) => {
            tracing::warn!(provider = %spec.id, error = %e, "art() failed; keeping previous art");
            return;
        }
    };
    let scope = Scope::new(locs.values().cloned().chain(derived.iter().cloned()).chain([spec.dir.clone()]), &spec.deny_files);
    let mut art = BTreeMap::new();
    let (mut failed, mut problems) = (0usize, Vec::new());
    for (g, r) in games.iter().zip(batch.values) {
        match r {
            Ok(v) => {
                let (ok, p) = crate::art::validate_candidates(&v, &scope, &spec.art_hosts);
                problems.extend(p);
                if !ok.is_empty() {
                    art.insert(g.source_id.clone(), ok);
                }
            }
            Err(e) => {
                failed += 1;
                if failed <= 3 {
                    tracing::warn!(provider = %spec.id, game = %g.source_id, error = %e, "art() threw");
                }
            }
        }
    }
    for p in problems.iter().take(5) {
        tracing::warn!(provider = %spec.id, "art candidate rejected: {p}");
    }
    if state.with_runtime(&spec.id, |r| r.generation) != generation {
        return;
    }
    let changed = state.library.update(|snap| match snap.providers.get_mut(&spec.id) {
        Some(r) if r.art != art => {
            r.art = art;
            true
        }
        _ => false,
    });
    tracing::info!(
        provider = %spec.id,
        games = games.len(),
        rejected = problems.len(),
        failed,
        ms = started.elapsed().as_millis() as u64,
        "art candidates refreshed"
    );
    if changed {
        emit_library(app);
    }
}

/// Watches the files a provider names in `watch()`; changes trigger a debounced rescan of
/// that provider only.
fn start_watch(app: &AppHandle, spec: &ProviderSpec) {
    let state = app.state::<AppState>();
    let (locs, derived) = state.with_runtime(&spec.id, |r| (r.locations.clone(), r.derived.clone()));
    let inv = Invocation { spec, locations: &locs, derived: &derived, env: &state.env, timeout: None };
    let targets = match host::invoke(&inv, Method::Watch, None) {
        Ok(out) => out.value,
        Err(e) => {
            tracing::warn!(provider = %spec.id, error = %e, "watch() failed; file changes won't trigger rescans");
            return;
        }
    };
    let scope = Scope::new(locs.values().cloned().chain(derived.iter().cloned()), &[]);
    let mut by_dir: HashMap<PathBuf, Vec<String>> = HashMap::new();
    for t in targets.as_array().into_iter().flatten() {
        let (Some(path), glob) = (t.get("path").and_then(Value::as_str), t.get("glob").and_then(Value::as_str)) else {
            continue;
        };
        if scope.check(path).is_err() {
            tracing::warn!(provider = %spec.id, path, "watch path outside the provider's locations; ignored");
            continue;
        }
        by_dir.entry(PathBuf::from(path)).or_default().push(glob.unwrap_or("*").to_string());
    }

    let id = spec.id.clone();
    let handle = app.clone();
    let globs = by_dir.clone();
    let debouncer = new_debouncer(WATCH_DEBOUNCE, move |res: DebounceEventResult| {
        let Ok(events) = res else { return };
        let relevant = events.iter().any(|e| {
            let name = e.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            e.path.parent().and_then(|dir| globs.iter().find(|(d, _)| same_dir(d, dir))).is_some_and(|(_, pats)| {
                pats.iter().any(|p| glob_match(p, &name))
            })
        });
        if relevant {
            tracing::info!(provider = %id, "store files changed; rescanning");
            spawn_scan(&handle, id.clone());
        }
    });
    let mut debouncer = match debouncer {
        Ok(d) => d,
        Err(e) => {
            tracing::warn!(error = %e, "file watcher unavailable");
            return;
        }
    };
    for dir in by_dir.keys() {
        if let Err(e) = debouncer.watcher().watch(dir, RecursiveMode::NonRecursive) {
            tracing::warn!(provider = %spec.id, dir = %dir.display(), error = %e, "cannot watch folder");
        }
    }
    state.runtime.watchers.lock().unwrap().insert(spec.id.clone(), debouncer);
}

fn same_dir(a: &Path, b: &Path) -> bool {
    a == b || a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy())
}

pub fn stop_watch(state: &AppState, id: &str) {
    state.runtime.watchers.lock().unwrap().remove(id);
}

/// Called when a provider is disabled: forget its status, prompts and watcher.
pub fn deactivate(app: &AppHandle, id: &str) {
    let state = app.state::<AppState>();
    stop_watch(&state, id);
    state.runtime.providers.lock().unwrap().remove(id);
    state.runtime.notices.lock().unwrap().list.retain(|n| n.provider != id);
    emit_providers(app);
    emit_library(app);
}

/// The user picked a folder for a location: validate it, save it, rescan.
pub fn set_location(app: &AppHandle, provider: &str, key: &str, path: &str) -> Result<(), String> {
    let state = app.state::<AppState>();
    let spec = state.provider_spec(provider).ok_or("That provider is not enabled.")?;
    let decl = spec.locations.iter().find(|d| d.key == key).ok_or("Unknown location.")?;
    let canonical = locations::validate(Path::new(path), &decl.validate)?;
    state.settings.update(|s| {
        s.plugins
            .providers
            .entry(provider.to_string())
            .or_default()
            .locations
            .insert(key.to_string(), canonical.to_string_lossy().into_owned());
    });
    {
        let mut n = state.runtime.notices.lock().unwrap();
        let nid = notice_id(provider, key);
        n.list.retain(|x| x.id != nid);
        n.dismissed.remove(&nid);
    }
    tracing::info!(provider, key, "location set by user");
    spawn_scan(app, provider.to_string());
    Ok(())
}

pub fn dismiss_notice(app: &AppHandle, id: &str) {
    let state = app.state::<AppState>();
    let mut n = state.runtime.notices.lock().unwrap();
    n.list.retain(|x| x.id != id);
    n.dismissed.insert(id.to_string());
    drop(n);
    emit_providers(app);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    Launch,
    Install,
    Uninstall,
    OpenStore,
}

impl Action {
    fn method(self) -> Method {
        match self {
            Action::Launch => Method::Launch,
            Action::Install => Method::Install,
            Action::Uninstall => Method::Uninstall,
            Action::OpenStore => Method::OpenStore,
        }
    }

    fn capability(self) -> &'static str {
        match self {
            Action::Launch => "launch",
            Action::Install => "install",
            Action::Uninstall => "uninstall",
            Action::OpenStore => "openStore",
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    pub title: String,
    pub provider_name: String,
}

/// Runs a provider action for an entry. Launch success records "last launched".
pub fn run_action(app: &AppHandle, entry_id: &str, provider: Option<&str>, action: Action) -> Result<ActionResult, String> {
    let state = app.state::<AppState>();
    let (provider_id, game) = state.library.read(|snap| {
        library::find(snap, entry_id).map(|(p, _, g)| (p.to_string(), g.clone())).ok_or_else(|| "That game is no longer in the library.".to_string())
    })?;
    if provider.is_some_and(|p| p != provider_id) {
        return Err(format!("{entry_id} has no source from {}", provider.unwrap()));
    }
    if !state.active_providers().contains(&provider_id) {
        return Err(format!("{provider_id} is not active."));
    }
    let spec = state.provider_spec(&provider_id).ok_or("That provider is not enabled.")?;
    if !spec.can(action.capability()) {
        return Err(format!("{} does not support {}.", spec.name, action.capability()));
    }
    let (locs, derived) = state.with_runtime(&provider_id, |r| (r.locations.clone(), r.derived.clone()));
    let arg = serde_json::to_value(&game).map_err(|e| e.to_string())?;
    let inv = Invocation { spec: &spec, locations: &locs, derived: &derived, env: &state.env, timeout: None };
    host::invoke(&inv, action.method(), Some(&arg)).map_err(|e| match e {
        HostError::Missing(_) => format!("{} does not implement {}.", spec.name, action.capability()),
        other => format!("{}: {other}", spec.name),
    })?;

    if action == Action::Launch {
        let now = now_iso();
        state.userdata.update(|ud| ud.games.entry(entry_id.to_string()).or_default().last_launched = Some(now));
        emit_library(app);
    }
    tracing::info!(entry = entry_id, action = action.capability(), "action dispatched");
    Ok(ActionResult { title: game.title, provider_name: spec.name })
}
