//! Phase 4's network side: remote art downloads, SteamGridDB lookups and Steam store details.
//!
//! Nothing here blocks the UI. A *sweep* resolves every entry's art and lists what the chain
//! passed over (an image not downloaded yet, a SteamGridDB lookup not made yet, store details
//! that are due); those become jobs for small worker pools: 4 downloads at once, 2 lookups,
//! and one store-details request every 1.5 s. As jobs finish, the library is marked changed
//! and re-swept at most every couple of seconds, so entries upgrade from placeholders to real
//! art as it arrives. With no network, everything already cached keeps working.

pub mod choices;
pub mod details;
pub mod remote;
pub mod secret;
pub mod sgdb;
#[cfg(test)]
pub mod testserver;

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex, RwLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::art::resolve::{self, ArtSources, LookupState, RemoteState, Want};
use crate::library::{self, entry::ART_KINDS};
use crate::providers::model::Metadata;
use crate::userdata::settings::ArtSettings;
use crate::userdata::store::JsonStore;
use crate::AppState;

pub const USER_AGENT: &str = concat!("Vellum-Game-Launcher/", env!("CARGO_PKG_VERSION"));
const DOWNLOAD_WORKERS: usize = 4;
const LOOKUP_WORKERS: usize = 2;
/// A download or lookup that failed for network reasons waits this long before a retry.
const FAILURE_BACKOFF: Duration = Duration::from_secs(10 * 60);
/// After Steam says "too many requests".
const LIMIT_BACKOFF: Duration = Duration::from_secs(5 * 60);
/// Finished jobs are gathered into one library change at most this often.
const SETTLE: Duration = Duration::from_millis(2000);

/// An HTTP client with the spec's 10-second limit; non-2xx statuses are returned, not errors.
pub fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(10)))
        .http_status_as_error(false)
        .build()
        .into()
}

pub fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

#[derive(Debug, Clone, PartialEq)]
struct LookupJob {
    entry_id: String,
    target: LookupTarget,
    kinds: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
enum LookupTarget {
    Steam(String),
    Title(String),
}

#[derive(Default)]
struct Queues {
    downloads: VecDeque<String>,
    lookups: VecDeque<LookupJob>,
    details: VecDeque<String>,
    /// Queued or running, so a sweep doesn't add a job twice.
    busy: HashSet<String>,
}

pub struct Net {
    pub remote: JsonStore<remote::RemoteIndex>,
    pub sgdb: JsonStore<sgdb::SgdbIndex>,
    pub details: JsonStore<details::DetailsIndex>,
    pub originals: PathBuf,
    pub custom: PathBuf,
    queues: Mutex<Queues>,
    wake: Condvar,
    /// Jobs that failed for network reasons, by job key, until their backoff ends.
    failed: Mutex<HashMap<String, Instant>>,
    key: RwLock<Option<String>>,
    key_rejected: AtomicBool,
    details_paused_until: Mutex<Option<Instant>>,
    dirty: AtomicBool,
    started: AtomicBool,
}

impl Net {
    pub fn open(data_dir: &Path) -> Net {
        let cache = data_dir.join("cache");
        Net {
            remote: JsonStore::open(cache.join("art").join("remote.json"), remote::load),
            sgdb: JsonStore::open(cache.join("metadata").join("steamgriddb.json"), sgdb::load),
            details: JsonStore::open(cache.join("metadata").join("steam.json"), details::load),
            originals: remote::originals_dir(data_dir),
            custom: custom_dir(data_dir),
            queues: Mutex::new(Queues::default()),
            wake: Condvar::new(),
            failed: Mutex::new(HashMap::new()),
            key: RwLock::new(secret::get()),
            key_rejected: AtomicBool::new(false),
            details_paused_until: Mutex::new(None),
            dirty: AtomicBool::new(false),
            started: AtomicBool::new(false),
        }
    }

    pub fn flush(&self) {
        self.remote.flush();
        self.sgdb.flush();
        self.details.flush();
    }

    pub fn key(&self) -> Option<String> {
        self.key.read().unwrap().clone()
    }

    pub fn sgdb_on(&self) -> bool {
        self.key.read().unwrap().is_some() && !self.key_rejected.load(Ordering::Relaxed)
    }

    pub fn key_rejected(&self) -> bool {
        self.key_rejected.load(Ordering::Relaxed)
    }

    pub fn set_key(&self, key: Option<String>) {
        *self.key.write().unwrap() = key;
        self.key_rejected.store(false, Ordering::Relaxed);
    }

    fn failing(&self, job: &str) -> bool {
        let mut f = self.failed.lock().unwrap();
        match f.get(job) {
            Some(t) if t.elapsed() < FAILURE_BACKOFF => true,
            Some(_) => {
                f.remove(job);
                false
            }
            None => false,
        }
    }

    fn fail(&self, job: &str) {
        self.failed.lock().unwrap().insert(job.to_string(), Instant::now());
    }

    /// Forgets misses and network failures so everything is tried again.
    pub fn clear_misses(&self) -> usize {
        self.failed.lock().unwrap().clear();
        let n = self.remote.update(|r| r.clear_misses());
        self.sgdb.update(|s| {
            for e in s.entries.values_mut() {
                e.kinds.retain(|_, k| !k.images.is_empty());
            }
        });
        n
    }

    pub fn queue_lengths(&self) -> (usize, usize, usize) {
        let q = self.queues.lock().unwrap();
        (q.downloads.len(), q.lookups.len(), q.details.len())
    }

    fn mark_dirty(&self) {
        self.dirty.store(true, Ordering::Relaxed);
    }
}

/// Images the user chose from disk (`{ "custom": "<name>" }` overrides). Kept with the data,
/// not in the disposable cache.
pub fn custom_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("art").join("custom")
}

/// The resolver's view of the network state, with the user's settings applied.
pub struct NetView<'a> {
    pub net: &'a Net,
    pub settings: ArtSettings,
    pub now: u64,
}

impl<'a> NetView<'a> {
    pub fn new(state: &'a AppState) -> Self {
        NetView { net: &state.net, settings: state.settings.read(|s| s.art.clone()), now: now_secs() }
    }
}

impl ArtSources for NetView<'_> {
    fn remote(&self, url: &str) -> RemoteState {
        if self.net.failing(&job_download(url)) {
            return RemoteState::Missing;
        }
        self.net.remote.read(|r| r.state(url, &self.net.originals, self.now, self.settings.retry_missing_days))
    }

    fn lookup(&self, entry_id: &str, kind: &str) -> LookupState {
        if !self.net.sgdb_on() {
            return LookupState::Off;
        }
        if self.net.failing(&job_lookup(entry_id)) {
            return LookupState::Found(Vec::new());
        }
        self.net.sgdb.read(|s| match s.entries.get(entry_id).and_then(|e| e.kinds.get(kind)) {
            None => LookupState::Unknown,
            Some(k) if k.images.is_empty() && !remote::miss_holds(k.at, self.now, self.settings.retry_missing_days) => LookupState::Unknown,
            Some(k) => LookupState::Found(k.images.iter().map(|i| i.url.clone()).collect()),
        })
    }

    fn store_downloads(&self) -> bool {
        self.settings.store_art
    }

    fn custom_dir(&self) -> Option<PathBuf> {
        Some(self.net.custom.clone())
    }

    fn details(&self, record_id: &str) -> Option<Metadata> {
        let appid = record_id.strip_prefix("steam:")?;
        if !self.settings.fetch_details {
            return None;
        }
        self.net.details.read(|d| d.apps.get(appid).and_then(|r| r.metadata.clone()))
    }
}

fn job_download(url: &str) -> String {
    format!("d:{url}")
}
fn job_lookup(entry_id: &str) -> String {
    format!("l:{entry_id}")
}
fn job_details(appid: &str) -> String {
    format!("m:{appid}")
}

/// What one sweep found to do.
#[derive(Debug, Default, PartialEq)]
pub struct Plan {
    downloads: Vec<String>,
    lookups: Vec<LookupJob>,
    details: Vec<String>,
}

/// Lists the downloads, lookups and store-details fetches the library needs right now.
pub fn plan(state: &AppState) -> Plan {
    let view = NetView::new(state);
    let active = state.active_providers();
    let mut plan = Plan::default();
    let mut seen = HashSet::new();
    state.library.read(|snap| {
        state.userdata.read(|ud| {
            for (pid, recs) in snap.providers.iter().filter(|(p, _)| active.contains(*p)) {
                for g in &recs.games {
                    let id = library::record_id(pid, &g.source_id);
                    let cands = recs.art.get(&g.source_id).map(Vec::as_slice).unwrap_or(&[]);
                    let overrides = ud.games.get(&id).map(|u| &u.art_overrides);
                    let mut lookup_kinds = Vec::new();
                    for kind in ART_KINDS {
                        for w in resolve::resolve(&id, kind, cands, overrides, &view).wants {
                            match w {
                                Want::Download(u) => {
                                    if seen.insert(u.clone()) {
                                        plan.downloads.push(u);
                                    }
                                }
                                Want::Lookup => lookup_kinds.push(kind.to_string()),
                            }
                        }
                    }
                    if !lookup_kinds.is_empty() {
                        let target = if pid == "steam" { LookupTarget::Steam(g.source_id.clone()) } else { LookupTarget::Title(g.title.clone()) };
                        plan.lookups.push(LookupJob { entry_id: id.clone(), target, kinds: lookup_kinds });
                    }
                    if pid == "steam" && view.settings.fetch_details {
                        let rec = state.net.details.read(|d| d.apps.get(&g.source_id).cloned());
                        if details::due(rec.as_ref(), view.now, view.settings.refresh_details_days) {
                            plan.details.push(g.source_id.clone());
                        }
                    }
                }
            }
        })
    });
    plan
}

/// Queues a plan's jobs (skipping ones already queued or backing off) and wakes the workers.
fn enqueue(net: &Net, plan: Plan) -> usize {
    let mut q = net.queues.lock().unwrap();
    let mut added = 0;
    for u in plan.downloads {
        let k = job_download(&u);
        if !net.failing(&k) && q.busy.insert(k) {
            q.downloads.push_back(u);
            added += 1;
        }
    }
    for j in plan.lookups {
        let k = job_lookup(&j.entry_id);
        if !net.failing(&k) && q.busy.insert(k) {
            q.lookups.push_back(j);
            added += 1;
        }
    }
    for a in plan.details {
        let k = job_details(&a);
        if q.busy.insert(k) {
            q.details.push_back(a);
            added += 1;
        }
    }
    drop(q);
    if added > 0 {
        net.wake.notify_all();
    }
    added
}

/// Resolves the library and queues whatever it is missing.
pub fn sweep(app: &AppHandle) {
    let state = app.state::<AppState>();
    let added = enqueue(&state.net, plan(&state));
    if added > 0 {
        tracing::info!(jobs = added, "art and details queued");
    }
}

/// Queues store details for every Steam game, due or not ("Refresh details now").
pub fn refresh_all_details(app: &AppHandle) -> usize {
    let state = app.state::<AppState>();
    let appids: Vec<String> = state.library.read(|snap| snap.providers.get("steam").map(|r| r.games.iter().map(|g| g.source_id.clone()).collect()).unwrap_or_default());
    let n = appids.len();
    enqueue(&state.net, Plan { details: appids, ..Default::default() });
    n
}

/// Downloads one URL now, on the caller's thread (the Change art dialog's previews).
pub fn fetch_now(state: &AppState, url: &str) -> RemoteState {
    let view = NetView::new(state);
    match view.remote(url) {
        RemoteState::Unknown => {}
        s => return s,
    }
    run_download(&state.net, &agent(), url);
    NetView::new(state).remote(url)
}

fn run_download(net: &Net, agent: &ureq::Agent, url: &str) {
    match remote::download(agent, url, &net.originals, now_secs()) {
        remote::Outcome::Saved(rec) => {
            net.remote.update(|r| r.urls.insert(url.to_string(), rec));
        }
        remote::Outcome::Miss(why) => {
            tracing::debug!(url, why, "art not found");
            net.remote.update(|r| r.urls.insert(url.to_string(), remote::RemoteRecord { missed_at: Some(now_secs()), ..Default::default() }));
        }
        remote::Outcome::Failed(why) => {
            tracing::info!(url, why, "art download failed; will retry later");
            net.fail(&job_download(url));
        }
    }
}

/// SteamGridDB lookups for one entry and the kinds it needs.
fn run_lookup(net: &Net, agent: &ureq::Agent, job: &LookupJob) {
    let Some(key) = net.key().filter(|_| net.sgdb_on()) else { return };
    let base = sgdb::api_base();
    let now = now_secs();
    let target = match &job.target {
        LookupTarget::Steam(appid) => sgdb::Target::Steam(appid.clone()),
        LookupTarget::Title(title) => {
            match net.sgdb.read(|s| s.entries.get(&job.entry_id).and_then(|e| e.game_id)) {
                Some(g) => sgdb::Target::Game(g),
                None => match sgdb::search(agent, &base, &key, title) {
                    Ok(Some(g)) => {
                        net.sgdb.update(|s| s.entries.entry(job.entry_id.clone()).or_default().game_id = Some(g));
                        sgdb::Target::Game(g)
                    }
                    Ok(None) => {
                        // Not on SteamGridDB: remember the empty answer like a miss.
                        net.sgdb.update(|s| {
                            let e = s.entries.entry(job.entry_id.clone()).or_default();
                            for k in &job.kinds {
                                e.kinds.insert(k.clone(), sgdb::SgdbKind { at: now, images: Vec::new() });
                            }
                        });
                        return;
                    }
                    Err(e) => return lookup_failed(net, &job.entry_id, e),
                },
            }
        }
    };
    for kind in &job.kinds {
        match sgdb::images(agent, &base, &key, kind, &target) {
            Ok(images) => net.sgdb.update(|s| {
                s.entries.entry(job.entry_id.clone()).or_default().kinds.insert(kind.clone(), sgdb::SgdbKind { at: now, images });
            }),
            Err(e) => return lookup_failed(net, &job.entry_id, e),
        }
    }
}

fn lookup_failed(net: &Net, entry_id: &str, e: sgdb::LookupError) {
    match e {
        sgdb::LookupError::BadKey => {
            if !net.key_rejected.swap(true, Ordering::Relaxed) {
                tracing::warn!("SteamGridDB refused the API key; lookups stop until it is changed");
            }
        }
        sgdb::LookupError::NotFound => {}
        sgdb::LookupError::Failed(why) => {
            tracing::info!(entry = entry_id, why, "SteamGridDB lookup failed; will retry later");
            net.fail(&job_lookup(entry_id));
        }
    }
}

fn run_details(net: &Net, agent: &ureq::Agent, appid: &str) -> Result<(), ()> {
    match details::fetch(agent, &details::api_base(), appid) {
        Ok(metadata) => {
            net.details.update(|d| d.apps.insert(appid.to_string(), details::DetailsRecord { at: now_secs(), metadata }));
            Ok(())
        }
        Err(details::FetchError::Limited) => Err(()),
        Err(details::FetchError::Failed(why)) => {
            tracing::info!(appid, why, "store details fetch failed; will retry next sweep");
            Ok(())
        }
    }
}

enum Job {
    Download(String),
    Lookup(LookupJob),
    Details(String),
}

#[derive(Clone, Copy)]
enum Pool {
    Downloads,
    Lookups,
    Details,
}

fn next_job(net: &Net, pool: Pool) -> Job {
    let mut q = net.queues.lock().unwrap();
    loop {
        let job = match pool {
            Pool::Downloads => q.downloads.pop_front().map(Job::Download),
            Pool::Lookups => q.lookups.pop_front().map(Job::Lookup),
            Pool::Details => q.details.pop_front().map(Job::Details),
        };
        if let Some(j) = job {
            return j;
        }
        q = net.wake.wait(q).unwrap();
    }
}

fn finish(net: &Net, key: &str) {
    net.queues.lock().unwrap().busy.remove(key);
    net.mark_dirty();
}

fn worker(app: AppHandle, pool: Pool) {
    let agent = agent();
    let mut last_details: Option<Instant> = None;
    loop {
        let state = app.state::<AppState>();
        let net = &state.net;
        match next_job(net, pool) {
            Job::Download(url) => {
                run_download(net, &agent, &url);
                finish(net, &job_download(&url));
            }
            Job::Lookup(job) => {
                run_lookup(net, &agent, &job);
                finish(net, &job_lookup(&job.entry_id));
            }
            Job::Details(appid) => {
                if let Some(until) = *net.details_paused_until.lock().unwrap() {
                    std::thread::sleep(until.saturating_duration_since(Instant::now()));
                }
                if let Some(t) = last_details {
                    std::thread::sleep(Duration::from_millis(details::SPACING_MS).saturating_sub(t.elapsed()));
                }
                last_details = Some(Instant::now());
                if !state.settings.read(|s| s.art.fetch_details) {
                    finish(net, &job_details(&appid));
                    continue;
                }
                if run_details(net, &agent, &appid).is_err() {
                    tracing::info!("Steam store rate limit reached; pausing details for 5 minutes");
                    *net.details_paused_until.lock().unwrap() = Some(Instant::now() + LIMIT_BACKOFF);
                    net.queues.lock().unwrap().details.push_back(appid);
                    continue;
                }
                finish(net, &job_details(&appid));
            }
        }
    }
}

/// Starts the worker pools and the settle loop that turns finished jobs into library changes.
pub fn start(app: &AppHandle) {
    let state = app.state::<AppState>();
    if state.net.started.swap(true, Ordering::Relaxed) {
        return;
    }
    let spawn = |name: String, f: Box<dyn FnOnce() + Send>| {
        let _ = std::thread::Builder::new().name(name).spawn(f);
    };
    for i in 0..DOWNLOAD_WORKERS {
        let a = app.clone();
        spawn(format!("art-dl-{i}"), Box::new(move || worker(a, Pool::Downloads)));
    }
    for i in 0..LOOKUP_WORKERS {
        let a = app.clone();
        spawn(format!("sgdb-{i}"), Box::new(move || worker(a, Pool::Lookups)));
    }
    let a = app.clone();
    spawn("store-details".into(), Box::new(move || worker(a, Pool::Details)));
    let a = app.clone();
    spawn(
        "art-settle".into(),
        Box::new(move || loop {
            std::thread::sleep(SETTLE);
            let state = a.state::<AppState>();
            if state.net.dirty.swap(false, Ordering::Relaxed) {
                sweep(&a);
                let _ = a.emit(crate::scanner::EVENT_LIBRARY_CHANGED, ());
            }
        }),
    );
    sweep(app);
}

/// Counts for the Art and metadata settings page.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetStats {
    pub images: usize,
    pub misses: usize,
    pub bytes: u64,
    pub details: usize,
    pub queued_downloads: usize,
    pub queued_lookups: usize,
    pub queued_details: usize,
}

pub fn stats(net: &Net) -> NetStats {
    let (images, misses, bytes) = net.remote.read(|r| r.counts());
    let (d, l, m) = net.queue_lengths();
    NetStats {
        images,
        misses,
        bytes,
        details: net.details.read(|d| d.apps.values().filter(|r| r.metadata.is_some()).count()),
        queued_downloads: d,
        queued_lookups: l,
        queued_details: m,
    }
}

/// Against the real servers; run with `cargo test live_ -- --ignored`.
#[cfg(test)]
mod live {
    #[test]
    #[ignore]
    fn live_steam_cdn_and_store_details() {
        let t = tempfile::tempdir().unwrap();
        let agent = super::agent();
        let url = "https://cdn.cloudflare.steamstatic.com/steam/apps/620/library_600x900_2x.jpg";
        match super::remote::download(&agent, url, t.path(), 0) {
            super::remote::Outcome::Saved(r) => assert_eq!((r.width, r.height), (Some(600), Some(900))),
            o => panic!("{o:?}"),
        }
        let missing = "https://cdn.cloudflare.steamstatic.com/steam/apps/620/no_such_image.jpg";
        assert!(matches!(super::remote::download(&agent, missing, t.path(), 0), super::remote::Outcome::Miss(_)));
        let m = super::details::fetch(&agent, &super::details::api_base(), "620").unwrap().unwrap();
        assert_eq!(m.developer.as_deref(), Some("Valve"));
        assert_eq!(m.release_date.as_deref(), Some("2011-04-18"));
        assert!(m.description.is_some() && !m.genres.is_empty(), "{m:?}");
        println!("{m:?}");
    }

    #[test]
    #[ignore]
    fn live_steamgriddb_rejects_a_bad_key() {
        let e = super::sgdb::check_key(&super::agent(), &super::sgdb::api_base(), "0000000000000000").unwrap_err();
        assert!(e.contains("accept"), "{e}");
    }
}
