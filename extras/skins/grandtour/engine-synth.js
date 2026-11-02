// Grand Tour's engine, as numbers: the starter cranking, the engine catching and the stall,
// rendered sample by sample from a physical model (sound.js says what each part does). It needs
// no AudioContext, so it runs in engine.worker.js: rendering a second or two of audio on the
// page's thread took ~90 ms, long enough to drop frames. Each function returns [left, right]
// Float32Arrays at `sr`.

/** A default voice, for callers that don't pass one: the cross-plane V8. */
export const V8 = {
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

/** Fill two channels from `gen(t, i) -> [l, r]` at `sr`, then normalise them to `peak`. */
function render(sr, dur, gen, peak = 0.9) {
  const n = Math.ceil(dur * sr);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
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
  return [L, R];
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

/** The compression strokes of a crank lasting `dur` seconds (the tachometer twitches on them). */
export function strokesFor(dur, health = 1, slowing = false, v = V8) {
  const strokes = [];
  const rate0 = (4.2 + health * 2.2) * v.crank.rate; // strokes per second
  let t = 0;
  while (t < dur) {
    strokes.push(t);
    const k = slowing ? 1 - (t / dur) * 0.6 : 1;
    t += 1 / (rate0 * k);
  }
  return strokes;
}

/** The starter cranking for `dur` seconds, over `strokes` (from strokesFor). */
export function crankSamples(sr, dur, health = 1, slowing = false, v = V8, strokes = strokesFor(dur, health, slowing, v)) {
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
  return render(sr, dur + 0.06, (tt, i) => {
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
}

export function fireSamples(sr, health = 1, v = V8) {
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
  return render(sr, dur, (t, i) => {
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

/** A couple of weak coughs as the cranking dies, and the engine rocking back. */
export function stallSamples(sr, voice = V8) {
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
  return render(sr, 1.0, (t, i) => {
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
}
