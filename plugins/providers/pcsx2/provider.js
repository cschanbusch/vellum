// PCSX2: every game in PCSX2's game list, launched in PCSX2 with its command line.
//
// The game list is the files PCSX2 scans in the folders set in its settings (inis/PCSX2.ini,
// [GameList]: Paths without subfolders, RecursivePaths with them; ExcludedPaths left out). Titles
// and serials come from PCSX2's own cache of that list, so they match what PCSX2 shows. A file
// PCSX2 hasn't scanned yet is still listed: its serial comes from the filename when there is one,
// and its title from the filename.
//
// Seen on PCSX2 2.6.3 (2026): cache/gamelist.cache is "GLCE", a little-endian u32 version (34),
// then one record per file: path, serial, title, sort title and English title (each a u32 byte
// length and UTF-8), the type (u8: 0 PS2 disc, 1 PS1 disc, 2 ELF), the region (u8), the size and
// modified time (u64 each), the CRC (u32) and the compatibility rating (u8). It's undocumented,
// so a cache that doesn't parse is ignored and every game falls back to its filename.
// inis/playtime.dat has one line per serial: the serial, seconds played and the last time
// played (Unix seconds).
//
// Read-only: nothing here writes to PCSX2's folders.

/** The files PCSX2's game list scans (VMManager's disc and ELF names). */
const EXTENSIONS = new Set(["iso", "bin", "img", "mdf", "nrg", "chd", "cso", "zso", "gz", "elf"]);
const TYPE_LABELS = { 1: "PS1", 2: "ELF" };
const COVERS = "https://raw.githubusercontent.com/xlenore/ps2-covers/main/covers";

const join = (dir, rel) => `${String(dir).replace(/[\\/]+$/, "")}\\${String(rel).replace(/^[\\/]+/, "")}`;
const key = (p) => String(p).replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
const isAbsolute = (p) => /^[a-z]:[\\/]/i.test(p) || /^\\\\/.test(p);
const extOf = (name) => {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
};
const baseName = (p) => String(p).split(/[\\/]/).pop();
const dirName = (p) => String(p).replace(/[\\/][^\\/]*$/, "");

/** PCSX2's settings file: section -> key -> every value (keys such as Paths repeat). */
function readIni(text) {
  const out = {};
  let section = "";
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === ";" || line[0] === "#") continue;
    const head = /^\[(.+)\]$/.exec(line);
    if (head) {
      section = head[1];
      out[section] ??= {};
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    ((out[section] ??= {})[k] ??= []).push(line.slice(eq + 1).trim());
  }
  return out;
}

const iniValue = (ini, section, k) => ini?.[section]?.[k]?.[0] ?? null;

function utf8(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; ) {
    let c = bytes[i++];
    if (c >= 0xf0) c = ((c & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
    else if (c >= 0xe0) c = ((c & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
    else if (c >= 0xc0) c = ((c & 31) << 6) | (bytes[i++] & 63);
    s += String.fromCodePoint(c);
  }
  return s;
}

/** PCSX2's game list cache, by lower-cased path; null when it isn't there or doesn't parse. */
export function parseCache(bytes) {
  if (!bytes || bytes.length < 8) return null;
  if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== "GLCE") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4, true);
  let at = 8;
  const need = (n) => {
    if (at + n > bytes.length) throw new Error("truncated");
  };
  const u8 = () => (need(1), bytes[at++]);
  const u32 = () => {
    need(4);
    const v = view.getUint32(at, true);
    at += 4;
    return v;
  };
  const u64 = () => {
    const lo = u32();
    return u32() * 2 ** 32 + lo;
  };
  const str = () => {
    const n = u32();
    if (n > 32768) throw new Error("string too long");
    need(n);
    const s = utf8(bytes.subarray(at, at + n));
    at += n;
    return s;
  };
  const byPath = new Map();
  try {
    while (at < bytes.length) {
      const path = str();
      const serial = str();
      const title = str();
      str(); // sort title
      const titleEn = str();
      const type = u8();
      u8(); // region
      u64(); // size
      u64(); // modified
      u32(); // CRC
      u8(); // compatibility
      if (!path) throw new Error("empty path");
      byPath.set(key(path), { path, serial, title, titleEn, type });
    }
  } catch (e) {
    return { version, entries: null, error: e.message };
  }
  return { version, entries: byPath };
}

/** inis/playtime.dat: serial -> { minutes, last }. */
function readPlaytime(text) {
  const out = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const [serial, seconds, last] = line.trim().split(/\s+/);
    if (!serial || !/^\d+$/.test(seconds ?? "")) continue;
    out.set(serial.toUpperCase(), { minutes: Math.floor(Number(seconds) / 60), last: /^\d+$/.test(last ?? "") ? Number(last) : 0 });
  }
  return out;
}

/** A serial in a filename, such as SLUS_200.62 or SCES-50330, as PCSX2 writes it (SLUS-20062). */
export function serialFromName(name) {
  const m = /(?:^|[^A-Z])([A-Z]{4})[-_ ]?(\d{3})\.?(\d{2})(?!\d)/i.exec(name);
  return m ? `${m[1].toUpperCase()}-${m[2]}${m[3]}` : null;
}

/** "Ace Combat 04 - Shattered Skies (USA) [!].iso" -> "Ace Combat 04 - Shattered Skies". */
export function titleFromName(name) {
  const stem = name.replace(/\.[^.]+$/, "");
  const clean = stem.replace(/\s*[([][^)\]]*[)\]]/g, "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
  return clean || stem;
}

/** A short stable id from a path, for a file without a serial. */
function pathId(path) {
  let h = 0x811c9dc5;
  for (const c of key(path)) {
    h ^= c.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `file-${h.toString(16).padStart(8, "0")}`;
}

/** Where PCSX2 keeps its settings, covers and caches: its own folder when it runs portable. */
function dataDir(ctx) {
  const install = ctx.locations.install;
  if (install && (ctx.fs.exists(join(install, "portable.txt")) || ctx.fs.exists(join(install, "portable.ini")))) return install;
  return ctx.locations.data ?? null;
}

/** A folder from PCSX2's settings, which may be relative to its data folder. */
const resolve = (data, p) => (isAbsolute(p) ? p : join(data, p));

let settingsMemo = null;
function pcsx2Settings(ctx) {
  if (settingsMemo) return settingsMemo;
  const data = dataDir(ctx);
  let ini = null;
  if (data && ctx.fs.exists(join(data, "inis\\PCSX2.ini"))) {
    try {
      ini = readIni(ctx.fs.readText(join(data, "inis\\PCSX2.ini")));
    } catch (e) {
      ctx.log.warn(`PCSX2.ini unreadable: ${e.message}`);
    }
  }
  settingsMemo = { data, ini };
  return settingsMemo;
}

/** Splits an arguments line: spaces separate, double quotes group, backslashes stay. */
export function splitArgs(line) {
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

/** Every scannable file in a game folder, with its size. */
function filesIn(ctx, dir, recursive) {
  const files = [];
  const walk = (d, deep) => {
    let items;
    try {
      items = ctx.fs.list(d);
    } catch (e) {
      ctx.log.warn(`can't read ${d}: ${e.message}`);
      return;
    }
    for (const it of items) {
      const full = join(d, it.name);
      if (it.isDir) {
        if (deep) walk(full, true);
      } else if (EXTENSIONS.has(extOf(it.name))) files.push({ path: full, size: it.size });
    }
  };
  walk(dir, recursive);
  return files.sort((x, y) => key(x.path).localeCompare(key(y.path)));
}

export default {
  scan(ctx) {
    settingsMemo = null;
    const { data, ini } = pcsx2Settings(ctx);
    if (!ctx.locations.install) {
      ctx.log.info("PCSX2 wasn't found; nothing to list");
      return { games: [] };
    }
    if (!ini) {
      ctx.log.warn("PCSX2's settings (inis/PCSX2.ini) weren't found, so its game folders are unknown");
      return { games: [] };
    }

    // The cache: PCSX2's titles and serials.
    const cachePath = join(resolve(data, iniValue(ini, "Folders", "Cache") ?? "cache"), "gamelist.cache");
    let cached = new Map();
    if (ctx.fs.exists(cachePath)) {
      try {
        const parsed = parseCache(ctx.fs.readBytes(cachePath));
        if (parsed?.entries) cached = parsed.entries;
        else if (parsed) ctx.log.warn(`game list cache version ${parsed.version} didn't parse (${parsed.error}); titles come from filenames`);
      } catch (e) {
        ctx.log.warn(`game list cache unreadable: ${e.message}`);
      }
    }
    const playtime = (() => {
      const p = join(data, "inis\\playtime.dat");
      try {
        return ctx.fs.exists(p) ? readPlaytime(ctx.fs.readText(p)) : new Map();
      } catch {
        return new Map();
      }
    })();
    const english = /^true$/i.test(iniValue(ini, "UI", "PreferEnglishGameList") ?? "");

    // The folders, as PCSX2's game list scans them.
    const list = ini.GameList ?? {};
    const folders = [...(list.Paths ?? []).map((p) => [p, false]), ...(list.RecursivePaths ?? []).map((p) => [p, true])];
    const excluded = new Set((list.ExcludedPaths ?? []).map((p) => key(resolve(data, p))));
    const files = [];
    for (const [raw, recursive] of folders) {
      const dir = resolve(data, raw);
      if (!ctx.fs.stat(dir)?.isDir) {
        ctx.log.warn(`game folder ${dir} is missing`);
        continue;
      }
      const allowed = ctx.fs.allow(dir);
      files.push(...filesIn(ctx, allowed, recursive));
    }

    const seen = new Set();
    const ids = new Set();
    const games = [];
    // In PCSX2's folder order, then by path: the first copy of a disc keeps the serial as its id.
    for (const f of files) {
      const k = key(f.path);
      if (seen.has(k) || excluded.has(k)) continue;
      seen.add(k);
      const c = cached.get(k);
      if (c && c.type > 2) continue; // PCSX2 found nothing it can boot in this file
      const name = baseName(f.path);
      const serial = (c?.serial || serialFromName(name) || "").toUpperCase() || null;
      const title = (english && c?.titleEn) || c?.title || titleFromName(name);
      // A serial is the natural id; a second copy of the same disc gets one from its path.
      const sourceId = serial && !ids.has(serial) ? serial : pathId(f.path);
      ids.add(sourceId);
      const played = serial ? playtime.get(serial) : null;
      const type = c?.type ?? (extOf(name) === "elf" ? 2 : 0);
      const game = {
        sourceId,
        title,
        kind: "game",
        installDir: dirName(f.path),
        sizeBytes: f.size,
        launchData: { path: f.path, serial },
      };
      if (TYPE_LABELS[type]) game.labels = [TYPE_LABELS[type]];
      if (played?.minutes) game.playtimeMinutes = played.minutes;
      if (played?.last) game.lastPlayed = new Date(played.last * 1000).toISOString();
      games.push(game);
    }
    ctx.log.info(`${games.length} game(s) in ${folders.length} folder(s); ${cached.size} in PCSX2's cache`);
    return { games };
  },

  launch(ctx, game) {
    const install = ctx.locations.install;
    if (!install) throw new Error("Vellum couldn't find PCSX2. Set its folder in Settings → Plugins.");
    const path = game.launchData?.path;
    if (!path || !ctx.fs.exists(path)) throw new Error("This game's file isn't there any more. Refresh the library with Ctrl+R.");
    const per = ctx.gameSettings ?? {};
    const on = (id) => (per[id] === "on" ? true : per[id] === "off" ? false : ctx.settings[id] !== false);
    const args = [on("fullscreen") ? "-fullscreen" : "-nofullscreen"];
    if (on("noGui")) args.push("-nogui");
    args.push(on("fastBoot") ? "-fastboot" : "-slowboot");
    // "--" ends the options, so a file name starting with a dash or holding spaces is still a file.
    args.push(...splitArgs(ctx.settings.extraArgs), ...splitArgs(per.args), "--", path);
    // PCSX2 opens where its window was last time; Vellum moves it to the monitor Vellum is on.
    ctx.run(join(install, "pcsx2-qt.exe"), args, install, { sameMonitor: true });
  },

  art(ctx, game) {
    const out = [];
    const { data, ini } = pcsx2Settings(ctx);
    const serial = game.launchData?.serial;
    // PCSX2's own covers first: named by serial, or by title (its cover downloader's options).
    if (data) {
      const dir = resolve(data, iniValue(ini, "Folders", "Covers") ?? "covers");
      const title = game.title.replace(/[\\/:*?"<>|]/g, "");
      search: for (const name of [serial, title].filter(Boolean)) {
        for (const ext of ["jpg", "png", "webp"]) {
          const f = join(dir, `${name}.${ext}`);
          if (ctx.fs.exists(f)) {
            out.push({ kind: "cover", file: f });
            break search;
          }
        }
      }
    }
    const style = ctx.settings.onlineCovers;
    if (serial && style !== "off") {
      out.push({ kind: "cover", url: style === "3d" ? `${COVERS}/3d/${serial}.png` : `${COVERS}/default/${serial}.jpg` });
    }
    return out;
  },
};
