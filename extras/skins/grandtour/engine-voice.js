// Grand Tour's engine voices: what each game's car sounds like when it starts (sound.js).
//
// A game's genre picks an archetype, the way the Garage reads its body type: a pickup's diesel
// sounds nothing like a sports coupe. Then the game's id seeds small variations in every
// parameter, and sometimes a quirk (a loud exhaust, a lumpy cam), so no two cars are quite
// alike. Everything is derived from the id, so a game always sounds the same and nothing needs
// storing. Condition is applied when the sound is rendered, not here.
//
// Firing patterns cover one engine cycle (two revolutions, one firing per cylinder): `order` is
// the strength of each firing and `gap` the time until the next, as a share of an even gap.

/** Genres that describe how a game was made or sold rather than what it is (as in the Garage). */
const BROAD = new Set(["Indie", "Casual", "Massively Multiplayer"]);

const ARCHETYPES = {
  // Cross-plane V8: each bank fires unevenly, hence the lumpy burble.
  muscle: {
    label: "V8",
    cyl: 8,
    order: [1, 0.5, 0.86, 0.42, 0.95, 0.55, 0.8, 0.38],
    gap: [0.78, 1.24, 0.86, 1.18, 0.8, 1.2, 0.9, 1.04],
    idle: 660,
    flare: 1900,
    size: 1,
    grit: 1,
    clatter: 1,
    clatterHz: 1700,
    knock: 0.5,
    bright: 1,
    crank: { rate: 1, grain: 1, chuff: 1 },
  },
  // Flat-plane V8: even firing, a hard rasp, revs freely.
  coupe: {
    label: "flat-plane V8",
    cyl: 8,
    order: [1, 0.86, 0.95, 0.82, 1, 0.88, 0.94, 0.84],
    gap: [1, 1, 1, 1, 1, 1, 1, 1],
    idle: 920,
    flare: 3400,
    size: 1.25,
    grit: 1.35,
    clatter: 0.7,
    clatterHz: 2100,
    knock: 0.3,
    bright: 1.5,
    crank: { rate: 1.15, grain: 1.2, chuff: 0.8 },
  },
  // Turbo-diesel straight-six: low revs, combustion knock on every firing, a slow heavy crank.
  pickup: {
    label: "diesel straight-six",
    cyl: 6,
    order: [1, 0.9, 0.95, 0.88, 1, 0.92],
    gap: [1, 1, 1, 1, 1, 1],
    idle: 600,
    flare: 1500,
    size: 0.9,
    grit: 0.8,
    clatter: 2.6,
    clatterHz: 1100,
    diesel: true,
    knock: 1.4,
    bright: 0.85,
    crank: { rate: 0.75, grain: 0.8, chuff: 1.4 },
  },
  // Inline four: light and busy.
  hatch: {
    label: "four-cylinder",
    cyl: 4,
    order: [1, 0.9, 0.95, 0.88],
    gap: [1, 1, 1, 1],
    idle: 850,
    flare: 3000,
    size: 1.5,
    grit: 1.1,
    clatter: 1.2,
    clatterHz: 1900,
    knock: 0.35,
    bright: 1.3,
    crank: { rate: 1.25, grain: 1.3, chuff: 0.7 },
  },
  // V12: smooth and refined.
  tourer: {
    label: "V12",
    cyl: 12,
    order: [1, 0.92, 0.97, 0.9, 1, 0.94, 0.96, 0.9, 1, 0.93, 0.97, 0.91],
    gap: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    idle: 750,
    flare: 2800,
    size: 1.15,
    grit: 0.45,
    clatter: 0.4,
    clatterHz: 2000,
    knock: 0.25,
    bright: 1.2,
    crank: { rate: 1.1, grain: 1.1, chuff: 0.6 },
  },
  // Boxer four with unequal-length headers: the off-beat rally warble.
  boxer: {
    label: "flat-four",
    cyl: 4,
    order: [1, 0.68, 0.95, 0.64],
    gap: [0.7, 1.3, 0.75, 1.25],
    idle: 820,
    flare: 3200,
    size: 1.3,
    grit: 1.2,
    clatter: 1,
    clatterHz: 1800,
    knock: 0.4,
    bright: 1.2,
    crank: { rate: 1.2, grain: 1.2, chuff: 0.8 },
  },
  // An old carburetted straight-six: loose, dirty, a low idle.
  classic: {
    label: "classic straight-six",
    cyl: 6,
    order: [1, 0.74, 0.9, 0.7, 0.95, 0.8],
    gap: [0.9, 1.1, 0.95, 1.05, 0.92, 1.08],
    idle: 560,
    flare: 1700,
    size: 0.95,
    grit: 1.5,
    clatter: 1.6,
    clatterHz: 1500,
    knock: 0.6,
    bright: 0.8,
    wobble: 0.04,
    crank: { rate: 0.9, grain: 0.9, chuff: 1.1 },
  },
};

const BY_GENRE = {
  Action: "muscle",
  Shooter: "muscle",
  Fighting: "muscle",
  Racing: "coupe",
  Sports: "coupe",
  Simulation: "pickup",
  Strategy: "pickup",
  "Massively Multiplayer": "pickup",
  Casual: "hatch",
  Puzzle: "hatch",
  Platformer: "hatch",
  RPG: "tourer",
  Adventure: "tourer",
  Roguelike: "boxer",
};
// Steam's software categories (Utilities, Audio Production, …) are work vehicles.
const SOFTWARE = /Utilities|Production|Editing|Modeling|Illustration|Development|Publishing|Accounting|Education|Training/;

/** FNV-1a, for a seed from the id. */
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: a small seeded generator, so the variations are the same every time. */
function seeded(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The archetype for a game: classic for old games, else by genre, else by its id. */
export function archetypeOf(entry) {
  const year = Number(String(entry?.metadata?.releaseDate ?? "").slice(0, 4));
  if (year && year < 2003) return "classic";
  if (entry?.kind === "tool") return "pickup";
  const genres = entry?.metadata?.genres ?? [];
  const specific = genres.filter((g) => !BROAD.has(g));
  for (const g of [...specific, ...genres]) {
    if (BY_GENRE[g]) return BY_GENRE[g];
    if (SOFTWARE.test(g)) return "pickup";
  }
  const pool = ["muscle", "coupe", "pickup", "hatch", "tourer", "boxer"];
  return pool[hash(`${entry?.id ?? ""}:kind`) % pool.length];
}

/** This game's engine: its archetype, nudged by its id. */
export function voiceFor(entry) {
  const kind = archetypeOf(entry);
  const base = ARCHETYPES[kind];
  const rnd = seeded(hash(entry?.id ?? "unknown"));
  const vary = (x, spread) => x * (1 + (rnd() * 2 - 1) * spread);
  const v = {
    kind,
    label: base.label,
    seed: hash(entry?.id ?? "unknown"),
    cyl: base.cyl,
    order: base.order.map((o) => Math.max(0.2, Math.min(1, o + (rnd() * 2 - 1) * 0.07))),
    gap: base.gap.map((g) => g * (1 + (rnd() * 2 - 1) * 0.04)),
    idle: Math.round(vary(base.idle, 0.08)),
    flare: Math.round(vary(base.flare, 0.1)),
    size: vary(base.size, 0.1),
    grit: vary(base.grit, 0.25),
    clatter: vary(base.clatter, 0.3),
    clatterHz: vary(base.clatterHz, 0.12),
    knock: vary(base.knock, 0.25),
    bright: vary(base.bright, 0.12),
    wobble: base.wobble ?? 0.03,
    diesel: !!base.diesel,
    crank: {
      rate: vary(base.crank.rate, 0.1),
      grain: vary(base.crank.grain, 0.12),
      chuff: vary(base.crank.chuff, 0.15),
    },
    leakCyl: Math.floor(rnd() * base.cyl), // where a worn exhaust starts to leak
    quirk: null,
  };
  // The gaps average one, so the pattern doesn't change the revs.
  const mean = v.gap.reduce((a, b) => a + b, 0) / v.gap.length;
  v.gap = v.gap.map((g) => g / mean);
  // Now and then, a car with a character of its own.
  const q = rnd();
  if (q < 0.14) {
    v.quirk = "loud exhaust";
    v.grit *= 1.45;
    v.size *= 0.9;
  } else if (q < 0.24) {
    v.quirk = "lumpy cam";
    v.gap = v.gap.map((g, i) => (i % 2 ? g * 1.12 : g * 0.88));
    v.order = v.order.map((o, i) => (i % 2 ? o * 0.8 : o));
    v.idle = Math.round(v.idle * 0.92);
  } else if (q < 0.34) {
    v.quirk = "ticking lifters";
    v.clatter *= 1.7;
  }
  return v;
}
