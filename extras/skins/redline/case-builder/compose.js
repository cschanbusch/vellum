// The case builder's front end: case profiles (cases.json), which form each game gets, and wrap
// requests. Wraps are composed in at most two workers, nearest-to-focus first, and cached in
// IndexedDB (cache.js), so a second visit shows its cases at once.
//
// This module doesn't import the SDK: callers pass the entry, the providers list and the skin's
// option values, so the dev case gallery can use it standalone.
import * as cache from "./cache.js";

const here = (p) => new URL(p, import.meta.url).href;

export const FONTS = [
  { family: "Michroma", weight: 400, url: here("../fonts/michroma-latin-400-normal.woff2") },
  { family: "Saira Semi Condensed", weight: 400, url: here("../fonts/saira-semi-condensed-latin-400-normal.woff2") },
  { family: "Saira Semi Condensed", weight: 600, url: here("../fonts/saira-semi-condensed-latin-600-normal.woff2") },
  { family: "Saira Semi Condensed", weight: 700, url: here("../fonts/saira-semi-condensed-latin-700-normal.woff2") },
];
const DISPLAY_FONT = "Michroma";
const BODY_FONT = "Saira Semi Condensed";

/** Bump when the composer's drawing changes, so cached wraps are composed again. */
const BUILDER = 5;

/** Front panel width in pixels for each tier. */
export const TIERS = { small: 320, medium: 640, full: 1200 };

/** Skin option ids that pick a store's case form. */
export const FORM_OPTIONS = { steam: "caseSteam", epic: "caseEpic", gog: "caseGog", xbox: "caseXbox", pcsx2: "casePcsx2", default: "caseOther" };

let casesP = null;
/** cases.json plus the skin's version (part of every cache key). */
export function loadCases() {
  casesP ??= Promise.all([
    fetch(here("../cases.json")).then((r) => r.json()),
    fetch(here("../plugin.json"))
      .then((r) => r.json())
      .then((m) => m.version)
      .catch(() => "0"),
  ]).then(([cases, version]) => ({ ...cases, version }));
  return casesP;
}

/** The case for an entry: its preferred store's style, and the form the options choose for it. */
export function caseFor(entry, cases, options = {}) {
  const provider = entry.preferredSource ?? entry.sources?.[0]?.provider ?? "default";
  const storeKey = cases.stores[provider] ? provider : "default";
  const style = cases.stores[storeKey];
  const chosen = options[FORM_OPTIONS[storeKey] ?? FORM_OPTIONS.default];
  const profileName = cases.profiles[chosen] ? chosen : style.profile;
  return { profileName, profile: cases.profiles[profileName], style, store: storeKey };
}

const ART_WIDTHS = [160, 320, 640, 1280, 1920];
const snap = (px) => ART_WIDTHS.find((w) => w >= px) ?? "full";
function artUrl(entry, kind, px) {
  if (!entry.art?.[kind] || entry.artStatus?.[kind] === "placeholder") return null;
  const u = entry.art[kind];
  return `${u}${u.includes("?") ? "&" : "?"}w=${snap(px)}`;
}

function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(36);
}

/** Everything a wrap's pixels depend on, and the cache key made from it. */
function makeJob(entry, tier, { cases, options = {}, providers = [] }) {
  const c = caseFor(entry, cases, options);
  const p = c.profile;
  const frontPx = TIERS[tier];
  const k = frontPx / p.panel.w;
  const icons = new Map(providers.map((x) => [x.id, x.icon]));
  const seen = new Set();
  const ordered = [...(entry.sources ?? [])].sort((a, b) => (b.provider === entry.preferredSource) - (a.provider === entry.preferredSource));
  const badges = [];
  for (const s of ordered) {
    if (seen.has(s.provider)) continue;
    seen.add(s.provider);
    badges.push({ name: s.providerName ?? s.provider, url: icons.get(s.provider) ?? null });
  }
  const job = {
    title: entry.title,
    metadata: entry.metadata ?? {},
    profile: p,
    style: c.style,
    frontPx,
    art: {
      cover: artUrl(entry, "cover", frontPx),
      hero: artUrl(entry, "hero", frontPx),
      logo: artUrl(entry, "logo", Math.min(640, frontPx)),
      header: artUrl(entry, "header", frontPx), // the back cover's banner
      icon: artUrl(entry, "icon", p.spine * k * 0.8),
    },
    badges,
    richBacks: !!options.richBacks,
    fonts: FONTS,
    displayFont: DISPLAY_FONT,
    bodyFont: BODY_FONT,
    // The Garage shows medium or full (by screen size); both get the disc and the emboss.
    disc: tier !== "small" && !!p.disc,
    emboss: tier !== "small" && !!p.emboss,
  };
  const fontKey = FONTS.map((f) => `${f.family}${f.weight}`).join(",");
  const key = [entry.id, c.profileName, tier, `${cases.version}.${BUILDER}`, fnv(JSON.stringify(job) + fontKey)].join("|");
  return { key, job, case: c };
}

// ---- workers ----------------------------------------------------------------------------------

const POOL = 2;
const workers = [];
const idle = [];
const queue = []; // { key, job, priority, resolve, reject }
const inflight = new Map(); // key -> promise
let seq = 0;
const pending = new Map(); // message id -> { resolve, reject }

function worker() {
  const w = new Worker(here("./compose.worker.js"), { type: "module" });
  w.onmessage = (ev) => {
    const p = pending.get(ev.data.id);
    pending.delete(ev.data.id);
    if (!p) return;
    if (ev.data.ok) p.resolve(ev.data);
    else p.reject(new Error(ev.data.error));
  };
  return w;
}

function call(w, msg, transfer) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, ...msg }, transfer ?? []);
  });
}

function pump() {
  while (queue.length) {
    let w = idle.pop();
    if (!w && workers.length < POOL) workers.push((w = worker()));
    if (!w) return;
    queue.sort((a, b) => a.priority - b.priority);
    const item = queue.shift();
    call(w, { type: "wrap", job: item.job })
      .then((out) => {
        const rec = { key: item.key, wrap: out.wrap, disc: out.disc ?? null, emboss: out.emboss ?? null, spine: out.spine, w: out.w, h: out.h };
        void cache.put(rec);
        item.resolve(rec);
      }, item.reject)
      .finally(() => {
        idle.push(w);
        pump();
      });
  }
}

/**
 * The wrap for `entry` at `tier` ("small", "medium", "full"): resolves to
 * `{ key, wrap: Blob, disc?: Blob, emboss?: Blob, spine: "#rrggbb", w, h, case }`.
 * `priority`: lower goes first (0 = the focused case).
 */
export async function requestWrap(entry, tier, ctx, priority = 0) {
  const { key, job, case: c } = makeJob(entry, tier, ctx);
  if (inflight.has(key)) {
    const q = queue.find((x) => x.key === key);
    if (q) q.priority = Math.min(q.priority, priority);
    return { ...(await inflight.get(key)), case: c };
  }
  const p = (async () => {
    const hit = await cache.get(key);
    if (hit) return hit;
    return new Promise((resolve, reject) => {
      queue.push({ key, job, priority, resolve, reject });
      pump();
    });
  })();
  inflight.set(key, p);
  try {
    return { ...(await p), case: c };
  } finally {
    inflight.delete(key);
  }
}

/** Drops queued (not yet started) requests whose entry isn't in `keepIds`. Their promises reject. */
export function dropQueued(keepIds) {
  const keep = new Set(keepIds);
  for (let i = queue.length - 1; i >= 0; i--) {
    if (!keep.has(queue[i].key.split("|")[0])) {
      const [item] = queue.splice(i, 1);
      item.reject(new DOMException("dropped", "AbortError"));
    }
  }
}

let mapsP = null;
/** The shared surface maps (normal and roughness ImageBitmaps), generated once per skin start. */
export function surfaceMaps() {
  mapsP ??= (async () => {
    const w = worker(); // a worker of its own, so composing isn't held up
    try {
      return (await call(w, { type: "maps" })).maps;
    } finally {
      w.terminate();
    }
  })();
  return mapsP;
}
