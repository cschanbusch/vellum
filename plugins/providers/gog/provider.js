// GOG: installed games from the registry, which both GOG Galaxy and GOG's standalone installers
// write to. GOG games are DRM-free, so by default the game's own program runs directly and Galaxy
// never opens. Turning off "Skip Galaxy launch" goes through Galaxy instead, when it was found.
//
// Seen on Galaxy 2.1 (2026): each game's folder has goggame-<id>.info with its name and play tasks.
// `rootGameId` equals the game's own id for a base game. The play tasks also list manuals and
// support links (category "document"), so only the primary one is ever run.

const GAMES = "SOFTWARE\\WOW6432Node\\GOG.com\\Games";

const join = (dir, rel) => `${dir.replace(/[\\/]+$/, "")}\\${String(rel).replace(/^[\\/]+/, "")}`;

/** The folder's info file, or null: a standalone installer's game may not have one. */
function readInfo(ctx, path, id) {
  const file = join(path, `goggame-${id}.info`);
  if (!ctx.fs.exists(file)) return null;
  try {
    return JSON.parse(ctx.fs.readText(file));
  } catch (e) {
    ctx.log.warn(`unreadable ${file}: ${e.message}`);
    return null;
  }
}

/** The task that starts the game: a file to run, not a manual or a web link. */
function primaryTask(info) {
  const tasks = Array.isArray(info?.playTasks) ? info.playTasks : [];
  return tasks.find((t) => t && t.isPrimary && t.path && t.type !== "URLTask") ?? null;
}

/** Splits an arguments line: spaces separate, double quotes group, backslashes stay. */
function splitArgs(line) {
  const out = [];
  let cur = "";
  let quoted = false;
  let any = false;
  for (const c of String(line ?? "")) {
    if (c === '"') {
      quoted = !quoted;
      any = true;
    } else if (!quoted && /\s/.test(c)) {
      if (any) out.push(cur);
      cur = "";
      any = false;
    } else {
      cur += c;
      any = true;
    }
  }
  if (any) out.push(cur);
  return out;
}

export default {
  scan(ctx) {
    const games = [];
    for (const id of ctx.registry.subkeys("HKLM", GAMES)) {
      const value = (name) => ctx.registry.get("HKLM", `${GAMES}\\${id}`, name) ?? "";
      const path = value("path");
      if (!path || !ctx.fs.stat(path)?.isDir) {
        ctx.log.warn(`game ${id}: its folder is gone`);
        continue;
      }
      ctx.fs.allow(path);
      const info = readInfo(ctx, path, id);
      const title = info?.name || value("gameName");
      if (!title) {
        ctx.log.warn(`game ${id}: no name`);
        continue;
      }
      const task = primaryTask(info);
      const root = info?.rootGameId ? String(info.rootGameId) : id;
      games.push({
        sourceId: String(id),
        title: String(title),
        kind: value("dependsOn") || root !== String(id) ? "dlc" : "game",
        installDir: path,
        launchData: {
          gameId: String(id),
          path,
          // The info file's task first; the registry's own command when there's no info file.
          exe: task ? join(path, task.path) : value("exe"),
          args: task ? (task.arguments ?? "") : value("launchParam"),
          cwd: task ? (task.workingDir ? join(path, task.workingDir) : "") : value("workingDir"),
        },
      });
    }
    return { games };
  },

  launch(ctx, game) {
    const d = game.launchData ?? {};
    if (ctx.locations.galaxy && ctx.settings.skipGalaxy === false) {
      ctx.run(join(ctx.locations.galaxy, "GalaxyClient.exe"), ["/command=runGame", `/gameId=${d.gameId}`, `/path=${d.path}`]);
      return;
    }
    if (!d.exe) throw new Error("this game has no program to start");
    ctx.run(d.exe, splitArgs(d.args), d.cwd || null);
  },

  art(ctx, game) {
    const icon = join(game.installDir ?? "", `goggame-${game.sourceId}.ico`);
    return game.installDir && ctx.fs.exists(icon) ? [{ kind: "icon", file: icon }] : [];
  },
};
