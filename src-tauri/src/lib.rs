pub mod cli;
mod commands;
pub mod logging;
pub mod paths;
pub mod platform;
pub mod plugins;
pub mod userdata;

use std::sync::RwLock;

use tauri::{Manager, RunEvent};

use crate::paths::AppPaths;
use crate::plugins::PluginRecord;
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
    pub plugins: RwLock<Vec<PluginRecord>>,
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

pub fn run() {
    let args = cli::Args::parse(std::env::args().skip(1));
    let paths = match AppPaths::resolve(&args) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("{APP_NAME}: {e}");
            std::process::exit(1);
        }
    };

    if args.print_plugins {
        let found = plugins::discover(&paths.plugin_roots());
        let json = serde_json::to_string_pretty(&found).unwrap();
        match &args.out {
            Some(out) => std::fs::write(out, json).expect("write --out file"),
            None => println!("{json}"),
        }
        return;
    }

    let _log_guard = logging::init(&paths.logs_dir());
    tracing::info!(version = APP_VERSION, data_dir = %paths.data_dir.display(), portable = paths.portable, "starting");

    let settings = JsonStore::open(paths.data_dir.join("settings.json"), userdata::settings::load);
    let state = AppState {
        paths,
        settings,
        plugins: RwLock::new(Vec::new()),
    };
    state.rescan_plugins();

    let app = tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::list_plugins,
            commands::set_plugin_enabled,
            commands::activate_skin,
            commands::reload_plugins,
            commands::open_plugins_folder,
            commands::open_data_folder,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            handle.state::<AppState>().settings.flush();
            tracing::info!("exit");
        }
    });
}
