// Grand Tour's sounds, synthesized with Web Audio: a starter motor cranking, a V8 catching or
// stalling (rendered from a physical model, below), a pressure washer, the tune-up beeps, and the menu's glassy ticks and chimes.
// Nothing is recorded, so there are no files to load and nothing borrowed.
import vellum from "/__vellum/sdk.js";

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

let room = null; // the reverb's input
let fireCache = null; // { key, buf }, rendered while the starter cranks

/** A default voice, for callers that don't pass one: the cross-plane V8. */
const V8 = {
  seed: 0,
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
  wobble: 0.03,
  diesel: false,
  crank: { rate: 1, grain: 1, chuff: 1 },
  leakCyl: 3,
};

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

/**
 * A resonant band-pass (RBJ). Struck (the default), it's scaled so a unit impulse rings at about
 * `gain`; as a plain band (`struck` false) it passes its centre at `gain`, for noise.
 */
function resonator(sr, f, q, gain = 1, struck = true) {
  const w = (2 * Math.PI * Math.min(f, sr * 0.45)) / sr;
  const al = Math.sin(w) / (2 * q);
  const a0 = 1 + al;
  const b0 = al / a0;
  const a1 = (-2 * Math.cos(w)) / a0;
  const a2 = (1 - al) / a0;
  const k = struck ? gain / b0 / 2 : gain;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  return (x) => {
    const y = b0 * (x - x2) - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    return y * k;
  };
}

/** A one-pole low-pass whose cutoff can move. */
function lowpass(sr, f) {
  let y = 0;
  let a = 1 - Math.exp((-2 * Math.PI * f) / sr);
  const fn = (x) => (y += a * (x - y));
  fn.set = (hz) => (a = 1 - Math.exp((-2 * Math.PI * hz) / sr));
  return fn;
}

/** Fill a stereo buffer from `gen(t, i) -> [l, r]`, then normalise it to `peak`. */
function render(a, dur, gen, peak = 0.9) {
  const sr = a.sampleRate;
  const n = Math.ceil(dur * sr);
  const buf = a.createBuffer(2, n, sr);
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  let max = 1e-6;
  // A DC blocker (about 20 Hz): saturation leaves the uneven pulses off-centre.
  const p = Math.exp((-2 * Math.PI * 20) / sr);
  let xl = 0;
  let yl = 0;
  let xr = 0;
  let yr = 0;
  for (let i = 0; i < n; i++) {
    const [l0, r0] = gen(i / sr, i);
    const l = (yl = l0 - xl + p * yl);
    const r = (yr = r0 - xr + p * yr);
    xl = l0;
    xr = r0;
    L[i] = l;
    R[i] = r;
    max = Math.max(max, Math.abs(l), Math.abs(r));
  }
  const k = peak / max;
  for (let i = 0; i < n; i++) {
    L[i] *= k;
    R[i] *= k;
  }
  return buf;
}

const soft = (x) => Math.tanh(x);
const rnd = () => Math.random() * 2 - 1;

/** The solenoid and the pinion meeting the flywheel: a hard clack with a steel ring. */
function clack(sr) {
  const ring1 = resonator(sr, 2150, 18, 0.5, false);
  const ring2 = resonator(sr, 3420, 22, 0.3, false);
  const thunk = resonator(sr, 120, 3, 1);
  let env = 0;
  return (t, start) => {
    if (start) env = 1;
    const x = rnd() * env;
    env *= 0.993;
    return ring1(x) + ring2(x) + thunk(start ? 1 : 0) * 0.8;
  };
}

/** How worn past a threshold, 0 at `at` rising to 1 at zero condition. */
const below = (health, at) => Math.max(0, (at - health) / at);

/**
 * The exhaust of one engine: firing pulses in, a rumble out. `rpm(t)` drives it.
 *
 * An even pulse train at idle is heard as a pitched buzz; the voice's firing pattern (strong and
 * weak beats, uneven gaps) is what makes it lumpy or smooth. Each firing also thumps the block
 * and knocks, and the pulses are rounded off before the exhaust so the top end stays dull. Grit
 * rides on top, outside that filter: a rasp of noise shaped by each pulse, valve-train clatter
 * (or a diesel's combustion knock on every firing), and a little wobble in the timing. Wear adds
 * misfires, a leak ticking on one cylinder, and a rod knocking once a revolution.
 */
function exhaust(sr, health, rpm, v, backfireAt = -1) {
  const z = v.size;
  const bank = [
    resonator(sr, 42 * z, 1.4, 0.8),
    resonator(sr, 95 * z, 2.2, 1),
    resonator(sr, 210 * z, 2.6, 0.9),
    resonator(sr, 390 * z, 3, 0.45),
  ];
  const block = resonator(sr, 30, 1.1, 0.9); // the block and mounts
  const knock = resonator(sr, 260 * z, 5, 1); // a hollow, woody knock
  const blow = resonator(sr, 160 * z, 1.4, 1, false);
  const round1 = lowpass(sr, 520);
  const round2 = lowpass(sr, 520);
  const tone = lowpass(sr, 600);
  const raspBand = resonator(sr, 850 * Math.sqrt(z), 0.55, 1, false);
  const raspTop = lowpass(sr, 2200);
  const valves = resonator(sr, v.clatterHz, 0.7, 1, false);
  const leakBand = resonator(sr, 2400, 1.2, 1, false);
  const rod = resonator(sr, 330, 9, 1);
  const bang = lowpass(sr, 1400);
  const worn = 1 - health;
  const rough = 0.1 + worn * 0.35;
  const misfire = Math.pow(worn, 1.5) * 0.14;
  const leaking = below(health, 0.65);
  const knocking = below(health, 0.45);
  const grit = v.grit * (1 + worn * 0.9);
  const perRev = v.cyl / 2;
  let phase = 0;
  let k = 0;
  let burst = 0;
  let burstAmp = 0;
  let wobble = 1;
  let rasp = 0;
  let tick = 0;
  let leak = 0;
  let boom = 0;
  return (t, i) => {
    const r = rpm(t);
    phase += (r * v.cyl) / 120 / sr / v.gap[k % v.cyl] / wobble; // each cylinder fires once every two revolutions
    let x = 0;
    let rodHit = 0;
    if (phase >= 1) {
      phase -= 1;
      const cyl = k % v.cyl;
      let amp = v.order[cyl] * (1 + rnd() * rough);
      if (Math.random() < misfire) amp *= 0.1;
      if (leaking && cyl === v.leakCyl) leak = amp * leaking;
      if (knocking && k % perRev === 0) rodHit = knocking * (0.7 + Math.random() * 0.3);
      if (v.diesel) tick = Math.max(tick, 0.6 + Math.random() * 0.4); // combustion knock
      k++;
      x = amp;
      burst = 1;
      burstAmp = amp;
      rasp = amp;
      wobble = 1 + rnd() * (v.wobble + worn * 0.05);
    }
    if (i === backfireAt) {
      x += 2.2;
      boom = 1;
    }
    // Round the pulse (two poles at 520 Hz), then into the pipes.
    const p = round2(round1(x)) * 5;
    const hiss = rnd() * burst * burstAmp; // the blowdown, low and breathy
    burst *= 0.996;
    let y = 0;
    for (const f of bank) y += f(p);
    y += blow(hiss) * 0.35;
    y += block(x) * 0.9 + knock(x) * v.knock;
    if (i % 64 === 0) tone.set((520 + r * 0.35) * v.bright);
    // Grit: the rasp follows each pulse; the valves tick at random, more with revs.
    const g = raspTop(raspBand(rnd() * rasp));
    rasp *= 0.9978;
    if (Math.random() < (60 + r * 0.12) / sr) tick = Math.max(tick, 0.4 + Math.random() * 0.6);
    const clatter = valves(rnd() * tick);
    tick *= 0.982;
    // Wear: the leak's sharp puff, the rod's metallic tock, a backfire's bang.
    const puff = leakBand(rnd() * leak);
    leak *= 0.993;
    const tock = rod(rodHit) * 0.5;
    const pop = bang(rnd() * boom) * 2.5;
    boom *= 0.9992;
    return tone(soft(y * 0.3)) + g * grit * (1.8 + r / 1500) + clatter * 0.3 * v.clatter + puff * 0.5 + tock + pop;
  };
}

/**
 * The starter cranking for `dur` seconds; worn engines (low `health`) crank slower and rougher.
 * Returns the stroke times so the tachometer can twitch in step.
 *
 * Nothing in it is a pure tone: a tone that bends with each stroke sounds like a laser. The
 * motor is a grainy "rrrr" (noise bursts at an irregular rate around its turning speed), the
 * gears clatter at random, and each compression stroke makes it all louder and darker for a
 * moment before the engine chuffs past: a breath of low noise and a dull thump. A diesel's high
 * compression cranks slower and chuffs harder; a small four spins quick and light.
 */
export function crank(dur, health = 1, slowing = false, voice = V8) {
  const a = audio();
  const v = voice;
  const strokes = [];
  const rate0 = (4.2 + health * 2.2) * v.crank.rate; // strokes per second
  let t = 0;
  while (t < dur) {
    strokes.push(t);
    const k = slowing ? 1 - (t / dur) * 0.6 : 1;
    t += 1 / (rate0 * k);
  }
  if (!a) return strokes;
  const sr = a.sampleRate;
  const clk = clack(sr);
  const motorTone = lowpass(sr, 1400);
  const motorBody = resonator(sr, 260, 0.7, 0.8, false); // broad: colour, not pitch
  const clatter = resonator(sr, 1300, 0.6, 1, false);
  const breath = lowpass(sr, 380 * Math.sqrt(v.size));
  const breath2 = lowpass(sr, 380 * Math.sqrt(v.size));
  const thump = resonator(sr, 58 * Math.sqrt(v.size), 0.8, 1);
  const dark = lowpass(sr, 2000);
  const grainRate = (55 + health * 25) * v.crank.grain; // motor grains per second
  const ragged = 0.4 + (1 - health) * 0.4;
  let next = 0;
  let grain = 0;
  let grainAmp = 0;
  let clack2 = 0;
  let s = 0;
  let air = 0;
  let released = -1;
  const buf = render(a, dur + 0.06, (tt, i) => {
    while (s + 1 < strokes.length && tt >= strokes[s + 1]) s++;
    const span = (strokes[s + 1] ?? dur) - strokes[s];
    const u = (tt - strokes[s]) / span;
    const labour = Math.exp(-(((u - 0.3) / 0.18) ** 2)); // compression
    const fade = slowing ? 1 - (tt / dur) * 0.45 : 1;
    // The motor: grains at an irregular rate, a little slower under load.
    if (tt >= next) {
      next = tt + (1 + rnd() * ragged) / (grainRate * fade * (1 - 0.1 * labour));
      grain = 1;
      grainAmp = 0.6 + Math.random() * 0.4;
    }
    const g = rnd() * grain * grainAmp;
    grain *= 0.9975;
    const motor = motorTone(motorBody(g) * 1.2 + g * 0.25);
    // The gears: random small impacts, busier under load.
    if (Math.random() < (180 + 220 * labour) / sr) clack2 = 0.3 + Math.random() * 0.7;
    const gear = clatter(rnd() * clack2);
    clack2 *= 0.985;
    // The engine turning over: a chuff as each compression releases.
    const release = u >= 0.4 && released !== s;
    if (release) {
      released = s;
      air = 1;
    }
    const chuff = (breath2(breath(rnd() * air)) * 4 + thump(release ? 1 : 0) * 0.45) * v.crank.chuff;
    air *= 0.9988;
    // Under compression it all strains: louder and darker.
    if (i % 32 === 0) dark.set(900 + 1500 * (1 - labour));
    const strain = 0.55 + 0.45 * labour;
    const body = dark(motor * strain * 1.8 + gear * 0.35 * strain);
    const c = clk(tt, i === 0);
    const env = Math.min(1, tt / 0.01) * Math.min(1, (dur + 0.06 - tt) / 0.05);
    const mono = soft((body + chuff) * 1.1) * env + c * 0.5;
    return [mono + gear * 0.03, mono - gear * 0.03];
  }, 0.85);
  play(a, buf, a.currentTime + 0.02, 0.6);
  // Render the catch now, while the starter turns, so it starts on time.
  setTimeout(() => {
    fireCache = { key: `${v.seed}:${health.toFixed(2)}`, buf: renderFire(a, health, v) };
  }, 0);
  return strokes;
}

function renderFire(a, health, v) {
  const sr = a.sampleRate;
  const worn = 1 - health;
  // Revs: the catch, a flare, then down to the idle. Worn engines idle higher and surge.
  const idle = v.idle * (1 + worn * 0.1);
  const flare = v.flare;
  const huntAmp = 15 + Math.pow(worn, 1.3) * 110;
  const surge = below(health, 0.5);
  const rpm = (t) => {
    if (t < 0.04) return 300;
    if (t < 0.32) return 300 + (flare - 300) * (1 - (1 - (t - 0.04) / 0.28) ** 2.2);
    const hunt = Math.sin(t * 2 * Math.PI * 1.3) * huntAmp + Math.sin(t * 2 * Math.PI * 0.55) * surge * 140;
    return idle + (flare - idle) * Math.exp(-(t - 0.32) / 0.3) + hunt;
  };
  // A worn-out engine may backfire as the revs fall from the flare.
  const backfire = health < 0.35 && Math.random() < 0.7 ? Math.floor((0.38 + Math.random() * 0.4) * sr) : -1;
  const ex = exhaust(sr, health, rpm, v, backfire);
  // The starter letting go: it whirs on for a moment, unloaded, and the pinion clinks out.
  const clink = resonator(sr, 2900, 25, 0.35);
  const valves = resonator(sr, 2600, 2, 0.015, false);
  const dur = 2.6;
  const whir = resonator(sr, 900, 0.8, 1, false);
  return render(a, dur, (t, i) => {
    const e = ex(t, i);
    const r = rpm(t);
    const overrun = t < 0.3 ? whir(rnd()) * 0.06 * (1 - t / 0.3) ** 2 : 0;
    const pin = clink(t > 0.11 && t < 0.11 + 1 / sr ? 1 : 0);
    const tick = valves(rnd()) * (r / flare);
    const env = Math.min(1, t / 0.015) * (t < 1.8 ? 1 : Math.max(0, 1 - (t - 1.8) / 0.8) ** 1.5);
    const m = (e + tick) * env + overrun + pin * 0.4;
    return [m, m * 0.96 + tick * 0.04];
  }, 0.92);
}

/** The engine catches: a rough first fire, a flare of revs, then a settling idle. */
export function fire(health = 1, voice = V8) {
  const a = audio();
  if (!a) return;
  const key = `${voice.seed}:${health.toFixed(2)}`;
  const buf = fireCache?.key === key ? fireCache.buf : renderFire(a, health, voice);
  fireCache = null;
  play(a, buf, a.currentTime + 0.02, 0.85);
}

/** It doesn't catch: a couple of weak coughs as the cranking dies, the engine rocks back. */
export function stall(at = 0, voice = V8) {
  const a = audio();
  if (!a) return;
  const sr = a.sampleRate;
  const z = voice.size;
  const coughs = [
    [0.0, 0.7],
    [0.09, 0.35],
    [0.3, 0.45],
  ];
  const bank = [resonator(sr, 70 * z, 4, 1), resonator(sr, 150 * z, 5, 0.6), resonator(sr, 330 * z, 5, 0.3)];
  const air = resonator(sr, 160 * z, 1.5, 1, false);
  const rock = resonator(sr, 55, 2.5, 1);
  const clink = resonator(sr, 2600, 20, 0.3);
  const tone = lowpass(sr, 700);
  let burst = 0;
  let amp = 0;
  const buf = render(a, 1.0, (t, i) => {
    let x = 0;
    for (const [c, level] of coughs) {
      if (i === Math.floor(c * sr)) {
        x = level;
        burst = 1;
        amp = level;
      }
    }
    const hiss = rnd() * burst * amp;
    burst *= 0.9975;
    let y = air(hiss) * 0.8;
    for (const f of bank) y += f(x);
    const back = rock(i === Math.floor(0.58 * sr) ? 1 : 0) * 0.9;
    const pin = clink(i === Math.floor(0.62 * sr) ? 1 : 0) * 0.5;
    const m = tone(soft(y * 0.5) * 1.5) + back + pin;
    return [m, m];
  }, 0.75);
  play(a, buf, a.currentTime + 0.02 + at, 0.7);
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
