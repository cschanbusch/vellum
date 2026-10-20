import { parseAcf } from "./lib/acf.js";
export default {
  scan(ctx) {
    const dir = ctx.locations.root + "/steamapps";
    const games = ctx.fs.list(dir)
      .filter((n) => n.startsWith("appmanifest_"))
      .map((n) => parseAcf(ctx.fs.readText(dir + "/" + n)));
    const bytes = ctx.fs.readBytes(dir + "/appmanifest_620.acf");
    return { games, note: `[${games.map((g) => g.title).join(", ")}] bytes=${bytes.length} Uint8Array=${bytes instanceof Uint8Array}` };
  },
};
