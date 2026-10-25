pub mod art;
pub mod catalog;
pub mod cli;
mod commands;
pub mod diagnose;
pub mod formats;
pub mod library;
pub mod logging;
pub mod net;
pub mod paths;
pub mod platform;
pub mod plugins;
pub mod protocols;
pub mod providers;
pub mod scanner;
pub mod skins;
pub mod userdata;
pub mod util;
pub mod versions;
pub mod window_state;

use std::sync::{Arc, RwLock};

use tauri::{Manager, RunEvent};

use crate::library::LibrarySnapshot;
use crate::paths::AppPaths;
use crate::plugins::PluginRecord;
use crate::providers::host::{HostEnv, SystemOpener};
use crate::providers::locations::SystemRegistry;
use crate::userdata::games::UserData;
use crate::userdata::settings::Settings;
use crate::userdata::store::JsonStore;

/// The product name in one place, so the working name is easy to change.
pub const APP_NAME: &str = "Vellum";
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Event the shell listens to; payload is empty, the shell re-fetches.
pub const EVENT_PLUGINS_CHANGED: &str = "vellum://plugins-changed";

pub struct AppState {
    pub paths: AppPaths,
    pub settings: JsonStore<Settings>,
    pub userdata: JsonStore<UserData>,
    pub library: JsonStore<LibrarySnapshot>,
    pub plugins: RwLock<Vec<PluginRecord>>,
    pub runtime: scanner::Runtime,
    pub env: HostEnv,
    pub skins: skins::SkinRuntime,
    /// Remote art, SteamGridDB and store details.
    pub net: net::Net,
    /// `--dev` on the command line (the settings toggle is `ui.devMode`).
    pub dev_flag: bool,
}

impl AppState {
    pub fn rescan_plugins(&self) {
        let found = plugins::discover(&self.paths.plugin_roots());
        for p in found.iter().filter(|p| !p.is_valid()) {
            tracing::warn!(kind = p.kind.as_str(), id = %p.id, errors = ?p.errors, "invalid plugin");
        }
        tracing::info!(count = found.len(), "plugins scanned");
        *self.plugins.write().unwrap() = found;
    }
}

/// Handles flags that produce output and exit without a window. Returns true if one ran.
fn run_cli(args: &cli::Args, paths: &AppPaths) -> bool {
    if !(args.print_plugins || args.diagnose) {
        return false;
    }
    platform::attach_parent_console();
    if args.print_plugins {
        let json = serde_json::to_string_pretty(&plugins::discover(&paths.plugin_roots())).unwrap();
        match &args.out {
            Some(out) => std::fs::write(out, json).expect("write --out file"),
            None => println!("{json}"),
        }
    }
    if args.diagnose {
        let (report, summary) = diagnose::report(paths, &SystemRegistry);
        let out = args.out.clone().unwrap_or_else(|| "vellum-diagnostics.json".into());
        std::fs::write(&out, serde_json::to_string_pretty(&report).unwrap()).expect("write diagnostics report");
        println!("{APP_NAME} diagnostics (structure only; review before sharing):");
        for line in summary {
            println!("  {line}");
        }
        println!("Report written to {}", out.display());
    }
    true
}

pub fn run() {
    let args = cli::Args::parse(std::env::args().skip(1));
    let paths = match AppPaths::resolve(&args) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("{APP_NAME}: {e}");
            std::process::exit(1);
        }
    };
    if run_cli(&args, &paths) {
        return;
    }

    let _log_guard = logging::init(&paths.logs_dir());
    tracing::info!(version = APP_VERSION, data_dir = %paths.data_dir.display(), portable = paths.portable, "starting");

    let data = |name: &str| paths.data_dir.join(name);
    let state = AppState {
        settings: JsonStore::open(data("settings.json"), userdata::settings::load),
        userdata: JsonStore::open(data("userdata.json"), userdata::games::load),
        library: JsonStore::open(data("library-cache.json"), library::load_snapshot),
        plugins: RwLock::new(Vec::new()),
        runtime: scanner::Runtime::default(),
        env: HostEnv { registry: Arc::new(SystemRegistry), opener: Arc::new(SystemOpener) },
        skins: skins::SkinRuntime::default(),
        net: net::Net::open(&paths.data_dir),
        dev_flag: args.dev,
        paths,
    };
    state.rescan_plugins();

    let placement = window_state::Tracker::new(&state.paths.data_dir);
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .manage(placement)
        .on_window_event(|win, event| window_state::on_event(win.app_handle(), win, event))
        .register_asynchronous_uri_scheme_protocol(protocols::SKIN_SCHEME, |ctx, req, responder| {
            protocols::handle_skin(ctx.app_handle(), req, responder)
        })
        .setup(|app| {
            // The snapshot is already loaded; fresh results replace it as each provider finishes.
            scanner::scan_all(app.handle());
            net::start(app.handle());
            skins::apply_window(app.handle());
            // The window starts hidden (tauri.conf.json) so it never flashes at the default size.
            if let Some(win) = app.get_webview_window("main") {
                app.state::<window_state::Tracker>().restore(&win);
            }
            skins::update_dev_watch(app.handle());
            // Reaching the window means this version starts: it is no longer on trial.
            let paths = &app.state::<AppState>().paths;
            if let Some(root) = &paths.version_root {
                versions::confirm_start(root, &versions::running_version(&paths.exe_dir));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::list_plugins,
            commands::set_plugin_enabled,
            commands::activate_skin,
            commands::reload_plugins,
            commands::open_plugins_folder,
            commands::open_data_folder,
            commands::library_entries,
            commands::provider_statuses,
            commands::notices,
            commands::dismiss_notice,
            commands::set_location,
            commands::refresh_library,
            commands::run_action,
            commands::set_favorite,
            commands::set_hidden,
            commands::set_tags,
            commands::open_install_folder,
            commands::skin_info,
            commands::set_skin_option,
            commands::reset_skin_options,
            commands::use_fallback_skin,
            commands::ui_settings,
            commands::update_ui_settings,
            commands::window_action,
            commands::open_devtools,
            commands::open_logs_folder,
            commands::run_diagnostics,
            commands::skin_preview,
            commands::versions_info,
            commands::version_install,
            commands::version_remove,
            commands::version_activate,
            commands::open_versions_folder,
            commands::open_release_page,
            commands::catalog_info,
            commands::catalog_install,
            commands::catalog_remove,
            commands::catalog_preview,
            commands::art_settings,
            commands::set_art_settings,
            commands::set_steamgriddb_key,
            commands::retry_missing_art,
            commands::refresh_details_now,
            commands::art_choices,
            commands::art_thumb,
            commands::set_art_override,
            commands::set_art_override_file,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            let state = handle.state::<AppState>();
            state.settings.flush();
            state.userdata.flush();
            state.library.flush();
            state.net.flush();
            handle.state::<window_state::Tracker>().save();
            tracing::info!("exit");
        }
    });
}
