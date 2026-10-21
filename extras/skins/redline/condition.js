// Redline's wear and tear. Every game starts in showroom condition; each start through Vellum
// wears it a little. Below RISKY the engine may fail to turn over, more often the more worn it
// is (never always, so cranking again can still catch). A service restores it.
//
// Kept in the skin's own storage, so it is Redline's game, not library data.
import vellum from "/__vellum/sdk.js";

/** Condition lost per start. */
export const WEAR = 0.12;
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

function save(id, patch) {
  data = { ...data, [id]: { ...data[id], ...patch } };
  vellum.skin.storage.set(KEY, data);
  dispatchEvent(new CustomEvent("rl-condition", { detail: { id } }));
}

export function wear(id) {
  if (enabled()) save(id, { c: Math.max(0, condition(id) - WEAR) });
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
