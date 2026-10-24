// Grand Tour's sounds, synthesized with Web Audio: a starter motor cranking, a V8 catching or
// stalling (rendered from a physical model, below), a pressure washer, the tune-up beeps, and the menu's glassy ticks and chimes.
// Nothing is recorded, so there are no files to load and nothing borrowed.
import vellum from "/__vellum/sdk.js";
import { V8, strokesFor } from "./engine-synth.js";

let ctx = null;
let master = null;
let noiseBuf = null;

const on = () => vellum.skin.options.sounds !== false;
const menuOn = () => vellum.skin.options.menuSounds !== false;
const volume = () => Math.max(0, Math.min(1, (Number(vellum.skin.options.volume) || 70) / 100));

function audio(enabled = on()) {
  if (!enabled) return null;
  try {
    if (!ctx) {
      ctx = new AudioContext();
      master = ctx.createGain();
      // A gentle limiter so overlapping sounds never clip.
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -10;
      comp.ratio.value = 6;
      master.connect(comp).connect(ctx.destination);
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === "suspended") void ctx.resume();
    master.gain.value = volume() * 0.9;
    return ctx;
  } catch {
    return null; // no audio device
  }
}

function noise(a, t, dur) {
  const n = a.createBufferSource();
  n.buffer = noiseBuf;
  n.loop = true;
  n.start(t);
  n.stop(t + dur + 0.05);
  return n;
}

// ---- the engine ------------------------------------------------------------------------------
//
// The starter and the engine are rendered sample by sample into buffers, not built from plain
// oscillators (which sound like a chiptune). Each game has its own engine voice (engine-voice.js):
// an archetype from its genre (a lumpy V8, a diesel pickup, a V12...) with small variations from
// its id. Each firing is a pressure pulse that rings through a bank of exhaust resonances in the
// voice's firing pattern, with grit on top. Condition makes it dirtier and stranger: misfires,
// more rasp, a leaking exhaust, a knocking rod, a surging idle, a backfire. Nothing is a pure
// tone that bends with the revs; that sounds like a laser. Both play through a garage reverb.
// The rendering itself is in engine-synth.js and runs in a worker (engine.worker.js), so a start
// never holds up a frame.

let room = null; // the reverb's input
let ahead = null; // { key, p }: what follows the crank, rendered while the starter turns

function bus(a) {
  if (!room) {
    // A garage: a few early reflections off concrete, then a darkening tail.
    const len = Math.floor(a.sampleRate * 1.2);
    const ir = a.createBuffer(2, len, a.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (const [ms, g] of [
        [9 + c * 2, 0.5],
        [17 - c * 3, 0.35],
        [31 + c * 4, 0.25],
        [46 - c * 5, 0.18],
      ])
        d[Math.floor((ms / 1000) * a.sampleRate)] += g;
      let lp = 0;
      for (let i = Math.floor(0.02 * a.sampleRate); i < len; i++) {
        const k = i / len;
        lp += (Math.random() * 2 - 1 - lp) * (0.6 - 0.5 * k);
        d[i] += lp * 0.35 * Math.pow(1 - k, 3);
      }
    }
    const verb = a.createConvolver();
    verb.buffer = ir;
    room = a.createGain();
    room.gain.value = 0.22;
    room.connect(verb).connect(master);
  }
  return room;
}

function play(a, buf, at, level) {
  const src = a.createBufferSource();
  src.buffer = buf;
  const g = a.createGain();
  g.gain.value = level;
  src.connect(g);
  g.connect(master);
  g.connect(bus(a));
  src.start(at);
  return g;
}


let worker = null;
let seq = 0;
const waiting = new Map(); // id -> { resolve, reject }

/** Renders `kind` ("crank", "fire" or "stall") in the engine worker: resolves to [left, right]. */
function synth(kind, sr, args) {
  if (!worker) {
    worker = new Worker(new URL("./engine.worker.js", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }) => {
      const w = waiting.get(data.id);
      waiting.delete(data.id);
      if (data.ok) w?.resolve(data.out);
      else w?.reject(new Error(data.error));
    };
    worker.onerror = (e) => {
      for (const w of waiting.values()) w.reject(e);
      waiting.clear();
    };
  }
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    worker.postMessage({ id, kind, sr, args });
  });
}
// Start the worker when the page is idle, so the first start doesn't wait for it to load.
(self.requestIdleCallback ?? setTimeout)(() => {
  try {
    if (on()) void synth("stall", 8000, [V8]).catch(() => {});
  } catch {
    // options not ready yet: the first start loads the worker instead
  }
});

function toBuffer(a, [L, R]) {
  const buf = a.createBuffer(2, L.length, a.sampleRate);
  buf.copyToChannel(L, 0);
  buf.copyToChannel(R, 1);
  return buf;
}

/**
 * The starter cranking for `dur` seconds; worn engines (low `health`) crank slower and rougher
 * (`slowing`: it won't catch). Resolves with the compression stroke times, for the tachometer,
 * once the sound is on its way, so the two start together.
 */
export async function crank(dur, health = 1, slowing = false, voice = V8) {
  const strokes = strokesFor(dur, health, slowing, voice);
  const a = audio();
  if (!a) return strokes;
  try {
    play(a, toBuffer(a, await synth("crank", a.sampleRate, [dur, health, slowing, voice, strokes])), a.currentTime + 0.02, 0.6);
  } catch {
    return strokes; // no sound this time; the start goes on
  }
  // Render what follows now, while the starter turns, so it starts on time.
  const kind = slowing ? "stall" : "fire";
  ahead = { key: slowing ? `stall:${voice.seed}` : `fire:${voice.seed}:${health.toFixed(2)}`, p: synth(kind, a.sampleRate, slowing ? [voice] : [health, voice]) };
  ahead.p.catch(() => {});
  return strokes;
}

function rendered(kind, key, sr, args) {
  const p = ahead?.key === key ? ahead.p : synth(kind, sr, args);
  ahead = null;
  return p;
}

/** The engine catches: a rough first fire, a flare of revs, then a settling idle. */
export async function fire(health = 1, voice = V8) {
  const a = audio();
  if (!a) return;
  try {
    const out = await rendered("fire", `fire:${voice.seed}:${health.toFixed(2)}`, a.sampleRate, [health, voice]);
    play(a, toBuffer(a, out), a.currentTime + 0.02, 0.85);
  } catch {
    // no sound this time
  }
}

/** It doesn't catch: a couple of weak coughs as the cranking dies, the engine rocks back. */
export async function stall(at = 0, voice = V8) {
  const a = audio();
  if (!a) return;
  try {
    const out = await rendered("stall", `stall:${voice.seed}`, a.sampleRate, [voice]);
    play(a, toBuffer(a, out), a.currentTime + 0.02 + at, 0.7);
  } catch {
    // no sound this time
  }
}


/** A pressure-washer hiss; returns a stop function. */
export function hiss() {
  const a = audio();
  if (!a) return () => {};
  const now = a.currentTime;
  const n = a.createBufferSource();
  n.buffer = noiseBuf;
  n.loop = true;
  const bp = a.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 3200;
  bp.Q.value = 0.7;
  const g = a.createGain();
  g.gain.setValueAtTime(0, now);
  g.gain.linearRampToValueAtTime(0.16, now + 0.06);
  n.connect(bp).connect(g).connect(master);
  n.start(now);
  return () => {
    const t = a.currentTime;
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(g.gain.value, t);
    g.gain.linearRampToValueAtTime(0, t + 0.08);
    n.stop(t + 0.1);
  };
}

/** Tune-up feedback: a clean beep for a hit, a buzz for a miss. */
export function beep(hit) {
  const a = audio();
  if (!a) return;
  const now = a.currentTime + 0.01;
  const o = a.createOscillator();
  o.type = hit ? "sine" : "square";
  o.frequency.value = hit ? 1320 : 150;
  const g = a.createGain();
  g.gain.setValueAtTime(hit ? 0.3 : 0.18, now);
  g.gain.exponentialRampToValueAtTime(0.001, now + (hit ? 0.12 : 0.22));
  o.connect(g).connect(master);
  o.start(now);
  o.stop(now + 0.25);
}

// ---- menu ------------------------------------------------------------------------------------

/** A short bell: a sine with a quiet overtone, struck and left to ring for `len` seconds. */
function bell(a, t, freq, level, len = 0.12) {
  for (const [mult, share, type] of [
    [1, 1, "sine"],
    [2.76, 0.18, "sine"],
  ]) {
    const o = a.createOscillator();
    o.type = type;
    o.frequency.value = freq * mult;
    const g = a.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level * share, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0005, t + len * (mult > 1 ? 0.5 : 1));
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + len + 0.02);
  }
}

const lastAt = new Map();

/**
 * Menu sounds, in the manner of a turn-of-the-century racing game's front end:
 *   move     a glassy tick as the cursor steps (a touch higher going right or down)
 *   bump     a soft, dull knock when there is nowhere to go
 *   select   two rising notes
 *   back     two falling notes
 *   view     an air swoosh as the mode changes
 *   favorite a quick sparkle
 *   open     a blip as a menu opens
 *   start    the chord as the title screen gives way
 * The same sound is never repeated within 45 ms, so held keys and doubled events stay clean.
 */
export function ui(kind, dir = null) {
  const a = audio(menuOn());
  if (!a) return;
  const now = a.currentTime + 0.005;
  // Measured on the page's clock: the audio clock stands still while the context is starting up,
  // which would make a second real press look like a doubled event.
  const at = performance.now();
  const prev = lastAt.get(kind) ?? -Infinity;
  if (at - prev < 45) return;
  lastAt.set(kind, at);
  switch (kind) {
    case "move": {
      const up = dir === "right" || dir === "down" || dir === "pageDown";
      bell(a, now, up ? 1880 : 1720, 0.075, 0.07);
      break;
    }
    case "bump": {
      const o = a.createOscillator();
      o.type = "sine";
      o.frequency.setValueAtTime(240, now);
      o.frequency.exponentialRampToValueAtTime(150, now + 0.07);
      const g = a.createGain();
      g.gain.setValueAtTime(0.11, now);
      g.gain.exponentialRampToValueAtTime(0.0005, now + 0.09);
      o.connect(g).connect(master);
      o.start(now);
      o.stop(now + 0.1);
      break;
    }
    case "select":
      bell(a, now, 1318.5, 0.12, 0.1);
      bell(a, now + 0.065, 1975.5, 0.13, 0.22);
      break;
    case "back":
      bell(a, now, 1318.5, 0.1, 0.09);
      bell(a, now + 0.06, 880, 0.1, 0.18);
      break;
    case "favorite":
      [1568, 2093, 2637, 3136].forEach((f, i) => bell(a, now + i * 0.04, f, 0.06, 0.16));
      break;
    case "open":
      bell(a, now, 990, 0.09, 0.08);
      bell(a, now + 0.035, 1485, 0.07, 0.1);
      break;
    case "view": {
      const n = noise(a, now, 0.32);
      const bp = a.createBiquadFilter();
      bp.type = "bandpass";
      bp.Q.value = 1.4;
      bp.frequency.setValueAtTime(500, now);
      bp.frequency.exponentialRampToValueAtTime(4200, now + 0.22);
      const g = a.createGain();
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(0.14, now + 0.07);
      g.gain.exponentialRampToValueAtTime(0.0005, now + 0.3);
      n.connect(bp).connect(g).connect(master);
      bell(a, now + 0.12, 2349, 0.05, 0.18);
      break;
    }
    case "start": {
      // A bright major-seventh chord swelling in, over a low fifth.
      [261.6, 329.6, 392, 493.9, 130.8, 196].forEach((f, i) => {
        const o = a.createOscillator();
        o.type = i < 4 ? "triangle" : "sine";
        o.frequency.value = f * 2;
        const g = a.createGain();
        g.gain.setValueAtTime(0, now);
        g.gain.linearRampToValueAtTime(i < 4 ? 0.05 : 0.07, now + 0.08 + i * 0.03);
        g.gain.exponentialRampToValueAtTime(0.0005, now + 1.4);
        o.connect(g).connect(master);
        o.start(now);
        o.stop(now + 1.45);
      });
      break;
    }
  }
}
