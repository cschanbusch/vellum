// Grand Tour's wear and tear. Every game starts in showroom condition. Each start through Vellum
// wears it by a varying amount, and so does every hour on the clock: when the store reports more
// playtime than was last seen (Steam counts all play, wherever the game was started), the extra
// hours cost condition too. Below RISKY the engine may fail to turn over, more often the more
// worn it is (never always, so cranking again can still catch). A service restores it.
//
// Kept in the skin's own storage, so it is Grand Tour's game, not library data. Per game:
//   c     condition, 0..1 (absent: showroom fresh)
//   p     the store's playtime in minutes when last seen (the odometer)
//   last  the most recent wear: { kind: "start" | "play", w, minutes?, at }
//   serviced  ISO time of the last service
import vellum from "/__vellum/sdk.js";

/** Condition lost per start: anywhere in this range, so no two starts are quite alike. */
export const START_WEAR = [0.05, 0.14];
/** Condition lost per hour played, on average; each session varies by up to 40% either way. */
export const HOURLY_WEAR = 0.03;
/** The most one stretch of play can cost, so a marathon leaves it worn rather than wrecked. */
export const MAX_PLAY_WEAR = 0.6;
/** Below this, a start can fail. */
export const RISKY = 0.4;
/** The chance of failing at 0%. */
export const MAX_FAIL = 0.75;

const KEY = "condition";
let data = vellum.skin.storage.get(KEY, {}) ?? {};

/** Wear and tear can be switched off in the skin's options. */
export const enabled = () => vellum.skin.options.wear !== false;

/** 0..1; 1 for games never started. */
export function condition(id) {
  if (!enabled()) return 1;
  const c = data[id]?.c;
  return typeof c === "number" ? Math.max(0, Math.min(1, c)) : 1;
}

export function serviced(id) {
  return data[id]?.serviced ?? null;
}

export function lastWear(id) {
  return data[id]?.last ?? null;
}

function saveAll(patches) {
  const ids = Object.keys(patches);
  if (!ids.length) return;
  data = { ...data };
  for (const id of ids) data[id] = { ...data[id], ...patches[id] };
  vellum.skin.storage.set(KEY, data);
  for (const id of ids) dispatchEvent(new CustomEvent("rl-condition", { detail: { id } }));
}

const save = (id, patch) => saveAll({ [id]: patch });

/** The wear of one start: somewhere in START_WEAR. */
export function startWear(random = Math.random) {
  const [lo, hi] = START_WEAR;
  return lo + (hi - lo) * random();
}

/** A start wears the game; returns what it cost. */
export function wear(id, random = Math.random) {
  if (!enabled()) return 0;
  const w = startWear(random);
  save(id, { c: Math.max(0, condition(id) - w), last: { kind: "start", w, at: new Date().toISOString() } });
  return w;
}

/** The wear of `minutes` of play: HOURLY_WEAR an hour, varied, capped at MAX_PLAY_WEAR. */
export function playWear(minutes, random = Math.random) {
  return Math.min(MAX_PLAY_WEAR, (minutes / 60) * HOURLY_WEAR * (0.6 + 0.8 * random()));
}

/**
 * Reads the odometer of every entry that has store playtime and charges the hours played since
 * it was last read. The first reading only records it, so play from before Grand Tour costs
 * nothing. A counter that went down (a reset, another account) is simply re-read.
 */
export function notePlaytime(entries, random = Math.random) {
  const patches = {};
  const at = new Date().toISOString();
  for (const e of entries) {
    const m = e.playtimeMinutes;
    if (typeof m !== "number") continue;
    const seen = data[e.id]?.p;
    if (typeof seen !== "number" || m < seen) {
      patches[e.id] = { p: m };
      continue;
    }
    if (m === seen) continue;
    if (!enabled()) {
      patches[e.id] = { p: m };
      continue;
    }
    const w = playWear(m - seen, random);
    patches[e.id] = { p: m, c: Math.max(0, condition(e.id) - w), last: { kind: "play", w, minutes: m - seen, at } };
  }
  saveAll(patches);
}

export function restore(id) {
  save(id, { c: 1, serviced: new Date().toISOString() });
}

/** For the tests and the curious: set a condition directly. */
export function setCondition(id, c) {
  save(id, { c });
}

export function failChance(c) {
  if (!enabled() || c >= RISKY) return 0;
  return MAX_FAIL * ((RISKY - c) / RISKY);
}

/** A class grade, S best. */
export function grade(c) {
  if (c >= 0.9) return "S";
  if (c >= 0.7) return "A";
  if (c >= RISKY) return "B";
  if (c >= 0.2) return "C";
  return "D";
}

export function describe(c) {
  if (c >= 0.9) return "Showroom fresh";
  if (c >= 0.7) return "Well kept";
  if (c >= RISKY) return "Road worn";
  if (c >= 0.15) return "Needs service";
  return "Barely running";
}
