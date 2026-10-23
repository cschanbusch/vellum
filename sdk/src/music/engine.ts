// Vellum's music engine, served at /__vellum/music.js and loaded only when a skin uses
// `vellum.music` (sdk/src/music.ts). SoundFonts are played by spessasynth (an AudioWorklet
// synth, /__vellum/music-processor.js); the sequencer here is Vellum's own, built for adaptive
// music rather than playing songs one after another:
//
// - Events are scheduled a little ahead on the audio clock, so timing is sample-accurate.
// - A scene change happens on a musical boundary of the playing song (the next beat, the next
//   bar, or the end of its loop): the old song's notes are released there and the new song
//   starts on the same instant. No crossfade, no gap.
// - By default the new song picks up where the old one was: the same beat when their loops are
//   the same length (variations of one piece switch seamlessly), else the same share of the way
//   through, on a bar line. It is brought up to date first: its programs and controllers so far,
//   and the notes that would already be sounding (a held pad) start on the change.
// - Songs loop seamlessly (a file's loop points, or the whole song rounded up to the bar).
// - Layers are channels faded with the synth's per-channel gain; they carry across scenes, so
//   scenes that keep each instrument on the same channel share them.
// - Stingers are short songs played over the music on a second bank of 16 channels, timed to
//   the music's beat or bar.

import { BasicMIDI } from "spessasynth_core";
import { WorkletSynthesizer } from "spessasynth_lib";

/** How far ahead events are sent to the synth, and how often the scheduler runs. */
const LOOKAHEAD = 0.12;
const TICK_MS = 25;
/** Channels 16-31 belong to stingers. */
const STINGER_OFFSET = 16;

export type At = "now" | "beat" | "bar" | "end";

interface Event {
  beat: number;
  /** Status byte (with channel) and data bytes. */
  msg: number[];
  /** Port offset (16 per extra MIDI port). */
  offset: number;
}

export interface Song {
  name: string;
  events: Event[];
  tempos: { beat: number; bpm: number }[];
  meters: { beat: number; num: number; den: number }[];
  loopStart: number;
  loopEnd: number;
  /** Seconds from beat 0 to each tempo change, for fast beat <-> second conversion. */
  tempoSecs: number[];
}

/** Parses a MIDI file into beats, with its tempo map, meter and loop. */
export function compileSong(buffer: ArrayBuffer, name = "song"): Song {
  const midi = BasicMIDI.fromArrayBuffer(buffer, name);
  const ppq = midi.timeDivision;
  const events: Event[] = [];
  const meters: Song["meters"] = [];
  let endTick = 0;
  for (const track of midi.tracks) {
    const offset = midi.portChannelOffsetMap[track.port] ?? 0;
    for (const e of track.events) {
      endTick = Math.max(endTick, e.ticks);
      const s = e.statusByte;
      if (s >= 0x80 && s < 0xf0) events.push({ beat: e.ticks / ppq, msg: [s, ...e.data], offset });
      else if (s === 0x58 && e.data.length >= 2) meters.push({ beat: e.ticks / ppq, num: e.data[0], den: 2 ** e.data[1] });
    }
  }
  events.sort((a, b) => a.beat - b.beat || order(a) - order(b));
  if (!meters.length || meters[0].beat > 0) meters.unshift({ beat: 0, num: 4, den: 4 });
  meters.sort((a, b) => a.beat - b.beat);

  const tempos = [...midi.tempoChanges]
    .map((c) => ({ beat: c.ticks / ppq, bpm: c.tempo }))
    .sort((a, b) => a.beat - b.beat)
    .filter((c, i, all) => i === all.length - 1 || all[i + 1].beat !== c.beat);
  if (!tempos.length || tempos[0].beat > 0) tempos.unshift({ beat: 0, bpm: 120 });

  // The loop: the file's own points, else the whole song rounded up to the bar line.
  const explicit = midi.loop.start > 0 || midi.loop.end < midi.lastVoiceEventTick;
  let loopStart = explicit ? midi.loop.start / ppq : 0;
  let loopEnd = explicit ? midi.loop.end / ppq : Math.max(endTick, midi.lastVoiceEventTick) / ppq;
  if (!explicit) {
    const m = meterAt(meters, loopEnd);
    const bar = (m.num * 4) / m.den;
    loopEnd = m.beat + Math.ceil((loopEnd - m.beat) / bar - 1e-6) * bar;
  }
  if (loopEnd <= loopStart) loopEnd = loopStart + 4;

  const tempoSecs = [0];
  for (let i = 1; i < tempos.length; i++) tempoSecs.push(tempoSecs[i - 1] + ((tempos[i].beat - tempos[i - 1].beat) * 60) / tempos[i - 1].bpm);
  return { name, events, tempos, meters, loopStart, loopEnd, tempoSecs };
}

/** At the same instant: note-offs first, then controllers and programs, then note-ons. */
function order(e: Event) {
  const k = e.msg[0] & 0xf0;
  return k === 0x80 || (k === 0x90 && e.msg[2] === 0) ? 0 : k === 0x90 ? 2 : 1;
}

function meterAt(meters: Song["meters"], beat: number) {
  let m = meters[0];
  for (const x of meters) if (x.beat <= beat) m = x;
  return m;
}

/** Seconds from beat 0 to `beat` (at the song's own tempo). */
function secAt(song: Song, beat: number) {
  let i = 0;
  while (i + 1 < song.tempos.length && song.tempos[i + 1].beat <= beat) i++;
  return song.tempoSecs[i] + ((beat - song.tempos[i].beat) * 60) / song.tempos[i].bpm;
}

/** The beat `sec` seconds into the song. */
function beatAt(song: Song, sec: number) {
  let i = 0;
  while (i + 1 < song.tempos.length && song.tempoSecs[i + 1] <= sec) i++;
  return song.tempos[i].beat + ((sec - song.tempoSecs[i]) * song.tempos[i].bpm) / 60;
}

/** One song playing: where it is anchored on the audio clock and its next event. */
interface Playing {
  song: Song;
  /** Audio time of `anchorBeat` in this pass. */
  anchorTime: number;
  anchorBeat: number;
  idx: number;
  offset: number;
  /** Notes sounding, as "channel:key", so they can be released at a loop or a change. */
  active: Set<string>;
  /** One-shot (a stinger): ends at its loop end instead of wrapping. */
  once: boolean;
  /** Beat of the next beat event to announce (main song only). */
  nextBeat: number;
}

type Listener = (data: { scene?: string; beat?: number; bar?: number; time: number }) => void;

export class Engine {
  readonly ctx: AudioContext;
  private synth!: WorkletSynthesizer;
  private out: GainNode;
  private main: Playing | null = null;
  /** The next scene; `from` null means "where the playing song is" (see entryFor). */
  private pending: { song: Song; time: number; from: number | null; scene: string } | null = null;
  private stopAt: number | null = null;
  private stingers: Playing[] = [];
  private scheduledUntil = 0;
  private rate = 1;
  private scene = "";
  private timer = 0;
  private listeners = new Map<string, Set<Listener>>();
  private fades = new Map<number, number>();
  private gains = new Array<number>(32).fill(1);

  constructor() {
    this.ctx = new AudioContext({ latencyHint: "playback" });
    this.out = this.ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(this.ctx.destination);
  }

  async start(processorUrl: string) {
    await this.ctx.audioWorklet.addModule(processorUrl);
    this.synth = new WorkletSynthesizer(this.ctx);
    this.synth.connect(this.out);
    await this.synth.isReady;
    while (this.synth.channelCount < 32) this.synth.addNewChannel();
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
  }

  async loadSoundBank(buffer: ArrayBuffer, id: string) {
    await this.synth.soundBankManager.addSoundBank(buffer, id);
  }

  // ---- clock -------------------------------------------------------------------------------

  private timeOf(p: Playing, beat: number) {
    return p.anchorTime + (secAt(p.song, beat) - secAt(p.song, p.anchorBeat)) / this.rate;
  }

  private beatOf(p: Playing, time: number) {
    return beatAt(p.song, secAt(p.song, p.anchorBeat) + (time - p.anchorTime) * this.rate);
  }

  /** The audio time of the next `at` boundary of the main song, never before what is already sent. */
  boundary(at: At | number): number {
    const earliest = Math.max(this.ctx.currentTime + 0.03, this.scheduledUntil);
    const p = this.main;
    if (!p || at === "now") return earliest;
    const s = p.song;
    let beat = this.beatOf(p, earliest);
    let target: number;
    if (typeof at === "number") target = Math.ceil(beat / at - 1e-6) * at;
    else if (at === "beat") target = Math.ceil(beat - 1e-6);
    else if (at === "bar") {
      const m = meterAt(s.meters, beat);
      const bar = (m.num * 4) / m.den;
      target = m.beat + Math.ceil((beat - m.beat) / bar - 1e-6) * bar;
    } else target = s.loopEnd;
    // Past the loop's end, the boundary is the loop point itself.
    if (target >= s.loopEnd) target = s.loopEnd;
    beat = Math.max(target, p.anchorBeat);
    return Math.max(earliest, this.timeOf(p, beat));
  }

  // ---- control ------------------------------------------------------------------------------

  /**
   * Starts `song` as the scene at the next `at` boundary (or now, if nothing plays), from beat
   * `from`, or where the playing song is when `from` is null.
   */
  play(song: Song, scene: string, at: At | number = "bar", from: number | null = null): number {
    const time = this.main ? this.boundary(at) : this.ctx.currentTime + 0.05;
    this.pending = { song, time, from, scene };
    this.stopAt = null;
    return time;
  }

  stop(at: At | number = "now"): number {
    const time = this.main ? this.boundary(at) : this.ctx.currentTime;
    this.pending = null;
    this.stopAt = time;
    return time;
  }

  stinger(song: Song, at: At | number = "beat"): number {
    const time = this.boundary(at);
    this.stingers.push({ song, anchorTime: time, anchorBeat: 0, idx: 0, offset: STINGER_OFFSET, active: new Set(), once: true, nextBeat: Infinity });
    return time;
  }

  /** Fades channels' gain to `level` over `fade` seconds, starting at `time`. */
  fadeChannels(channels: number[], level: number, time: number, fade: number) {
    const delay = Math.max(0, (time - this.ctx.currentTime) * 1000);
    for (const ch of channels) {
      clearTimeout(this.fades.get(ch));
      const run = () => {
        const from = this.gains[ch];
        const steps = Math.max(1, Math.round((fade * 1000) / 20));
        let i = 0;
        const step = () => {
          i++;
          this.setGain(ch, from + (level - from) * Math.min(1, i / steps));
          if (i < steps) this.fades.set(ch, window.setTimeout(step, 20));
        };
        step();
      };
      this.fades.set(ch, window.setTimeout(run, delay));
    }
  }

  private setGain(ch: number, g: number) {
    this.gains[ch] = g;
    this.synth.midiChannels[ch]?.setSystemParameter("gain", g);
  }

  setRate(rate: number) {
    // Re-anchor at the current point so the change takes effect without a jump.
    const now = Math.max(this.ctx.currentTime, this.scheduledUntil);
    for (const p of [this.main, ...this.stingers]) {
      if (!p) continue;
      const beat = this.beatOf(p, now);
      p.anchorBeat = beat;
      p.anchorTime = now;
    }
    this.rate = Math.max(0.25, Math.min(4, rate));
  }

  /** Output level, ramped. */
  setLevel(level: number, seconds = 0.25) {
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setValueAtTime(this.out.gain.value, t);
    this.out.gain.linearRampToValueAtTime(Math.max(0, level), t + Math.max(0.01, seconds));
  }

  async suspend() {
    if (this.ctx.state === "running") await this.ctx.suspend();
  }

  async resume() {
    if (this.ctx.state !== "running") await this.ctx.resume();
  }

  on(event: string, cb: Listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(cb);
    return () => void this.listeners.get(event)?.delete(cb);
  }

  /** Calls listeners at `time` on the audio clock. */
  private emitAt(event: string, time: number, data: Omit<Parameters<Listener>[0], "time">) {
    const set = this.listeners.get(event);
    if (!set?.size) return;
    window.setTimeout(() => set.forEach((cb) => cb({ ...data, time })), Math.max(0, (time - this.ctx.currentTime) * 1000));
  }

  /** What is playing: the scene, and where in it. */
  position() {
    const p = this.main;
    if (!p) return { scene: null as string | null, beat: 0, bar: 0, voices: this.synth?.voiceCount ?? 0, state: this.ctx.state };
    const beat = this.beatOf(p, this.ctx.currentTime);
    const m = meterAt(p.song.meters, beat);
    return { scene: this.scene, beat, bar: Math.floor((beat - m.beat) / ((m.num * 4) / m.den)), voices: this.synth.voiceCount, state: this.ctx.state };
  }

  dispose() {
    clearInterval(this.timer);
    for (const t of this.fades.values()) clearTimeout(t);
    void this.ctx.close();
  }

  // ---- scheduling -----------------------------------------------------------------------------

  private send(msg: number[], offset: number, time: number, p: Playing) {
    const k = msg[0] & 0xf0;
    const key = `${(msg[0] & 0x0f) + offset}:${msg[1]}`;
    if (k === 0x90 && msg[2] > 0) p.active.add(key);
    else if (k === 0x80 || k === 0x90) p.active.delete(key);
    this.synth.sendMessage(msg, offset, { time });
  }

  /** Releases every note `p` is sounding, at `time`. */
  private release(p: Playing, time: number) {
    for (const key of p.active) {
      const [ch, note] = key.split(":").map(Number);
      this.synth.noteOff(ch, note, { time });
    }
    p.active.clear();
  }

  /** Releases notes and resets controllers on the main channels before a new song. */
  private handOff(p: Playing | null, time: number) {
    if (p) this.release(p, time);
    for (let ch = 0; ch < 16; ch++) {
      this.synth.controllerChange(ch, 64, 0, { time }); // sustain off
      this.synth.controllerChange(ch, 121, 0, { time }); // reset controllers
    }
  }

  private tick() {
    if (!this.synth || this.ctx.state !== "running") return;
    const horizon = this.ctx.currentTime + LOOKAHEAD;

    if (this.stopAt !== null && this.stopAt <= horizon) {
      if (this.main) {
        this.advance(this.main, this.stopAt, false);
        this.handOff(this.main, this.stopAt);
      }
      this.main = null;
      this.scene = "";
      this.stopAt = null;
    }
    if (this.pending && this.pending.time <= horizon) {
      const { song, time, scene } = this.pending;
      if (this.main) this.advance(this.main, time, false);
      const from = this.pending.from ?? this.entryFor(song, time);
      this.handOff(this.main, time);
      this.pending = null;
      this.scene = scene;
      this.main = { song, anchorTime: time, anchorBeat: from, idx: song.events.findIndex((e) => e.beat >= from), offset: 0, active: new Set(), once: false, nextBeat: Math.ceil(from) };
      if (this.main.idx < 0) this.main.idx = song.events.length;
      this.chase(this.main, from, time);
      this.emitAt("scene", time, { scene, beat: from });
    }
    if (this.main) this.advance(this.main, this.pending ? Math.min(horizon, this.pending.time) : this.stopAt !== null ? Math.min(horizon, this.stopAt) : horizon, true);
    this.stingers = this.stingers.filter((s) => this.advance(s, horizon, true));
    this.scheduledUntil = Math.max(this.scheduledUntil, horizon);
  }

  /**
   * Where `song` should enter when it replaces the playing song at `time`: the same beat if
   * their loops are the same length, else the same share of the way through the loop, rounded
   * to a bar line of the new song. From silence, the start.
   */
  private entryFor(song: Song, time: number): number {
    const p = this.main;
    if (!p) return 0;
    const old = p.song;
    let beat = this.beatOf(p, time);
    if (beat >= old.loopEnd - 1e-6) beat = old.loopStart; // on the loop point
    if (beat < old.loopStart) return beat < song.loopEnd ? beat : song.loopStart; // in an intro
    const into = beat - old.loopStart;
    const oldLen = old.loopEnd - old.loopStart;
    const len = song.loopEnd - song.loopStart;
    if (Math.abs(oldLen - len) < 1e-6) return song.loopStart + into;
    const m = meterAt(song.meters, song.loopStart);
    const bar = (m.num * 4) / m.den;
    let at = Math.round(((into / oldLen) * len) / bar) * bar;
    if (at >= len - 1e-6) at = 0;
    return song.loopStart + at;
  }

  /**
   * Brings a song entered at `from` up to date at `time`: every program, controller and pitch
   * change before `from`, and the notes that would be sounding there.
   */
  private chase(p: Playing, from: number, time: number) {
    if (from <= 0) return;
    const held = new Map<string, Event>();
    for (const e of p.song.events) {
      if (e.beat >= from) break;
      const k = e.msg[0] & 0xf0;
      const key = `${e.offset}:${e.msg[0] & 0x0f}:${e.msg[1]}`;
      if (k === 0x90 && e.msg[2] > 0) held.set(key, e);
      else if (k === 0x80 || k === 0x90) held.delete(key);
      else this.synth.sendMessage(e.msg, e.offset + p.offset, { time });
    }
    for (const e of held.values()) this.send(e.msg, e.offset + p.offset, time, p);
  }

  /**
   * Sends `p`'s events up to (not including) `until`, wrapping at its loop end. Returns false
   * when a one-shot has finished.
   */
  private advance(p: Playing, until: number, announce: boolean): boolean {
    const s = p.song;
    for (let guard = 0; guard < 100000; guard++) {
      // Beats to announce (the main song only).
      if (announce && !p.once) {
        while (p.nextBeat < s.loopEnd && this.timeOf(p, p.nextBeat) < until) {
          const t = this.timeOf(p, p.nextBeat);
          const m = meterAt(s.meters, p.nextBeat);
          const bar = (m.num * 4) / m.den;
          const inBar = (p.nextBeat - m.beat) % bar;
          this.emitAt("beat", t, { beat: p.nextBeat });
          if (Math.abs(inBar) < 1e-6) this.emitAt("bar", t, { bar: Math.round((p.nextBeat - m.beat) / bar) });
          p.nextBeat += 1;
        }
      }
      const e = s.events[p.idx];
      if (!e || e.beat >= s.loopEnd) {
        const end = this.timeOf(p, s.loopEnd);
        if (end >= until) return true;
        this.release(p, end);
        if (p.once) return false;
        // Wrap: the loop start follows the loop end on the same instant.
        p.anchorTime = end;
        p.anchorBeat = s.loopStart;
        p.idx = s.events.findIndex((x) => x.beat >= s.loopStart);
        if (p.idx < 0) p.idx = s.events.length;
        p.nextBeat = Math.ceil(s.loopStart - 1e-9);
        this.emitAt("loop", end, { scene: this.scene });
        continue;
      }
      const t = this.timeOf(p, e.beat);
      if (t >= until) return true;
      this.send(e.msg, e.offset + p.offset, t, p);
      p.idx++;
    }
    return true;
  }
}

/** Creates the engine: an AudioContext, the synth worklet and the scheduler. */
export async function createEngine(processorUrl: string): Promise<Engine> {
  const engine = new Engine();
  await engine.start(processorUrl);
  return engine;
}
