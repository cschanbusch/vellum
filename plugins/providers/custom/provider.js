// Custom games: programs and shortcuts the user added by hand (Settings -> Library, or the game
// menu). The list lives in this provider's settings; the shell's dialog writes it through the
// backend, which checks each path. Nothing here looks at the disk beyond "is it still there".

/** The folder holding a file, whichever slash the path uses. */
function folderOf(path) {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return i > 0 ? path.slice(0, i) : "";
}

/**
 * Splits an arguments line as a command line would: spaces separate, double quotes group.
 * Backslashes stay literal, because these are mostly Windows paths.
 */
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
    const saved = Array.isArray(ctx.settings.games) ? ctx.settings.games : [];
    const games = [];
    for (const g of saved) {
      if (!g || !g.id || !g.title || !g.exe) continue;
      const game = {
        sourceId: String(g.id),
        title: String(g.title),
        launchData: { exe: g.exe, args: g.args ?? "", cwd: g.cwd ?? "" },
      };
      // The launch scope: ctx.run may start programs inside a game's own install folder.
      const dir = folderOf(g.exe);
      if (dir) game.installDir = dir;
      if (!ctx.fs.exists(g.exe)) game.labels = ["Missing"];
      games.push(game);
    }
    return { games };
  },

  launch(ctx, game) {
    const d = game.launchData ?? {};
    ctx.run(d.exe, splitArgs(d.args), d.cwd || null);
  },
};
