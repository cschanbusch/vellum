// The mock library for the skin dev harness: runs the real mock provider (plain JS) with a
// tiny stand-in for the host's `ctx`, then builds entries the way the backend does
// (src-tauri/src/library/entry.rs). No Rust needed.

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const ART_KINDS = ["cover", "hero", "logo", "header", "icon"];

/** Mirrors entry.rs sort_title: a leading "The "/"A "/"An " moves to the end, lower-cased. */
export function sortTitle(title) {
  const t = title.trim();
  for (const article of ["The ", "A ", "An "]) {
    if (t.length > article.length && t.slice(0, article.length).toLowerCase() === article.toLowerCase()) {
      return `${t.slice(article.length)}, ${article.trim()}`.toLowerCase();
    }
  }
  return t.toLowerCase();
}

function fnv(s) {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(s)) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return h >>> 0;
}

const encodeId = (id) => id.replace(/[^A-Za-z0-9\-_.~:]/g, (c) => encodeURIComponent(c));

/** Loads the mock provider and returns `{ entries, art }`, where art maps id → kind → file. */
export async function mockLibrary(mockDir, count) {
  const mod = await import(`${pathToFileURL(join(mockDir, "provider.js")).href}?t=${Date.now()}`);
  const provider = mod.default;
  const log = { info() {}, warn: console.warn, error: console.error };
  const ctx = {
    settings: { count },
    pluginDir: mockDir,
    locations: {},
    log,
    fs: { exists: (p) => existsSync(p) },
  };
  const { games } = provider.scan(ctx);
  const firstSeen = new Date(Date.now() - 400 * 86_400_000);
  const art = new Map();
  const entries = games.map((g, i) => {
    const id = `mock:${g.sourceId}`;
    const files = Object.fromEntries((provider.art?.(ctx, g) ?? []).map((c) => [c.kind, c.file]));
    art.set(id, { title: g.title, files });
    const version = (kind) => {
      const f = files[kind];
      if (!f) return `p${fnv(g.title).toString(16).padStart(8, "0")}`;
      const st = statSync(f);
      return `${Math.round(st.mtimeMs).toString(36)}${st.size.toString(36)}`;
    };
    return {
      id,
      title: g.title,
      sortTitle: sortTitle(g.title),
      kind: g.kind ?? "game",
      sources: [{ provider: "mock", providerName: "Mock library", gameId: id, capabilities: ["launch"] }],
      preferredSource: "mock",
      categories: (g.categories ?? []).map((name) => ({ provider: "mock", name })),
      labels: g.labels ?? [],
      tags: [],
      favorite: false,
      hidden: !!g.hidden,
      lastLaunched: null,
      addedAt: new Date(firstSeen.getTime() + i * 3_600_000 * 7).toISOString(),
      ...(g.sizeBytes ? { sizeBytes: g.sizeBytes } : {}),
      ...(g.playtimeMinutes ? { playtimeMinutes: g.playtimeMinutes } : {}),
      ...(g.lastPlayed ? { lastPlayed: g.lastPlayed } : {}),
      metadata: g.metadata ?? {},
      art: Object.fromEntries(ART_KINDS.map((k) => [k, `/__vellum/art/${encodeId(id)}/${k}?v=${version(k)}`])),
      artStatus: Object.fromEntries(ART_KINDS.map((k) => [k, files[k] ? "local" : "placeholder"])),
    };
  });
  entries.sort((a, b) => (a.sortTitle < b.sortTitle ? -1 : a.sortTitle > b.sortTitle ? 1 : a.id < b.id ? -1 : 1));
  return { entries, art };
}
