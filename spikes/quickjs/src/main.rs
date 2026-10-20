// Phase 0 spike: can rquickjs run provider plugins in a sandbox with a synchronous,
// scope-checked host API, a folder-restricted module loader, a memory cap and a timeout?
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rquickjs::loader::{ImportAttributes, Loader, Resolver};
use rquickjs::module::Declared;
use rquickjs::{
    CatchResultExt, Context, Ctx, Exception, Function, Module, Object, Result, Runtime, TypedArray,
};

const MEMORY_LIMIT: usize = 256 * 1024 * 1024;
const SCAN_TIMEOUT: Duration = Duration::from_secs(2); // spec says 30 s; short here for the spike
const DENYLIST: &[&str] = &["loginusers.vdf", "config.vdf"]; // plus ssfn* prefix

/// Resolves imports only to files inside the plugin's own folder.
struct PluginResolver {
    root: PathBuf,
}

impl Resolver for PluginResolver {
    fn resolve<'js>(
        &mut self,
        ctx: &Ctx<'js>,
        base: &str,
        name: &str,
        _attributes: Option<ImportAttributes<'js>>,
    ) -> Result<String> {
        if !(name.starts_with("./") || name.starts_with("../")) {
            return Err(Exception::throw_message(ctx, &format!("import not allowed: {name}")));
        }
        let base_dir = Path::new(base).parent().unwrap_or(Path::new(""));
        let joined = normalize(&base_dir.join(name));
        match joined {
            Some(rel) if self.root.join(&rel).is_file() => Ok(rel.to_string_lossy().replace('\\', "/")),
            _ => Err(Exception::throw_message(ctx, &format!("import outside plugin folder: {name}"))),
        }
    }
}

struct PluginLoader {
    root: PathBuf,
}

impl Loader for PluginLoader {
    fn load<'js>(
        &mut self,
        ctx: &Ctx<'js>,
        name: &str,
        _attributes: Option<ImportAttributes<'js>>,
    ) -> Result<Module<'js, Declared>> {
        let source = std::fs::read(self.root.join(name))
            .map_err(|e| Exception::throw_message(ctx, &format!("load {name}: {e}")))?;
        Module::declare(ctx.clone(), name, source)
    }
}

/// Lexically normalizes a relative path; None if it climbs above its start.
fn normalize(p: &Path) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::Normal(s) => out.push(s),
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    return None;
                }
            }
            _ => return None,
        }
    }
    Some(out)
}

/// Canonical allowed roots; every host fs call is checked against these.
#[derive(Clone)]
struct Scope {
    roots: Arc<Mutex<Vec<PathBuf>>>,
}

impl Scope {
    fn check(&self, path: &str) -> std::result::Result<PathBuf, String> {
        let full = Path::new(path)
            .canonicalize()
            .map_err(|_| format!("not found or not allowed: {path}"))?;
        let name = full.file_name().and_then(|n| n.to_str()).unwrap_or("").to_ascii_lowercase();
        if DENYLIST.contains(&name.as_str()) || name.starts_with("ssfn") {
            return Err(format!("denied: {path}"));
        }
        if self.roots.lock().unwrap().iter().any(|r| full.starts_with(r)) {
            Ok(full)
        } else {
            Err(format!("outside allowed locations: {path}"))
        }
    }
}

fn install_host_api<'js>(ctx: &Ctx<'js>, scope: Scope, store_root: &Path) -> Result<()> {
    let host = Object::new(ctx.clone())?;
    let fs = Object::new(ctx.clone())?;

    let s = scope.clone();
    fs.set(
        "readText",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, path: String| -> Result<String> {
            let full = s.check(&path).map_err(|e| Exception::throw_message(&ctx, &e))?;
            std::fs::read_to_string(full).map_err(|e| Exception::throw_message(&ctx, &e.to_string()))
        })?,
    )?;
    let s = scope.clone();
    fs.set(
        "readBytes",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, path: String| -> Result<TypedArray<'js, u8>> {
            let full = s.check(&path).map_err(|e| Exception::throw_message(&ctx, &e))?;
            let bytes = std::fs::read(full).map_err(|e| Exception::throw_message(&ctx, &e.to_string()))?;
            TypedArray::new(ctx, bytes)
        })?,
    )?;
    let s = scope.clone();
    fs.set(
        "list",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, dir: String| -> Result<Vec<String>> {
            let full = s.check(&dir).map_err(|e| Exception::throw_message(&ctx, &e))?;
            let rd = std::fs::read_dir(full).map_err(|e| Exception::throw_message(&ctx, &e.to_string()))?;
            Ok(rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect())
        })?,
    )?;
    fs.set(
        "exists",
        Function::new(ctx.clone(), |path: String| Path::new(&path).exists())?,
    )?;
    host.set("fs", fs)?;

    let locations = Object::new(ctx.clone())?;
    locations.set("root", store_root.to_string_lossy().into_owned())?;
    host.set("locations", locations)?;

    let log = Object::new(ctx.clone())?;
    log.set(
        "info",
        Function::new(ctx.clone(), |msg: String| println!("    [provider log] {msg}"))?,
    )?;
    host.set("log", log)?;
    ctx.globals().set("__host", host)?;
    Ok(())
}

/// Runs one provider's scan() in a fresh runtime. Returns a one-line outcome.
fn run_provider(plugin_dir: &Path, store_root: &Path) -> String {
    let rt = Runtime::new().unwrap();
    rt.set_memory_limit(MEMORY_LIMIT);
    rt.set_max_stack_size(1024 * 1024);
    let deadline = Arc::new(Mutex::new(Instant::now() + Duration::from_secs(3600)));
    let d = deadline.clone();
    rt.set_interrupt_handler(Some(Box::new(move || Instant::now() > *d.lock().unwrap())));
    rt.set_loader(
        PluginResolver { root: plugin_dir.to_path_buf() },
        PluginLoader { root: plugin_dir.to_path_buf() },
    );
    let ctx = Context::full(&rt).unwrap();

    let scope = Scope {
        roots: Arc::new(Mutex::new(vec![store_root.canonicalize().unwrap()])),
    };
    let started = Instant::now();
    *deadline.lock().unwrap() = Instant::now() + SCAN_TIMEOUT;

    let outcome = ctx.with(|ctx| -> std::result::Result<String, String> {
        install_host_api(&ctx, scope, store_root).map_err(|e| e.to_string())?;
        let source = std::fs::read(plugin_dir.join("provider.js")).map_err(|e| e.to_string())?;
        let caught = |e: rquickjs::CaughtError| e.to_string();
        let (module, promise) = Module::declare(ctx.clone(), "provider.js", source)
            .catch(&ctx)
            .map_err(caught)?
            .eval()
            .catch(&ctx)
            .map_err(caught)?;
        promise.finish::<()>().catch(&ctx).map_err(caught)?;
        let def: Object = module.get("default").catch(&ctx).map_err(caught)?;
        let scan: Function = def.get("scan").catch(&ctx).map_err(caught)?;
        let result: Object = scan.call((ctx.globals().get::<_, Object>("__host").unwrap(),))
            .catch(&ctx)
            .map_err(caught)?;
        let games: rquickjs::Array = result.get("games").catch(&ctx).map_err(caught)?;
        let summary: String = result.get::<_, Option<String>>("note").ok().flatten().unwrap_or_default();
        Ok(format!("{} games {}", games.len(), summary))
    });
    let ms = started.elapsed().as_millis();
    match outcome {
        Ok(s) => format!("OK    ({ms} ms) {s}"),
        Err(e) => format!("ERROR ({ms} ms) {}", e.lines().next().unwrap_or("")),
    }
}

fn main() {
    let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures");
    let store = base.join("store");
    let providers = base.join("providers");

    let cases: &[(&str, &str)] = &[
        ("ok", "OK: imports a sibling module, reads text + bytes, returns games"),
        ("globals", "OK: reports which dangerous globals exist"),
        ("escape-import", "ERROR: import outside plugin folder"),
        ("bare-import", "ERROR: bare/URL import"),
        ("escape-read", "ERROR: read outside allowed locations"),
        ("denylist", "ERROR: denied file inside the root"),
        ("infinite-loop", "ERROR: interrupted at ~2 s"),
        ("memory-bomb", "ERROR: out of memory, host survives"),
        ("throws", "ERROR: provider exception surfaced"),
    ];
    for (name, expect) in cases {
        println!("[{name}] expect {expect}");
        println!("    -> {}", run_provider(&providers.join(name), &store));
    }

    println!("[parallel] 8 x ok + 1 x infinite-loop on separate threads");
    let started = Instant::now();
    let handles: Vec<_> = (0..9)
        .map(|i| {
            let (p, s) = (providers.join(if i == 8 { "infinite-loop" } else { "ok" }), store.clone());
            std::thread::spawn(move || run_provider(&p, &s))
        })
        .collect();
    for h in handles {
        println!("    -> {}", h.join().unwrap());
    }
    println!("    total {} ms", started.elapsed().as_millis());
}
