// Epic Games: installed games from the launcher's manifests (one JSON .item file per install),
// launched through com.epicgames.launcher:// URIs. No login, no network.
//
// Seen on a 2026 launcher (manifest FormatVersion 0): base games leave MainGameAppName empty;
// add-ons set it to their base game's AppName. So an entry is DLC when MainGameAppName is set
// and differs from AppName (the spec's "MainGameAppName equals AppName" assumed it is always set).
//
// The developer comes from the launcher's catalog cache (Data/Catalog/catcache.bin, base64 JSON).
// The cache has no genres or release dates.

function isGame(m) {
  const cats = Array.isArray(m.AppCategories) ? m.AppCategories : null;
  return !cats || cats.includes("games");
}

function kindOf(m) {
  if (m.MainGameAppName && m.MainGameAppName !== m.AppName) return "dlc";
  if (m.bIsExecutable === false) return "other";
  return isGame(m) ? "game" : "other";
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Decodes base64 to a UTF-8 string (the sandbox has no atob or TextDecoder). */
function fromBase64(text) {
  const map = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) map[B64.charCodeAt(i)] = i;
  const bytes = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < text.length; i++) {
    const v = map[text.charCodeAt(i)] ?? -1;
    if (v < 0) continue; // padding, newlines
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  // UTF-8 decode.
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i++];
    let cp = b;
    if (b >= 0xf0) cp = ((b & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
    else if (b >= 0xe0) cp = ((b & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
    else if (b >= 0xc0) cp = ((b & 31) << 6) | (bytes[i++] & 63);
    out += String.fromCodePoint(cp);
  }
  return out;
}

/** Developer names by "namespace:catalogItemId", from the catalog cache when it exists. */
function developers(ctx) {
  const dir = ctx.locations.catalog;
  const file = dir ? `${dir}\\catcache.bin` : null;
  const out = new Map();
  if (!file || !ctx.fs.exists(file)) return out;
  try {
    for (const item of JSON.parse(fromBase64(ctx.fs.readText(file)))) {
      const dev = item.developer || item.customAttributes?.developerName?.value;
      if (item.namespace && item.id && dev) out.set(`${item.namespace}:${item.id}`, String(dev));
    }
  } catch (e) {
    ctx.log.warn(`catalog cache unreadable: ${e.message}`);
  }
  return out;
}

export default {
  scan(ctx) {
    const devs = developers(ctx);
    const dir = ctx.locations.manifests;
    const games = [];
    const seen = new Set();
    for (const file of ctx.fs.glob(dir, "*.item")) {
      let m;
      try {
        m = JSON.parse(ctx.fs.readText(file));
      } catch (e) {
        ctx.log.warn(`skipping unreadable manifest ${file}: ${e.message}`);
        continue;
      }
      if (!m || typeof m !== "object" || !m.AppName || !m.DisplayName) continue;
      if (m.bIsIncompleteInstall) continue; // still downloading or broken
      if (seen.has(m.AppName)) continue;
      seen.add(m.AppName);
      const game = {
        sourceId: String(m.AppName),
        title: String(m.DisplayName),
        kind: kindOf(m),
        launchData: {
          namespace: m.CatalogNamespace ?? "",
          catalogItemId: m.CatalogItemId ?? "",
          appName: m.AppName,
        },
      };
      if (typeof m.InstallLocation === "string" && m.InstallLocation) game.installDir = m.InstallLocation;
      if (typeof m.InstallSize === "number" && m.InstallSize > 0) game.sizeBytes = m.InstallSize;
      const dev = devs.get(`${m.CatalogNamespace}:${m.CatalogItemId}`);
      if (dev) game.metadata = { developer: dev };
      games.push(game);
    }
    return { games };
  },

  launch(ctx, game) {
    const d = game.launchData ?? {};
    const id = [d.namespace, d.catalogItemId, d.appName ?? game.sourceId].map(encodeURIComponent).join("%3A");
    ctx.openUri(`com.epicgames.launcher://apps/${id}?action=launch&silent=true`);
  },

  watch(ctx) {
    // The location exactly as resolved, so the watcher matches the paths Windows reports.
    return [{ path: ctx.locations.manifests, glob: "*.item" }];
  },
};
