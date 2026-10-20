//! Runs one provider function in a fresh, sandboxed QuickJS runtime.
//!
//! The provider sees only `ctx` (built by `PRELUDE` over native functions). Every file read
//! is scope-checked, registry reads and URI schemes are allowlisted, and each call has a
//! memory cap and a deadline enforced by the interrupt handler. A runtime is never reused
//! (decision: docs/decisions.md, "Provider sandbox").

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

use rquickjs::loader::{ImportAttributes, Loader, Resolver};
use rquickjs::module::Declared;
use rquickjs::{CatchResultExt, Context, Ctx, Exception, Function, Module, Object, Runtime, TypedArray};
use serde::Serialize;
use serde_json::{json, Value};

use super::locations::Registry;
use super::model::ProviderSpec;
use super::scope::{simplify, Scope};
use crate::formats;
use crate::platform::{self, Hive};

const MEMORY_LIMIT: usize = 256 * 1024 * 1024;
const STACK_LIMIT: usize = 1024 * 1024;

/// Side effects a provider can cause outside the sandbox, injectable for tests.
pub trait Opener: Send + Sync {
    fn open_uri(&self, uri: &str) -> Result<(), String>;
    fn run(&self, exe: &Path, args: &[String], cwd: Option<&Path>) -> Result<(), String>;
}

pub struct SystemOpener;

impl Opener for SystemOpener {
    fn open_uri(&self, uri: &str) -> Result<(), String> {
        platform::open_uri(uri).map_err(|e| e.to_string())
    }

    fn run(&self, exe: &Path, args: &[String], cwd: Option<&Path>) -> Result<(), String> {
        let mut cmd = std::process::Command::new(exe);
        cmd.args(args);
        if let Some(d) = cwd.or_else(|| exe.parent()) {
            cmd.current_dir(d);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const DETACHED_PROCESS: u32 = 0x0000_0008;
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
            cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
        }
        cmd.spawn().map(|_| ()).map_err(|e| format!("could not start {}: {e}", exe.display()))
    }
}

/// Records instead of acting; used by tests and the mock flows.
#[derive(Default)]
pub struct RecordingOpener {
    pub calls: Mutex<Vec<String>>,
}

impl Opener for RecordingOpener {
    fn open_uri(&self, uri: &str) -> Result<(), String> {
        self.calls.lock().unwrap().push(format!("uri {uri}"));
        Ok(())
    }

    fn run(&self, exe: &Path, args: &[String], _cwd: Option<&Path>) -> Result<(), String> {
        self.calls.lock().unwrap().push(format!("run {} {}", exe.display(), args.join(" ")));
        Ok(())
    }
}

#[derive(Clone)]
pub struct HostEnv {
    pub registry: Arc<dyn Registry>,
    pub opener: Arc<dyn Opener>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Scan,
    Launch,
    Install,
    Uninstall,
    OpenStore,
    Watch,
}

impl Method {
    fn js_name(self) -> &'static str {
        match self {
            Method::Scan => "scan",
            Method::Launch => "launch",
            Method::Install => "install",
            Method::Uninstall => "uninstall",
            Method::OpenStore => "openStore",
            Method::Watch => "watch",
        }
    }

    pub fn timeout(self) -> Duration {
        match self {
            Method::Scan => Duration::from_secs(30),
            _ => Duration::from_secs(10),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct LogLine {
    pub level: &'static str,
    pub message: String,
}

#[derive(Debug)]
pub struct Output {
    pub value: Value,
    /// Folders the provider added with `ctx.fs.allow` during this call.
    pub derived: Vec<PathBuf>,
    pub logs: Vec<LogLine>,
}

#[derive(Debug, thiserror::Error)]
pub enum HostError {
    #[error("could not load the provider: {0}")]
    Load(String),
    #[error("the provider has no {0}() function")]
    Missing(&'static str),
    #[error("timed out after {0} seconds")]
    Timeout(u64),
    #[error("ran out of memory (limit 256 MB)")]
    Memory,
    #[error("{0}")]
    Script(String),
}

/// What one call may touch.
pub struct Invocation<'a> {
    pub spec: &'a ProviderSpec,
    /// Resolved declared locations.
    pub locations: &'a BTreeMap<String, PathBuf>,
    /// Folders allowed by an earlier scan via `ctx.fs.allow`.
    pub derived: &'a [PathBuf],
    pub env: &'a HostEnv,
    /// Overrides the method's default deadline (tests).
    pub timeout: Option<Duration>,
}

struct HostState {
    scope: Scope,
    env: HostEnv,
    registry_read: Vec<String>,
    uri_schemes: Vec<String>,
    derived_allowed: bool,
    /// For launch-type calls: the game's install folder, where `ctx.run` may also start exes.
    install_dir: Option<PathBuf>,
    derived: Mutex<Vec<PathBuf>>,
    logs: Mutex<Vec<LogLine>>,
    provider: String,
}

impl HostState {
    fn log(&self, level: &'static str, message: String) {
        match level {
            "error" => tracing::error!(provider = %self.provider, "{message}"),
            "warn" => tracing::warn!(provider = %self.provider, "{message}"),
            _ => tracing::info!(provider = %self.provider, "{message}"),
        }
        self.logs.lock().unwrap().push(LogLine { level, message });
    }

    /// `HKCU\Software\Valve\Steam` is readable when a `registryRead` entry is a prefix of it
    /// at a key boundary.
    fn registry_allowed(&self, hive: Hive, key: &str) -> bool {
        let full = format!("{hive}\\{}", key.trim_matches('\\')).to_lowercase();
        self.registry_read.iter().any(|p| {
            let p = p.trim_matches('\\').to_lowercase();
            full == p || full.starts_with(&format!("{p}\\"))
        })
    }
}

fn mtime_ms(m: &std::fs::Metadata) -> u64 {
    m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64)
}

fn stat_json(p: &Path) -> Value {
    match std::fs::metadata(p) {
        Ok(m) => json!({ "isDir": m.is_dir(), "size": m.len(), "mtime": mtime_ms(&m) }),
        Err(_) => Value::Null,
    }
}

/// The provider-facing API. Native functions live on a private object that is deleted
/// once `ctx` captures them, so provider code can only reach them through `ctx`.
const PRELUDE: &str = r#"
const h = globalThis.__host;
delete globalThis.__host;
const str = (v) => String(v);
const level = (l) => (...a) => h.log(l, a.map(str).join(" "));
globalThis.__ctx = Object.freeze({
  locations: Object.freeze(JSON.parse(h.locationsJson)),
  fs: Object.freeze({
    readText: (p) => h.readText(str(p)),
    readBytes: (p) => h.readBytes(str(p)),
    list: (d) => JSON.parse(h.list(str(d))),
    glob: (d, pattern) => JSON.parse(h.glob(str(d), str(pattern))),
    exists: (p) => h.exists(str(p)),
    stat: (p) => JSON.parse(h.stat(str(p))),
    allow: (d) => h.allow(str(d)),
  }),
  registry: Object.freeze({
    get: (hive, key, value) => h.regGet(str(hive), str(key), str(value)) ?? null,
    subkeys: (hive, key) => JSON.parse(h.regSubkeys(str(hive), str(key))),
  }),
  formats: Object.freeze({
    vdf: (text) => JSON.parse(h.vdf(str(text))),
    binaryVdf: (bytes) => JSON.parse(h.binaryVdf(bytes)),
  }),
  sqlite: Object.freeze({
    query() { throw new Error("ctx.sqlite is not available in this version of the host"); },
  }),
  env: Object.freeze({ expand: (s) => h.expand(str(s)) }),
  openUri: (uri) => h.openUri(str(uri)),
  run: (exe, args = [], cwd = null) => h.run(str(exe), JSON.stringify((args ?? []).map(str)), cwd == null ? "" : str(cwd)),
  settings: Object.freeze(JSON.parse(h.settingsJson)),
  log: Object.freeze({ info: level("info"), warn: level("warn"), error: level("error") }),
});
"#;

fn install_host<'js>(ctx: &Ctx<'js>, st: &Arc<HostState>, locations_json: String, settings_json: String) -> rquickjs::Result<()> {
    let h = Object::new(ctx.clone())?;
    let throw = |ctx: &Ctx<'js>, msg: String| Exception::throw_message(ctx, &msg);
    h.set("locationsJson", locations_json)?;
    h.set("settingsJson", settings_json)?;

    let s = st.clone();
    h.set(
        "readText",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, path: String| -> rquickjs::Result<String> {
            let p = s.scope.check(&path).map_err(|e| throw(&ctx, e.to_string()))?;
            let bytes = std::fs::read(p).map_err(|e| throw(&ctx, format!("{path}: {e}")))?;
            let text = String::from_utf8_lossy(&bytes);
            Ok(text.strip_prefix('\u{feff}').unwrap_or(&text).to_string())
        })?,
    )?;
    let s = st.clone();
    h.set(
        "readBytes",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, path: String| -> rquickjs::Result<TypedArray<'js, u8>> {
            let p = s.scope.check(&path).map_err(|e| throw(&ctx, e.to_string()))?;
            let bytes = std::fs::read(p).map_err(|e| throw(&ctx, format!("{path}: {e}")))?;
            TypedArray::new(ctx, bytes)
        })?,
    )?;
    let s = st.clone();
    h.set(
        "list",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, dir: String| -> rquickjs::Result<String> {
            let d = s.scope.check(&dir).map_err(|e| throw(&ctx, e.to_string()))?;
            let rd = std::fs::read_dir(&d).map_err(|e| throw(&ctx, format!("{dir}: {e}")))?;
            let mut items: Vec<Value> = rd
                .filter_map(Result::ok)
                .filter_map(|e| {
                    let m = e.metadata().ok()?;
                    Some(json!({
                        "name": e.file_name().to_string_lossy(),
                        "isDir": m.is_dir(),
                        "size": m.len(),
                        "mtime": mtime_ms(&m),
                    }))
                })
                .collect();
            items.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
            Ok(Value::Array(items).to_string())
        })?,
    )?;
    let s = st.clone();
    h.set(
        "glob",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, dir: String, pattern: String| -> rquickjs::Result<String> {
            let d = s.scope.check(&dir).map_err(|e| throw(&ctx, e.to_string()))?;
            let found: Vec<String> = super::scope::glob(&d, &pattern)
                .into_iter()
                .filter(|p| !s.scope.is_denied(p))
                .map(|p| simplify(&p).to_string_lossy().into_owned())
                .collect();
            Ok(serde_json::to_string(&found).unwrap())
        })?,
    )?;
    h.set("exists", Function::new(ctx.clone(), |path: String| Path::new(&path).exists())?)?;
    h.set("stat", Function::new(ctx.clone(), |path: String| stat_json(Path::new(&path)).to_string())?)?;
    let s = st.clone();
    h.set(
        "allow",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, dir: String| -> rquickjs::Result<String> {
            if !s.derived_allowed {
                return Err(throw(&ctx, "ctx.fs.allow needs \"derivedLocations\": true in the manifest".into()));
            }
            let c = s.scope.add_root(Path::new(&dir)).ok_or_else(|| throw(&ctx, format!("not a folder: {dir}")))?;
            let c = simplify(&c);
            s.derived.lock().unwrap().push(c.clone());
            Ok(c.to_string_lossy().into_owned())
        })?,
    )?;
    let s = st.clone();
    h.set(
        "regGet",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, hive: String, key: String, value: String| -> rquickjs::Result<Option<String>> {
            let hive: Hive = hive.parse().map_err(|e: String| throw(&ctx, e))?;
            if !s.registry_allowed(hive, &key) {
                return Err(throw(&ctx, format!("registry key not in registryRead: {hive}\\{key}")));
            }
            Ok(s.env.registry.get(hive, &key, &value))
        })?,
    )?;
    let s = st.clone();
    h.set(
        "regSubkeys",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, hive: String, key: String| -> rquickjs::Result<String> {
            let hive: Hive = hive.parse().map_err(|e: String| throw(&ctx, e))?;
            if !s.registry_allowed(hive, &key) {
                return Err(throw(&ctx, format!("registry key not in registryRead: {hive}\\{key}")));
            }
            Ok(serde_json::to_string(&s.env.registry.subkeys(hive, &key)).unwrap())
        })?,
    )?;
    h.set(
        "vdf",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, text: String| -> rquickjs::Result<String> {
            formats::vdf::parse(&text).map(|v| v.to_string()).map_err(|e| throw(&ctx, format!("VDF: {e}")))
        })?,
    )?;
    h.set(
        "binaryVdf",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, bytes: TypedArray<'js, u8>| -> rquickjs::Result<String> {
            // SAFETY: the bytes are copied out before any JavaScript can run again.
            let b = unsafe { bytes.as_bytes() }
                .map(<[u8]>::to_vec)
                .ok_or_else(|| throw(&ctx, "binaryVdf needs a Uint8Array".into()))?;
            formats::binary_vdf::parse(&b).map(|v| v.to_string()).map_err(|e| throw(&ctx, format!("binary VDF: {e}")))
        })?,
    )?;
    h.set("expand", Function::new(ctx.clone(), |s: String| platform::expand_env(&s))?)?;
    let s = st.clone();
    h.set(
        "openUri",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, uri: String| -> rquickjs::Result<()> {
            let scheme = uri.split(':').next().unwrap_or("").to_lowercase();
            if !s.uri_schemes.iter().any(|u| u.eq_ignore_ascii_case(&scheme)) {
                return Err(throw(&ctx, format!("URI scheme not in uriSchemes: {scheme}")));
            }
            s.log("info", format!("open {uri}"));
            s.env.opener.open_uri(&uri).map_err(|e| throw(&ctx, e))
        })?,
    )?;
    let s = st.clone();
    h.set(
        "run",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, exe: String, args: String, cwd: String| -> rquickjs::Result<()> {
            let exe_path = PathBuf::from(&exe);
            if !exe_path.is_file() || !s.scope.contains(&exe_path, s.install_dir.as_deref()) {
                return Err(throw(&ctx, format!("ctx.run: exe is missing or outside allowed folders: {exe}")));
            }
            let args: Vec<String> = serde_json::from_str(&args).unwrap_or_default();
            let cwd = (!cwd.is_empty()).then(|| PathBuf::from(&cwd));
            if cwd.as_ref().is_some_and(|c| !c.is_dir()) {
                return Err(throw(&ctx, format!("ctx.run: working directory does not exist: {cwd:?}")));
            }
            s.log("info", format!("run {exe}"));
            s.env.opener.run(&exe_path, &args, cwd.as_deref()).map_err(|e| throw(&ctx, e))
        })?,
    )?;
    let s = st.clone();
    h.set(
        "log",
        Function::new(ctx.clone(), move |level: String, msg: String| {
            let level = match level.as_str() {
                "error" => "error",
                "warn" => "warn",
                _ => "info",
            };
            s.log(level, msg);
        })?,
    )?;
    ctx.globals().set("__host", h)?;
    ctx.eval::<(), _>(PRELUDE)?;
    Ok(())
}

/// Resolves imports only to files inside the provider's own folder.
struct PluginResolver {
    root: PathBuf,
}

impl Resolver for PluginResolver {
    fn resolve<'js>(&mut self, ctx: &Ctx<'js>, base: &str, name: &str, _: Option<ImportAttributes<'js>>) -> rquickjs::Result<String> {
        if !(name.starts_with("./") || name.starts_with("../")) {
            return Err(Exception::throw_message(ctx, &format!("import not allowed (only ./relative files): {name}")));
        }
        let mut out = PathBuf::new();
        for c in Path::new(base).parent().unwrap_or(Path::new("")).join(name).components() {
            match c {
                std::path::Component::Normal(s) => out.push(s),
                std::path::Component::CurDir => {}
                std::path::Component::ParentDir if out.pop() => {}
                _ => return Err(Exception::throw_message(ctx, &format!("import outside the plugin folder: {name}"))),
            }
        }
        if !self.root.join(&out).is_file() {
            return Err(Exception::throw_message(ctx, &format!("import not found: {name}")));
        }
        Ok(out.to_string_lossy().replace('\\', "/"))
    }
}

struct PluginLoader {
    root: PathBuf,
}

impl Loader for PluginLoader {
    fn load<'js>(&mut self, ctx: &Ctx<'js>, name: &str, _: Option<ImportAttributes<'js>>) -> rquickjs::Result<Module<'js, Declared>> {
        let src = std::fs::read(self.root.join(name)).map_err(|e| Exception::throw_message(ctx, &format!("{name}: {e}")))?;
        Module::declare(ctx.clone(), name, src)
    }
}

fn classify(message: String, timeout: Duration) -> HostError {
    if message.contains("interrupted") {
        HostError::Timeout(timeout.as_secs())
    } else if message.contains("out of memory") {
        HostError::Memory
    } else {
        HostError::Script(message)
    }
}

/// Calls `method` on the provider's default export with `(ctx, arg)`.
pub fn invoke(inv: &Invocation, method: Method, arg: Option<&Value>) -> Result<Output, HostError> {
    let spec = inv.spec;
    let roots = inv.locations.values().cloned().chain(inv.derived.iter().cloned());
    let install_dir = arg
        .and_then(|g| g.get("installDir"))
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .filter(|d| d.is_dir());
    let st = Arc::new(HostState {
        scope: Scope::new(roots, &spec.deny_files),
        env: inv.env.clone(),
        registry_read: spec.registry_read.clone(),
        uri_schemes: spec.uri_schemes.clone(),
        derived_allowed: spec.derived_locations,
        install_dir,
        derived: Mutex::new(Vec::new()),
        logs: Mutex::new(Vec::new()),
        provider: spec.id.clone(),
    });

    let rt = Runtime::new().map_err(|e| HostError::Load(e.to_string()))?;
    rt.set_memory_limit(MEMORY_LIMIT);
    rt.set_max_stack_size(STACK_LIMIT);
    let timeout = inv.timeout.unwrap_or(method.timeout());
    let deadline = Instant::now() + timeout;
    rt.set_interrupt_handler(Some(Box::new(move || Instant::now() > deadline)));
    rt.set_loader(PluginResolver { root: spec.dir.clone() }, PluginLoader { root: spec.dir.clone() });
    let context = Context::full(&rt).map_err(|e| HostError::Load(e.to_string()))?;

    let locations_json = serde_json::to_string(
        &inv.locations.iter().map(|(k, v)| (k.clone(), v.to_string_lossy().into_owned())).collect::<BTreeMap<_, _>>(),
    )
    .unwrap();
    let settings_json = Value::Object(spec.settings.clone()).to_string();
    let arg_json = arg.map(Value::to_string);
    let source = std::fs::read(spec.dir.join(&spec.entry)).map_err(|e| HostError::Load(format!("{}: {e}", spec.entry)))?;
    let entry_name = spec.entry.replace('\\', "/");

    let value = context.with(|ctx| -> Result<Value, HostError> {
        let caught = |e: rquickjs::CaughtError| classify(e.to_string(), timeout);
        install_host(&ctx, &st, locations_json, settings_json)
            .catch(&ctx)
            .map_err(|e| HostError::Load(e.to_string()))?;

        let (module, promise) = Module::declare(ctx.clone(), entry_name, source)
            .catch(&ctx)
            .map_err(|e| HostError::Load(e.to_string()))?
            .eval()
            .catch(&ctx)
            .map_err(|e| HostError::Load(e.to_string()))?;
        promise.finish::<()>().catch(&ctx).map_err(|e| HostError::Load(e.to_string()))?;

        let default: Object = module
            .get("default")
            .catch(&ctx)
            .map_err(|_| HostError::Load("the entry file has no default export".into()))?;
        let func: Function = default.get(method.js_name()).map_err(|_| HostError::Missing(method.js_name()))?;
        let pctx: Object = ctx.globals().get("__ctx").map_err(|e| HostError::Load(e.to_string()))?;
        let jarg = match &arg_json {
            Some(j) => ctx.json_parse(j.as_str()).catch(&ctx).map_err(caught)?,
            None => rquickjs::Value::new_undefined(ctx.clone()),
        };
        let mut result: rquickjs::Value = func.call((pctx, jarg)).catch(&ctx).map_err(caught)?;
        if let Some(p) = result.as_promise() {
            result = p.finish::<rquickjs::Value>().catch(&ctx).map_err(caught)?;
        }
        if result.is_undefined() {
            return Ok(Value::Null);
        }
        let text = ctx
            .json_stringify(result)
            .catch(&ctx)
            .map_err(caught)?
            .map(|s| s.to_string())
            .transpose()
            .map_err(|e| HostError::Script(e.to_string()))?;
        match text {
            Some(t) => serde_json::from_str(&t).map_err(|e| HostError::Script(format!("returned invalid data: {e}"))),
            None => Ok(Value::Null),
        }
    })?;

    let derived = std::mem::take(&mut *st.derived.lock().unwrap());
    let logs = std::mem::take(&mut *st.logs.lock().unwrap());
    Ok(Output { value, derived, logs })
}
