use std::path::Path;

use tracing_appender::non_blocking::WorkerGuard;
use tracing_appender::rolling::{Builder, Rotation};
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

const KEEP_DAYS: usize = 7;

/// Daily rolling log files in `<data>/logs`, keeping a week; also stderr in debug builds.
/// The returned guard must live until exit so buffered lines are flushed.
pub fn init(logs_dir: &Path) -> Option<WorkerGuard> {
    let filter = EnvFilter::try_from_env("VELLUM_LOG").unwrap_or_else(|_| EnvFilter::new("info"));
    let appender = Builder::new()
        .rotation(Rotation::DAILY)
        .filename_prefix("vellum")
        .filename_suffix("log")
        .max_log_files(KEEP_DAYS)
        .build(logs_dir);

    let (file_layer, guard) = match appender {
        Ok(a) => {
            let (writer, guard) = tracing_appender::non_blocking(a);
            (Some(fmt::layer().with_writer(writer).with_ansi(false)), Some(guard))
        }
        Err(e) => {
            eprintln!("logging to file disabled: {e}");
            (None, None)
        }
    };
    let stderr_layer = cfg!(debug_assertions).then(|| fmt::layer().with_writer(std::io::stderr));

    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(file_layer)
        .with(stderr_layer)
        .try_init();
    guard
}
