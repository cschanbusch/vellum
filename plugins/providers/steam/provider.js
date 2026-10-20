// Steam: installed games from appmanifest files in every library folder, collections from
// the account's cloud-storage namespace, launches through steam:// URIs.
// Never reads config/loginusers.vdf, config/config.vdf or ssfn* (denied in plugin.json too).

const TOOL_APPIDS = new Set(["228980"]); // Steamworks Common Redistributables
const TOOL_PREFIXES = ["Proton", "Steam Linux Runtime"];
const COLLECTIONS_FILE = "cloud-storage-namespace-1.json";

const join = (...parts) => parts.join("\\").replace(/[\\/]+/g, "\\");

/** Case-insensitive property lookup: Valve is not consistent about key casing. */
function pick(obj, name) {
  if (!obj || typeof obj !== "object") return undefined;
  if (name in obj) return obj[name];
  const lower = name.toLowerCase();
  const key = Object.keys(obj).find((k) => k.toLowerCase() === lower);
  return key === undefined ? undefined : obj[key];
}

/** Every library folder (the install folder plus any listed in libraryfolders.vdf). */
function libraries(ctx) {
  const root = ctx.locations.root;
  const doc = ctx.formats.vdf(ctx.fs.readText(join(root, "steamapps", "libraryfolders.vdf")));
  const listed = pick(doc, "libraryfolders") ?? {};
  const candidates = [root];
  for (const [key, value] of Object.entries(listed)) {
    if (!/^\d+$/.test(key)) continue;
    // Current format: "0" { "path" "..." }; old format: "1" "D:\\SteamLibrary".
    const path = typeof value === "string" ? value : pick(value, "path");
    if (path) candidates.push(path);
  }
  const seen = new Set();
  const out = [];
  for (const path of candidates) {
    if (!ctx.fs.exists(join(path, "steamapps"))) {
      ctx.log.warn(`library folder not available: ${path}`);
      continue;
    }
    const allowed = ctx.fs.allow(path);
    const key = allowed.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(allowed);
    }
  }
  return out;
}

function installedApps(ctx, library) {
  const apps = [];
  for (const file of ctx.fs.glob(join(library, "steamapps"), "appmanifest_*.acf")) {
    let state;
    try {
      state = pick(ctx.formats.vdf(ctx.fs.readText(file)), "AppState");
    } catch (e) {
      ctx.log.warn(`skipping unreadable manifest ${file}: ${e.message}`);
      continue;
    }
    const appid = pick(state, "appid");
    if (!appid) continue;
    // StateFlags bit 4 = fully installed.
    if ((Number(pick(state, "StateFlags")) & 4) === 0) continue;
    const installdir = pick(state, "installdir");
    apps.push({
      appid: String(appid),
      name: pick(state, "name") || `Steam app ${appid}`,
      installDir: installdir ? join(library, "steamapps", "common", installdir) : undefined,
      sizeBytes: Number(pick(state, "SizeOnDisk")) || undefined,
    });
  }
  return apps;
}

function isTool(app) {
  return TOOL_APPIDS.has(app.appid) || TOOL_PREFIXES.some((p) => app.name.startsWith(p));
}

/** Numeric account folders under userdata; "0" is a placeholder Steam sometimes creates. */
function accounts(ctx) {
  const dir = join(ctx.locations.root, "userdata");
  if (!ctx.fs.exists(dir)) return [];
  return ctx.fs
    .list(dir)
    .filter((e) => e.isDir && /^\d+$/.test(e.name) && e.name !== "0")
    .map((e) => e.name);
}

/** The account whose localconfig.vdf changed most recently, unless one is chosen in settings. */
function activeAccount(ctx) {
  const ids = accounts(ctx);
  const chosen = ctx.settings.account;
  if (chosen && ids.includes(String(chosen))) return String(chosen);
  if (ids.length <= 1) return ids[0] ?? null;
  let best = ids[0];
  let bestTime = -1;
  for (const id of ids) {
    const stat = ctx.fs.stat(join(ctx.locations.root, "userdata", id, "config", "localconfig.vdf"));
    if (stat && stat.mtime > bestTime) {
      best = id;
      bestTime = stat.mtime;
    }
  }
  return best;
}

function collectionsDir(ctx, account) {
  return join(ctx.locations.root, "userdata", account, "config", "cloudstorage");
}

/** Store collections → categories per appid, plus the favorite and hidden sets. */
function collections(ctx, account) {
  const result = { categories: new Map(), hidden: new Set() };
  if (!account) return result;
  const file = join(collectionsDir(ctx, account), COLLECTIONS_FILE);
  if (!ctx.fs.exists(file)) return result;
  let pairs;
  try {
    pairs = JSON.parse(ctx.fs.readText(file));
  } catch (e) {
    ctx.log.warn(`collections file is not valid JSON: ${e.message}`);
    return result;
  }
  const dynamic = [];
  for (const pair of Array.isArray(pairs) ? pairs : []) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const [key, entry] = pair;
    if (typeof key !== "string" || !key.startsWith("user-collections.")) continue;
    if (!entry || entry.is_deleted || typeof entry.value !== "string") continue;
    let c;
    try {
      c = JSON.parse(entry.value);
    } catch {
      continue;
    }
    if (c.filterSpec) {
      dynamic.push(c.name ?? c.id);
      continue;
    }
    const removed = new Set((c.removed ?? []).map(String));
    const members = (c.added ?? []).map(String).filter((id) => !removed.has(id));
    if (c.id === "hidden") {
      members.forEach((id) => result.hidden.add(id));
      continue;
    }
    const name = c.id === "favorite" ? "Steam favorites" : c.name;
    if (!name) continue;
    for (const id of members) {
      if (!result.categories.has(id)) result.categories.set(id, []);
      result.categories.get(id).push(name);
    }
  }
  if (dynamic.length) ctx.log.info(`skipped ${dynamic.length} dynamic collection(s): ${dynamic.join(", ")}`);
  return result;
}

const appid = (game) => String(game.launchData?.appid ?? game.sourceId);

export default {
  scan(ctx) {
    const showTools = ctx.settings.showTools === true;
    const respectHidden = ctx.settings.respectHidden !== false;
    const cols = collections(ctx, activeAccount(ctx));
    const games = [];
    const seen = new Set();
    for (const library of libraries(ctx)) {
      for (const app of installedApps(ctx, library)) {
        if (seen.has(app.appid)) continue;
        seen.add(app.appid);
        const tool = isTool(app);
        if (tool && !showTools) continue;
        games.push({
          sourceId: app.appid,
          title: app.name,
          kind: tool ? "tool" : "game",
          installDir: app.installDir,
          sizeBytes: app.sizeBytes,
          launchData: { appid: app.appid },
          categories: cols.categories.get(app.appid) ?? [],
          hidden: respectHidden && cols.hidden.has(app.appid),
        });
      }
    }
    return { games };
  },

  launch(ctx, game) {
    ctx.openUri(`steam://rungameid/${appid(game)}`);
  },

  install(ctx, game) {
    ctx.openUri(`steam://install/${appid(game)}`);
  },

  uninstall(ctx, game) {
    ctx.openUri(`steam://uninstall/${appid(game)}`);
  },

  openStore(ctx, game) {
    ctx.openUri(`steam://store/${appid(game)}`);
  },

  watch(ctx) {
    const root = ctx.locations.root;
    const targets = [{ path: join(root, "steamapps"), glob: "libraryfolders.vdf" }];
    for (const library of libraries(ctx)) {
      targets.push({ path: join(library, "steamapps"), glob: "appmanifest_*.acf" });
    }
    const account = activeAccount(ctx);
    if (account && ctx.fs.exists(collectionsDir(ctx, account))) {
      targets.push({ path: collectionsDir(ctx, account), glob: COLLECTIONS_FILE });
    }
    return targets;
  },
};
