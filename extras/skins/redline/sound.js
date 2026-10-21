// Redline's sounds, synthesized with Web Audio: a starter motor cranking, an engine catching or
// stalling, a pressure washer and the tune-up beeps. Nothing is recorded, so there are no files
// to load and nothing borrowed.
import vellum from "/__vellum/sdk.js";

let ctx = null;
let master = null;
let noiseBuf = null;

const on = () => vellum.skin.options.sounds !== false;
const volume = () => Math.max(0, Math.min(1, (Number(vellum.skin.options.volume) || 70) / 100));

function audio() {
  if (!on()) return null;
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

/** A short click, as the starter solenoid engages. */
function click(a, t, level = 0.5) {
  const n = noise(a, t, 0.04);
  const hp = a.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 1800;
  const g = a.createGain();
  g.gain.setValueAtTime(level, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.035);
  n.connect(hp).connect(g).connect(master);
}

/**
 * The starter cranking for `dur` seconds: a geared whine that labours on each compression
 * stroke. Worn engines (low `health`) crank slower and rougher. Returns the stroke times so the
 * tachometer can twitch in step.
 */
export function crank(dur, health = 1, slowing = false) {
  const a = audio();
  const strokes = [];
  const rate0 = 4.2 + health * 2.2; // strokes per second
  let t = 0;
  while (t < dur) {
    strokes.push(t);
    const k = slowing ? 1 - (t / dur) * 0.6 : 1;
    t += 1 / (rate0 * k);
  }
  if (!a) return strokes;
  const now = a.currentTime + 0.02;
  click(a, now, 0.6);

  const motor = a.createOscillator();
  motor.type = "sawtooth";
  const lp = a.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 1100;
  lp.Q.value = 2;
  const g = a.createGain();
  g.gain.setValueAtTime(0, now);
  const grind = noise(a, now, dur);
  const bp = a.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 2400;
  bp.Q.value = 0.8;
  const gn = a.createGain();
  gn.gain.value = 0;
  strokes.forEach((s, i) => {
    const at = now + s;
    const span = (strokes[i + 1] ?? dur) - s;
    // Labour (pitch and level drop) then free-spin between strokes.
    motor.frequency.setValueAtTime(150 + health * 30, at);
    motor.frequency.linearRampToValueAtTime(95 + health * 20, at + span * 0.35);
    motor.frequency.linearRampToValueAtTime(165 + health * 30, at + span * 0.95);
    g.gain.setValueAtTime(0.16, at);
    g.gain.linearRampToValueAtTime(0.34, at + span * 0.3);
    g.gain.linearRampToValueAtTime(0.18, at + span * 0.95);
    gn.gain.setValueAtTime(0.03, at);
    gn.gain.linearRampToValueAtTime(0.09, at + span * 0.3);
    gn.gain.linearRampToValueAtTime(0.03, at + span * 0.95);
  });
  g.gain.linearRampToValueAtTime(0, now + dur + 0.04);
  gn.gain.linearRampToValueAtTime(0, now + dur + 0.04);
  motor.connect(lp).connect(g).connect(master);
  grind.connect(bp).connect(gn).connect(master);
  motor.start(now);
  motor.stop(now + dur + 0.08);
  return strokes;
}

/** The engine catches: a rough first fire, a blip of revs, then a settling idle. */
export function fire() {
  const a = audio();
  if (!a) return;
  const now = a.currentTime + 0.02;
  const dur = 1.9;
  // Firing frequency (Hz): cylinders firing per second.
  const f = (o) => {
    o.frequency.setValueAtTime(14, now);
    o.frequency.exponentialRampToValueAtTime(70, now + 0.32);
    o.frequency.exponentialRampToValueAtTime(30, now + 1.0);
    o.frequency.setValueAtTime(30, now + dur);
  };
  const o1 = a.createOscillator();
  o1.type = "sawtooth";
  f(o1);
  const o2 = a.createOscillator();
  o2.type = "square";
  f(o2);
  o2.detune.value = -1200; // an octave down for body
  const shaper = a.createWaveShaper();
  const curve = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const x = i / 128 - 1;
    curve[i] = Math.tanh(x * 3);
  }
  shaper.curve = curve;
  const lp = a.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(260, now);
  lp.frequency.linearRampToValueAtTime(900, now + 0.32);
  lp.frequency.linearRampToValueAtTime(380, now + 1.1);
  const g = a.createGain();
  g.gain.setValueAtTime(0, now);
  g.gain.linearRampToValueAtTime(0.55, now + 0.06);
  g.gain.setValueAtTime(0.55, now + 1.2);
  g.gain.exponentialRampToValueAtTime(0.001, now + dur);
  // Exhaust breath.
  const ex = noise(a, now, dur);
  const bp = a.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 180;
  bp.Q.value = 1.2;
  const ge = a.createGain();
  ge.gain.setValueAtTime(0, now);
  ge.gain.linearRampToValueAtTime(0.35, now + 0.3);
  ge.gain.exponentialRampToValueAtTime(0.001, now + dur);
  o1.connect(shaper);
  o2.connect(shaper);
  shaper.connect(lp).connect(g).connect(master);
  ex.connect(bp).connect(ge).connect(master);
  for (const o of [o1, o2]) {
    o.start(now);
    o.stop(now + dur + 0.05);
  }
}

/** It doesn't catch: a couple of coughs as the cranking dies, then a clunk. */
export function stall(at = 0) {
  const a = audio();
  if (!a) return;
  const now = a.currentTime + 0.02 + at;
  for (const [t, level] of [
    [0.0, 0.5],
    [0.28, 0.32],
  ]) {
    const n = noise(a, now + t, 0.16);
    const lp = a.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(420, now + t);
    lp.frequency.exponentialRampToValueAtTime(90, now + t + 0.15);
    const g = a.createGain();
    g.gain.setValueAtTime(level, now + t);
    g.gain.exponentialRampToValueAtTime(0.001, now + t + 0.15);
    n.connect(lp).connect(g).connect(master);
  }
  const o = a.createOscillator();
  o.type = "triangle";
  o.frequency.setValueAtTime(70, now + 0.55);
  o.frequency.exponentialRampToValueAtTime(40, now + 0.7);
  const g = a.createGain();
  g.gain.setValueAtTime(0.4, now + 0.55);
  g.gain.exponentialRampToValueAtTime(0.001, now + 0.75);
  o.connect(g).connect(master);
  o.start(now + 0.55);
  o.stop(now + 0.8);
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
