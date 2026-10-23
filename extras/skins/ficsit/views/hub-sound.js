// The HUB's sounds, synthesized with Web Audio. Nothing is recorded, so there are no files.
//
// Everything plays through a short factory-hall reverb, so the parts sound like steel in a big
// room rather than beeps:
// - belt(): a conveyor motor that runs while Submit is held, rising in pitch as the bar fills,
//   with the belt's rattle; it spins down when let go.
// - clunk(i): a part landing on the belt: a soft drop, a metal knock with an inharmonic ring,
//   and a short pneumatic tick. Each part rings a little higher.
// - thud(): the stamp: a hydraulic push down, the impact, the paper slap, and the plate ringing.
// - chime(): the milestone tune, after the stamp.
// - doors(close): compressor hiss, servo whine and rollers while closing, a heavy slam with a
//   ringing clang, the latches, and the pressure bleeding off.
// - unlatch(): the latches let go and the doors roll open.
// - deny(): the terminal's two-tone refusal buzzer.
// - churn(dur) and printer(dur): the AWESOME Sink swallowing a game, and its coupon printing.
import vellum from "/__vellum/sdk.js";

let ctx = null;
let master = null;
let wet = null;
let noiseBuf = null;

function audio() {
  if (vellum.skin.options.sounds === false) return null;
  try {
    if (!ctx) {
      ctx = new AudioContext();
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -12;
      comp.ratio.value = 5;
      comp.connect(ctx.destination);
      master = ctx.createGain();
      master.gain.value = 0.7;
      master.connect(comp);
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      // The hall: a stereo impulse of decaying noise, darker as it fades.
      const len = Math.floor(ctx.sampleRate * 1.6);
      const ir = ctx.createBuffer(2, len, ctx.sampleRate);
      for (let c = 0; c < 2; c++) {
        const ch = ir.getChannelData(c);
        let lp = 0;
        for (let i = 0; i < len; i++) {
          const k = i / len;
          lp += (Math.random() * 2 - 1 - lp) * (0.5 - 0.42 * k);
          ch[i] = lp * Math.pow(1 - k, 2.6);
        }
      }
      const verb = ctx.createConvolver();
      verb.buffer = ir;
      wet = ctx.createGain();
      wet.gain.value = 0.32;
      wet.connect(verb).connect(comp);
    }
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null; // no audio device
  }
}

/** A gain stage into the dry mix and the hall. */
function out(a, level, t, attack = 0.002) {
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(level, t + attack);
  g.connect(master);
  g.connect(wet);
  return g;
}

function decay(g, t, dur) {
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
}

function noise(a, t, dur, type, freq, level, q = 0.8, attack = 0.002) {
  const n = a.createBufferSource();
  n.buffer = noiseBuf;
  n.loop = true;
  n.loopStart = Math.random();
  const f = a.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, t);
  f.Q.value = q;
  const g = out(a, level, t, attack);
  decay(g, t, dur);
  n.connect(f).connect(g);
  n.start(t, Math.random());
  n.stop(t + dur + 0.05);
  return { f, g };
}

function tone(a, t, type, from, to, dur, level, attack = 0.002) {
  const o = a.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(from, t);
  if (to !== from) o.frequency.exponentialRampToValueAtTime(to, t + dur);
  const g = out(a, level, t, attack);
  decay(g, t, dur);
  o.connect(g);
  o.start(t);
  o.stop(t + dur + 0.05);
  return { o, g };
}

/** Struck steel: a few inharmonic partials, the higher ones dying first. */
function ring(a, t, base, dur, level) {
  const partials = [1, 2.76, 5.4, 8.93];
  partials.forEach((p, i) => tone(a, t, "sine", base * p, base * p * 0.995, dur / (1 + i * 0.8), level / (1 + i * 1.4)));
}

// ---- holding ------------------------------------------------------------------------------

/** The conveyor while Submit is held. `set(progress)` raises its pitch; `stop()` spins it down. */
export function belt() {
  const a = audio();
  if (!a) return { set() {}, stop() {} };
  const t = a.currentTime;
  const motor = a.createOscillator();
  motor.type = "sawtooth";
  motor.frequency.setValueAtTime(42, t);
  const motorF = a.createBiquadFilter();
  motorF.type = "lowpass";
  motorF.frequency.value = 320;
  const whine = a.createOscillator();
  whine.type = "triangle";
  whine.frequency.setValueAtTime(380, t);
  const whineG = a.createGain();
  whineG.gain.value = 0.18;
  // The belt's rattle: noise chopped by a fast square wave, as rollers pass under it.
  const rattle = a.createBufferSource();
  rattle.buffer = noiseBuf;
  rattle.loop = true;
  const rattleF = a.createBiquadFilter();
  rattleF.type = "bandpass";
  rattleF.frequency.value = 2200;
  rattleF.Q.value = 1.2;
  const chop = a.createGain();
  chop.gain.value = 0;
  const lfo = a.createOscillator();
  lfo.type = "square";
  lfo.frequency.setValueAtTime(9, t);
  const lfoG = a.createGain();
  lfoG.gain.value = 0.5;
  const bias = a.createConstantSource();
  bias.offset.value = 0.5;
  lfo.connect(lfoG).connect(chop.gain);
  bias.connect(chop.gain);
  const rattleG = a.createGain();
  rattleG.gain.value = 0.07;

  const g = out(a, 0.22, t, 0.12);
  motor.connect(motorF).connect(g);
  whine.connect(whineG).connect(g);
  rattle.connect(rattleF).connect(chop).connect(rattleG).connect(g);
  for (const s of [motor, whine, rattle, lfo, bias]) s.start(t);

  let stopped = false;
  return {
    set(p) {
      if (stopped) return;
      const now = a.currentTime;
      motor.frequency.setTargetAtTime(42 + p * 34, now, 0.05);
      whine.frequency.setTargetAtTime(380 + p * 520, now, 0.05);
      lfo.frequency.setTargetAtTime(9 + p * 14, now, 0.05);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      const now = a.currentTime;
      motor.frequency.setTargetAtTime(24, now, 0.12);
      whine.frequency.setTargetAtTime(160, now, 0.12);
      lfo.frequency.setTargetAtTime(3, now, 0.12);
      g.gain.cancelScheduledValues(now);
      g.gain.setTargetAtTime(0.0001, now, 0.09);
      for (const s of [motor, whine, rattle, lfo, bias]) s.stop(now + 0.6);
    },
  };
}

/** A part lands on the belt. */
export function clunk(i = 0) {
  const a = audio();
  if (!a) return;
  const t = a.currentTime;
  noise(a, t, 0.05, "lowpass", 500, 0.25); // the drop
  tone(a, t + 0.012, "sine", 150 + i * 14, 70, 0.12, 0.5); // the body of the knock
  ring(a, t + 0.012, 620 + i * 85, 0.35, 0.09); // the steel
  noise(a, t + 0.012, 0.03, "highpass", 3800, 0.18); // the edge of the impact
  noise(a, t + 0.07, 0.04, "bandpass", 5200, 0.06, 4); // the belt clip's tick
}

// ---- the stamp ----------------------------------------------------------------------------

export function thud() {
  const a = audio();
  if (!a) return;
  const t = a.currentTime;
  const down = noise(a, t, 0.09, "bandpass", 700, 0.12, 1.5, 0.05); // hydraulic push
  down.f.frequency.exponentialRampToValueAtTime(260, t + 0.08);
  const hit = t + 0.06;
  tone(a, hit, "sine", 110, 34, 0.45, 1.0); // the impact
  tone(a, hit, "triangle", 70, 40, 0.25, 0.35);
  noise(a, hit, 0.14, "lowpass", 1200, 0.55); // the slap
  noise(a, hit, 0.06, "bandpass", 2400, 0.35, 2); // paper
  ring(a, hit, 240, 0.9, 0.12); // the plate under it
  noise(a, hit + 0.22, 0.25, "highpass", 3000, 0.04, 0.7, 0.03); // the press lifting off
}

/** The milestone tune: a rising three-note chime on a bell-like voice. */
export function chime() {
  const a = audio();
  if (!a) return;
  const t = a.currentTime + 0.25;
  [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
    const at = t + i * 0.11;
    tone(a, at, "triangle", f, f, i === 3 ? 0.9 : 0.45, 0.14);
    tone(a, at, "sine", f * 2.01, f * 2.01, 0.3, 0.04);
  });
}

// ---- the doors ----------------------------------------------------------------------------

/** The blast doors closing over `close` seconds. */
export function doors(close) {
  const a = audio();
  if (!a) return;
  const t = a.currentTime;
  const end = t + close;
  // The compressor's hiss, narrowing as the pressure drops.
  const hiss = noise(a, t, close + 0.1, "highpass", 4200, 0.16, 0.7, 0.04);
  hiss.f.frequency.exponentialRampToValueAtTime(1500, end);
  // Servo whine, climbing as the doors speed up.
  tone(a, t, "sawtooth", 140, 330, close, 0.05, 0.08);
  // Rollers in the track.
  const roll = noise(a, t, close, "lowpass", 180, 0.3, 1, 0.1);
  roll.f.frequency.exponentialRampToValueAtTime(420, end);
  // The slam: a boom, the clang of two steel edges, and the hall answering.
  tone(a, end, "sine", 85, 30, 0.7, 1.1);
  noise(a, end, 0.3, "lowpass", 800, 0.8);
  ring(a, end, 180, 1.4, 0.22);
  ring(a, end + 0.004, 263, 1.1, 0.12);
  // The latches, then the pressure bleeding off.
  noise(a, end + 0.24, 0.03, "bandpass", 2600, 0.3, 3);
  tone(a, end + 0.24, "square", 300, 180, 0.04, 0.06);
  noise(a, end + 0.34, 0.03, "bandpass", 2300, 0.3, 3);
  tone(a, end + 0.34, "square", 280, 170, 0.04, 0.06);
  noise(a, end + 0.45, 0.6, "highpass", 5000, 0.08, 0.7, 0.02);
}

/** The latches let go and the doors roll open. */
export function unlatch(open = 0.5) {
  const a = audio();
  if (!a) return;
  const t = a.currentTime;
  noise(a, t, 0.03, "bandpass", 2400, 0.25, 3);
  noise(a, t + 0.07, 0.03, "bandpass", 2100, 0.25, 3);
  noise(a, t + 0.1, 0.2, "highpass", 3500, 0.1, 0.7, 0.01);
  tone(a, t + 0.1, "sawtooth", 300, 150, open, 0.04, 0.05);
  const roll = noise(a, t + 0.1, open, "lowpass", 380, 0.24, 1, 0.08);
  roll.f.frequency.exponentialRampToValueAtTime(160, t + 0.1 + open);
  tone(a, t + 0.1 + open, "sine", 70, 45, 0.25, 0.35);
}

// ---- refusal ------------------------------------------------------------------------------

/** A tap that wasn't a hold: the terminal's two-tone buzzer. */
export function deny() {
  const a = audio();
  if (!a) return;
  const t = a.currentTime;
  for (const [at, f] of [
    [0, 220],
    [0.11, 165],
  ]) {
    tone(a, t + at, "square", f, f, 0.09, 0.06, 0.004);
    tone(a, t + at, "sawtooth", f * 1.01, f * 1.01, 0.09, 0.03, 0.004);
  }
}

// ---- the AWESOME Sink -----------------------------------------------------------------------

/** The Sink swallowing something over `dur` seconds: a churning rumble, a swirl and a grind. */
export function churn(dur = 0.9) {
  const a = audio();
  if (!a) return;
  const t = a.currentTime;
  const end = t + dur;
  // The rumble, its filter swept by a slow wobble as the vortex turns.
  const r = noise(a, t, dur + 0.25, "lowpass", 160, 0.45, 2, 0.08);
  const wob = a.createOscillator();
  wob.frequency.setValueAtTime(3, t);
  wob.frequency.linearRampToValueAtTime(7, end);
  const wobG = a.createGain();
  wobG.gain.value = 90;
  wob.connect(wobG).connect(r.f.frequency);
  wob.start(t);
  wob.stop(end + 0.3);
  // The swirl: a resonant whoosh climbing as it goes down.
  const s = noise(a, t, dur, "bandpass", 300, 0.14, 6, 0.1);
  s.f.frequency.exponentialRampToValueAtTime(1600, end);
  // The grind of the shredders, and a low tone sinking.
  tone(a, t, "sawtooth", 55, 38, dur, 0.06, 0.1);
  for (let i = 0; i < 6; i++) noise(a, t + 0.1 + i * (dur / 7), 0.05, "bandpass", 900 + Math.random() * 900, 0.08, 3);
  // The counter's wheels clicking over.
  for (let i = 0; i < 14; i++) noise(a, t + (i / 14) * dur, 0.012, "highpass", 6000, 0.05);
  tone(a, end, "sine", 90, 50, 0.3, 0.3);
}

/** The coupon printing over `dur` seconds: dot-matrix chatter, the paper feed, and the tear. */
export function printer(dur = 0.7) {
  const a = audio();
  if (!a) return;
  const t = a.currentTime;
  const lines = 5;
  for (let l = 0; l < lines; l++) {
    const at = t + (l / lines) * (dur - 0.15);
    const pins = 7 + Math.floor(Math.random() * 5);
    for (let p = 0; p < pins; p++) noise(a, at + p * 0.011, 0.008, "bandpass", 3200 + Math.random() * 1400, 0.09, 5);
    tone(a, at + pins * 0.011, "square", 120, 110, 0.03, 0.03); // the line feed
  }
  noise(a, t, dur, "bandpass", 700, 0.03, 1, 0.05); // the paper sliding out
  const tear = noise(a, t + dur, 0.14, "highpass", 2000, 0.16, 0.7, 0.01);
  tear.f.frequency.exponentialRampToValueAtTime(5000, t + dur + 0.14);
}
