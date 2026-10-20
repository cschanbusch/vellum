use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;

use super::atomic;

const DEBOUNCE: Duration = Duration::from_millis(300);

enum Msg {
    Dirty,
    Flush(mpsc::Sender<()>),
}

struct Inner<T> {
    path: PathBuf,
    data: Mutex<T>,
}

impl<T: Serialize> Inner<T> {
    fn save(&self) {
        let bytes = {
            let data = self.data.lock().unwrap();
            serde_json::to_vec_pretty(&*data)
        };
        let result = bytes
            .map_err(std::io::Error::other)
            .and_then(|b| atomic::write(&self.path, &b));
        if let Err(e) = result {
            tracing::error!(path = %self.path.display(), error = %e, "failed to save");
        }
    }
}

/// A JSON file held in memory. Updates are written atomically on a background thread,
/// debounced so a burst of changes produces one write.
pub struct JsonStore<T> {
    inner: Arc<Inner<T>>,
    tx: mpsc::Sender<Msg>,
}

impl<T: Serialize + Send + 'static> JsonStore<T> {
    /// `load` turns the file's bytes (or `None` if it does not exist) into a value.
    pub fn open(path: PathBuf, load: impl FnOnce(&Path, Option<Vec<u8>>) -> T) -> Self {
        let bytes = std::fs::read(&path).ok();
        let data = load(&path, bytes);
        let inner = Arc::new(Inner { path, data: Mutex::new(data) });
        let (tx, rx) = mpsc::channel();
        let worker = inner.clone();
        std::thread::Builder::new()
            .name("json-store".into())
            .spawn(move || writer_loop(&worker, &rx))
            .expect("spawn store writer");
        JsonStore { inner, tx }
    }

    pub fn read<R>(&self, f: impl FnOnce(&T) -> R) -> R {
        f(&self.inner.data.lock().unwrap())
    }

    pub fn update<R>(&self, f: impl FnOnce(&mut T) -> R) -> R {
        let r = f(&mut self.inner.data.lock().unwrap());
        let _ = self.tx.send(Msg::Dirty);
        r
    }

    /// Blocks until any pending change is on disk.
    pub fn flush(&self) {
        let (ack_tx, ack_rx) = mpsc::channel();
        if self.tx.send(Msg::Flush(ack_tx)).is_ok() {
            let _ = ack_rx.recv_timeout(Duration::from_secs(5));
        }
    }
}

fn writer_loop<T: Serialize>(inner: &Inner<T>, rx: &mpsc::Receiver<Msg>) {
    let mut dirty = false;
    loop {
        let msg = if dirty { rx.recv_timeout(DEBOUNCE) } else { rx.recv().map_err(|_| RecvTimeoutError::Disconnected) };
        match msg {
            Ok(Msg::Dirty) => dirty = true,
            Ok(Msg::Flush(ack)) => {
                if dirty {
                    inner.save();
                    dirty = false;
                }
                let _ = ack.send(());
            }
            Err(RecvTimeoutError::Timeout) => {
                inner.save();
                dirty = false;
            }
            Err(RecvTimeoutError::Disconnected) => {
                if dirty {
                    inner.save();
                }
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Serialize, Default)]
    struct Counter {
        n: u32,
    }

    #[test]
    fn debounced_updates_reach_disk_on_flush() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("c.json");
        let store = JsonStore::open(path.clone(), |_, _| Counter::default());
        for _ in 0..50 {
            store.update(|c| c.n += 1);
        }
        store.flush();
        let saved: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved["n"], 50);
    }

    #[test]
    fn writes_after_quiet_period_without_flush() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("c.json");
        let store = JsonStore::open(path.clone(), |_, _| Counter::default());
        store.update(|c| c.n = 7);
        std::thread::sleep(DEBOUNCE * 3);
        assert!(path.exists());
    }
}
