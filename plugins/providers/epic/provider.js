// Epic Games: installed games from the launcher's manifests (one JSON .item file per install),
// launched through com.epicgames.launcher:// URIs. No login, no network.
//
// Seen on a 2026 launcher (manifest FormatVersion 0): base games leave MainGameAppName empty;
// add-ons set it to their base game's AppName. So an entry is DLC when MainGameAppName is set
// and differs from AppName (the spec's "MainGameAppName equals AppName" assumed it is always set).

function isGame(m) {
  const cats = Array.isArray(m.AppCategories) ? m.AppCategories : null;
  return !cats || cats.includes("games");
}

function kindOf(m) {
  if (m.MainGameAppName && m.MainGameAppName !== m.AppName) return "dlc";
  if (m.bIsExecutable === false) return "other";
  return isGame(m) ? "game" : "other";
}

export default {
  scan(ctx) {
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
