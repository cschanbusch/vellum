// FICSIT's factory ambience: the sound of a terminal on a factory floor, synthesized with Web
// Audio (no recordings, so no files). It isn't music; it's a bed that sits under the skin.
//
// Layers, each with its own level per view (MIX):
// - hall: mains hum and low room tone, the floor everything stands on;
// - pad: a slow, dark chord through a filter that drifts open and closed, changing every
//   half-minute or so;
// - machines: two distant machines working at their own rhythms, panned apart;
// - belt: a conveyor's rattle that drifts in and out;
// - events: distant clanks and pneumatic hisses at random times.
// Everything goes through a long factory-hall reverb. It fades out whenever Vellum isn't in front
// (a game, another app) and suspends the audio context once silent, so it costs nothing then.
import vellum from "/__vellum/sdk.js";

/** Per view, each layer's level (0-1) and how often events happen (per minute). */
const MIX = {
  covers: { hall: 1, pad: 0.8, machines: 0.6, belt: 0.35, events: 2.5 },
  list: { hall: 1, pad: 0.7, machines: 0.5, belt: 0.3, events: 2 },
  spotlight: { hall: 0.8, pad: 1, machines: 0.3, belt: 0.15, events: 1.2 },
  hub: { hall: 1, pad: 0.65, machines: 1, belt: 0.8, events: 5 },
};
const DEFAULT_MIX = MIX.covers;
/** While the HUB's submit ceremony plays: the factory steps back. */
const DUCK = 0.35;

/** Chords for the pad, as MIDI notes: a dark, open D Dorian with no thirds on top. */
const CHORDS = [
  [38, 45, 50, 57, 64],
  [34, 41, 50, 53, 60],
  [36, 43, 48, 55, 62],
  [31, 38, 50, 57, 65],
  [41, 48, 53, 57, 64],
];
const hz = (n) => 440 * 2 ** ((n - 69) / 12);

let ctx = null;
let out = null; // master: the user's level x focus x duck
let layers = null; // name -> GainNode
let noiseBuf = null;
let wet = null;
let dry = null;
let started = false;
let inFront = true;
let ducked = false;
let view = null;
let eventTimer = 0;
let chordTimer = 0;
let chordAt = 0;
let pad = []; // the sounding chord's voices
let suspendTimer = 0;

const enabled = () => vellum.skin.options.ambience !== false;
const level = () => Math.max(0, Math.min(1, Number(vellum.skin.options.ambienceVolume ?? 0.4)));
const rand = (a, b) => a + Math.random() * (b - a);

// ---- the graph --------------------------------------------------------------------------------

function build() {
  ctx = new AudioContext({ latencyHint: "playback" });
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -18;
  comp.ratio.value = 3;
  comp.connect(ctx.destination);
  out = ctx.createGain();
  out.gain.value = 0;
  out.connect(comp);

  noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

  // A big hall: 3.4 s of decaying noise that darkens as it fades, slightly different per side.
  const len = Math.floor(ctx.sampleRate * 3.4);
  const ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const ch = ir.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const k = i / len;
      lp += (Math.random() * 2 - 1 - lp) * (0.35 - 0.31 * k);
      ch[i] = lp * Math.pow(1 - k, 2.2);
    }
  }
  const verb = ctx.createConvolver();
  verb.buffer = ir;
  wet = ctx.createGain();
  wet.gain.value = 0.55;
  wet.connect(verb).connect(out);
  dry = ctx.createGain();
  dry.connect(out);

  layers = {};
  for (const name of ["hall", "pad", "machines", "belt", "events"]) {
    const g = ctx.createGain();
    g.gain.value = 0;
    layers[name] = g;
  }
  // How much of each layer is the room rather than the source: distant things are mostly room.
  route(layers.hall, 0.8, 0.25);
  route(layers.pad, 0.45, 0.8);
  route(layers.machines, 0.25, 1);
  route(layers.belt, 0.4, 0.8);
  route(layers.events, 0.15, 1);

  hall();
  machine(rand(0.9, 1.3), -0.6, 340);
  machine(rand(0.45, 0.7), 0.55, 520);
  belt();
  chord(true);
}

function route(g, d, w) {
  const a = ctx.createGain();
  a.gain.value = d;
  g.connect(a).connect(dry);
  const b = ctx.createGain();
  b.gain.value = w;
  g.connect(b).connect(wet);
}

function noise() {
  const n = ctx.createBufferSource();
  n.buffer = noiseBuf;
  n.loop = true;
  n.loopStart = rand(0, 3);
  n.start(ctx.currentTime, rand(0, 3));
  return n;
}

function lfo(freq, depth, target, type = "sine") {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.value = depth;
  o.connect(g).connect(target);
  o.start();
  return o;
}

/** Mains hum (a 50 Hz fundamental with a few odd harmonics) and low room tone, breathing slowly. */
function hall() {
  const hum = ctx.createGain();
  hum.gain.value = 0.05;
  for (const [f, a] of [
    [50, 1],
    [100, 0.35],
    [150, 0.22],
    [250, 0.06],
  ]) {
    const o = ctx.createOscillator();
    o.frequency.value = f * rand(0.998, 1.002);
    const g = ctx.createGain();
    g.gain.value = a;
    o.connect(g).connect(hum);
    o.start();
  }
  lfo(0.06, 0.015, hum.gain);
  hum.connect(layers.hall);

  const room = noise();
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 220;
  lp.Q.value = 0.3;
  const g = ctx.createGain();
  g.gain.value = 0.22;
  lfo(0.031, 70, lp.frequency);
  room.connect(lp).connect(g).connect(layers.hall);
}

/** A distant machine: a filtered thump-and-whirr working at `rate` cycles a second. */
function machine(rate, pan, freq) {
  const src = noise();
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = freq;
  bp.Q.value = 1.4;
  const amp = ctx.createGain();
  amp.gain.value = 0.03;
  // The work cycle: a softened square wave on the level, so it pulses rather than drones.
  const cyc = ctx.createOscillator();
  cyc.type = "square";
  cyc.frequency.value = rate;
  const soft = ctx.createBiquadFilter();
  soft.type = "lowpass";
  soft.frequency.value = rate * 5;
  const depth = ctx.createGain();
  depth.gain.value = 0.025;
  cyc.connect(soft).connect(depth).connect(amp.gain);
  cyc.start();
  lfo(0.05, freq * 0.08, bp.frequency);
  const p = ctx.createStereoPanner();
  p.pan.value = pan;
  src.connect(bp).connect(amp).connect(p).connect(layers.machines);
}

/** A conveyor: a bright rattle at the rollers' rate that drifts across and in and out. */
function belt() {
  const src = noise();
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 1900;
  bp.Q.value = 2.2;
  const rattle = ctx.createGain();
  rattle.gain.value = 0.012;
  lfo(11.5, 0.01, rattle.gain, "triangle");
  // Comes and goes: a slow swell between nearly nothing and present.
  const swell = ctx.createGain();
  swell.gain.value = 0.5;
  lfo(1 / 37, 0.48, swell.gain);
  const p = ctx.createStereoPanner();
  lfo(1 / 53, 0.7, p.pan);
  src.connect(bp).connect(rattle).connect(swell).connect(p).connect(layers.belt);
}

/** Moves the pad to the next chord: the old voices fade over eight seconds as the new rise. */
function chord(first = false) {
  const now = ctx.currentTime;
  for (const v of pad) {
    v.g.gain.setTargetAtTime(0, now, 2.6);
    v.stop(now + 12);
  }
  const notes = CHORDS[Math.floor(Math.random() * CHORDS.length)];
  pad = notes.map((n, i) => voice(n, i, notes.length, first));
  chordAt = performance.now();
}

/** One pad note: two detuned saws and a sine an octave down, through a filter that breathes. */
function voice(note, i, count, first) {
  const now = ctx.currentTime;
  const g = ctx.createGain();
  g.gain.value = 0;
  g.gain.setTargetAtTime((0.05 / Math.sqrt(count)) * (i === 0 ? 1.3 : 1), now, first ? 1.5 : 2.6);
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.Q.value = 0.7;
  lp.frequency.value = 420 + i * 60;
  const sweep = lfo(rand(0.018, 0.04), rand(160, 300), lp.frequency);
  const oscs = [];
  for (const [type, ratio, cents, amp] of [
    ["sawtooth", 1, -7, 0.5],
    ["sawtooth", 1, 6, 0.5],
    ["sine", 0.5, 0, 0.6],
  ]) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = hz(note) * ratio;
    o.detune.value = cents + rand(-2, 2);
    const a = ctx.createGain();
    a.gain.value = amp;
    o.connect(a).connect(lp);
    o.start(now);
    oscs.push(o);
  }
  const p = ctx.createStereoPanner();
  p.pan.value = (i / Math.max(1, count - 1)) * 1.2 - 0.6;
  lp.connect(g).connect(p).connect(layers.pad);
  return {
    g,
    stop(t) {
      for (const o of oscs) o.stop(t);
      sweep.stop(t);
    },
  };
}

/** A distant clank (an inharmonic metal ring) or a pneumatic hiss, somewhere on the floor. */
function event() {
  const now = ctx.currentTime;
  const p = ctx.createStereoPanner();
  p.pan.value = rand(-0.9, 0.9);
  p.connect(layers.events);
  if (Math.random() < 0.65) {
    const base = rand(140, 420);
    for (const [ratio, amp, dur] of [
      [1, 1, 1.4],
      [2.76, 0.5, 0.9],
      [5.4, 0.25, 0.5],
      [8.93, 0.12, 0.3],
    ]) {
      const o = ctx.createOscillator();
      o.frequency.value = base * ratio;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(0.07 * amp, now + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
      o.connect(g).connect(p);
      o.start(now);
      o.stop(now + dur + 0.05);
    }
  } else {
    const n = noise();
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = rand(2500, 4500);
    const g = ctx.createGain();
    const dur = rand(0.6, 1.6);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.05, now + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    n.connect(hp).connect(g).connect(p);
    n.stop(now + dur + 0.05);
  }
}

// ---- control ----------------------------------------------------------------------------------

function mix() {
  return MIX[view] ?? DEFAULT_MIX;
}

/** Applies the view's mix and the master level (user level, focus, duck), easing over `secs`. */
function apply(secs = 3) {
  if (!ctx) return;
  const now = ctx.currentTime;
  const m = mix();
  for (const [name, g] of Object.entries(layers)) g.gain.setTargetAtTime(m[name] ?? 0, now, secs / 3);
  const target = enabled() && inFront ? level() * (ducked ? DUCK : 1) : 0;
  out.gain.setTargetAtTime(target, now, target ? 0.8 : 0.35);
  if (target > 0 && ctx.state === "suspended") void ctx.resume();
  // Once silent, stop the audio thread altogether.
  if (target === 0) {
    clearTimeout(suspendTimer);
    suspendTimer = setTimeout(() => {
      if (ctx && out.gain.value < 0.001 && ctx.state === "running") void ctx.suspend();
    }, 2500);
  }
}

/** Events at random, about as often per minute as the view says. */
function scheduleEvent() {
  clearTimeout(eventTimer);
  const perMin = mix().events;
  eventTimer = setTimeout(() => {
    if (ctx?.state === "running" && out.gain.value > 0.001) event();
    scheduleEvent();
  }, (60_000 / perMin) * rand(0.4, 1.6));
}

function scheduleChord() {
  clearTimeout(chordTimer);
  chordTimer = setTimeout(() => {
    if (ctx?.state === "running") chord();
    scheduleChord();
  }, rand(26_000, 44_000));
}

/** Starts once the page may play sound (browsers wait for the first click or key). */
function start() {
  if (started || !enabled()) return;
  try {
    build();
  } catch {
    return; // no audio device
  }
  started = true;
  apply(1);
  scheduleEvent();
  scheduleChord();
}

function whenAllowed() {
  if (navigator.userActivation?.hasBeenActive) return start();
  const go = () => {
    removeEventListener("pointerdown", go, true);
    removeEventListener("keydown", go, true);
    start();
  };
  addEventListener("pointerdown", go, true);
  addEventListener("keydown", go, true);
  // Some views swallow the first input before it bubbles here; userActivation still notices it.
  const poll = setInterval(() => {
    if (started) return clearInterval(poll);
    if (navigator.userActivation?.hasBeenActive) {
      clearInterval(poll);
      go();
    }
  }, 500);
}

function setFront(front) {
  if (front === inFront) return;
  inFront = front;
  apply();
}

export function initAmbience() {
  view = vellum.state.get().view;
  // Vellum 0.4 can't say at start-up: assume in front until a change says otherwise.
  inFront = vellum.window.isFocused?.() ?? true;
  vellum.window.on("change", (w) => w.focused !== undefined && setFront(w.focused));
  document.addEventListener("visibilitychange", () => setFront(document.visibilityState === "visible" && (vellum.window.isFocused?.() ?? true)));
  vellum.state.on("change", (s) => {
    if (s.view === view) return;
    view = s.view;
    apply();
    scheduleEvent();
  });
  vellum.skin.on("options", () => {
    if (enabled() && !started) whenAllowed();
    apply(0.6);
  });
  addEventListener("fx:dispatch", () => ((ducked = true), apply(0.8)));
  addEventListener("fx:return", () => ((ducked = false), apply(2)));
  whenAllowed();
  // For tests: what is playing, without listening.
  window.__fxAmbience = () => ({
    started,
    state: ctx?.state ?? null,
    view,
    inFront,
    ducked,
    target: enabled() && inFront ? level() * (ducked ? DUCK : 1) : 0,
    mix: { ...mix() },
    chordAt,
  });
}
