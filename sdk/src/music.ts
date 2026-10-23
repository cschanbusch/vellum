// `vellum.music`: adaptive MIDI music for skins. A SoundFont and MIDI files from the skin's
// folder, played by the music engine (sdk/src/music/engine.ts, served at /__vellum/music.js and
// loaded only on first use).
//
// Skins describe scenes and layers, in plugin.json (`skin.music`) or with `configure()`, and
// move between scenes: the change lands on the next bar (or beat, or loop end) of the playing
// song, with no crossfade. Music pauses when a game launches or Vellum loses focus, and follows
// the user's Music volume (Settings → Sound) times the skin's own `volume()`.

import type { At, Engine, Song } from "./music/engine";
import type { AudioPrefs } from "./protocol";

type Listener = (data: { scene?: string; beat?: number; bar?: number; time: number }) => void;

/** A scene: a MIDI file, and optionally a fixed beat to enter it at (instead of `entry`). */
export interface MusicScene {
  midi: string;
  from?: number;
}

/** `skin.music` in plugin.json, or the argument to `configure()`. */
export interface MusicConfig {
  /** A SoundFont (.sf2, .sf3) or DLS file in the skin folder. */
  soundbank: string;
  /** Named scenes: a MIDI file path, or `{ midi, from }`. */
  scenes?: Record<string, string | MusicScene>;
  /** Named layers: the MIDI channels (0-15) each one fades. */
  layers?: Record<string, number[]>;
  /** A scene per view id; `"*"` for any other view. The music follows the view; a view with
   *  no scene (and no `"*"`) is silent. */
  views?: Record<string, string>;
  /** Where view changes land: "bar" (default), "beat", "end" or "now". */
  at?: At;
  /** The scene to start with when no view mapping applies. */
  start?: string;
  /**
   * Where a new scene enters: "sync" (default) picks up where the playing music is (the same
   * beat for songs of the same length, else the same share of the way through, on a bar line);
   * "start" plays it from the beginning.
   */
  entry?: "sync" | "start";
}

interface Hooks {
  audio: () => AudioPrefs;
  onAudio: (cb: (a: AudioPrefs) => void) => () => void;
  onLaunched: (cb: (id: string) => void) => () => void;
  focused: () => boolean;
  onFocus: (cb: (focused: boolean) => void) => () => void;
  view: () => string;
  onView: (cb: (view: string) => void) => () => void;
  url: (path: string) => string;
}

export function createMusic(hooks: Hooks) {
  let engineP: Promise<Engine> | null = null;
  let config: MusicConfig | null = null;
  let bankP: Promise<void> | null = null;
  const songs = new Map<string, Promise<Song>>();
  const listeners = new Map<string, Set<Listener>>();
  const unhook: (() => void)[] = [];
  let skinLevel = 1;
  let held = false; // paused by Vellum (launch, background)
  let paused = false; // paused by the skin
  let current: string | null = null;

  const engine = () => {
    if (!engineP) {
      engineP = (async () => {
        const url = "/__vellum/music.js";
        const mod = (await import(/* @vite-ignore */ url)) as typeof import("./music/engine");
        const e = await mod.createEngine("/__vellum/music-processor.js");
        // One dispatcher per event; on() adds and removes skin listeners behind it.
        for (const event of ["scene", "bar", "beat", "loop"]) e.on(event, (d) => listeners.get(event)?.forEach((cb) => cb(d)));
        unlock(e);
        level(e);
        return e;
      })();
    }
    return engineP;
  };

  // Browsers start audio only after the user has interacted with the page: at once if they
  // already have, else on the first click or key.
  const unlock = (e: Engine) => {
    if (e.ctx.state === "running") return;
    if (navigator.userActivation?.hasBeenActive && !held && !paused) {
      void e.resume();
      return;
    }
    const go = () => {
      if (!held && !paused) void e.resume();
      removeEventListener("pointerdown", go, true);
      removeEventListener("keydown", go, true);
    };
    addEventListener("pointerdown", go, true);
    addEventListener("keydown", go, true);
  };

  const level = (e: Engine, seconds = 0.25) => e.setLevel(held || paused ? 0 : hooks.audio().music * skinLevel, seconds);

  const fetchBuffer = async (path: string) => {
    const r = await fetch(hooks.url(path));
    if (!r.ok) throw new Error(`music: ${path}: ${r.status}`);
    return r.arrayBuffer();
  };

  const song = (path: string) => {
    if (!songs.has(path)) {
      songs.set(
        path,
        (async () => {
          const [, buf] = await Promise.all([engine(), fetchBuffer(path)]);
          const url = "/__vellum/music.js";
          const mod = (await import(/* @vite-ignore */ url)) as typeof import("./music/engine");
          return mod.compileSong(buf, path);
        })(),
      );
    }
    return songs.get(path)!;
  };

  const bank = () => {
    if (!config) return Promise.reject(new Error("music: no soundbank; call vellum.music.configure() first"));
    if (!bankP) {
      const path = config.soundbank;
      bankP = (async () => {
        const [e, buf] = await Promise.all([engine(), fetchBuffer(path)]);
        await e.loadSoundBank(buf, path);
      })();
    }
    return bankP;
  };

  const resolve = (scene: string): MusicScene => {
    const s = config?.scenes?.[scene];
    if (s) return typeof s === "string" ? { midi: s } : s;
    return { midi: scene }; // a path given directly
  };

  // Hold the music while a game runs or Vellum is in the background.
  const hold = async (on: boolean) => {
    if (held === on) return;
    held = on;
    if (!engineP) return;
    const e = await engineP;
    if (on) {
      level(e, 0.4);
      window.setTimeout(() => held && void e.suspend(), 450);
    } else if (!paused) {
      await e.resume();
      level(e, 0.6);
    }
  };
  // A launch holds the music until Vellum is back in front. If the game never takes the window
  // (it failed, or is still loading in the background), the music comes back after a while.
  let launchTimer = 0;
  unhook.push(
    hooks.onLaunched(() => {
      void hold(true);
      clearTimeout(launchTimer);
      launchTimer = window.setTimeout(() => hooks.focused() && document.visibilityState === "visible" && void hold(false), 15000);
    }),
  );
  unhook.push(hooks.onFocus((f) => void hold(!f)));
  document.addEventListener("visibilitychange", () => void hold(document.visibilityState === "hidden" || !hooks.focused()));
  unhook.push(hooks.onAudio(() => void engineP?.then((e) => level(e))));

  // Music that follows the view.
  const sceneForView = (view: string) => config?.views?.[view] ?? config?.views?.["*"] ?? null;
  const followView = (view: string, at: At | number) => {
    if (!config?.views) return;
    const scene = sceneForView(view);
    if (scene && scene !== current) void api.play(scene, { at });
    else if (!scene && current) void api.stop({ at });
  };
  unhook.push(hooks.onView((view) => followView(view, config?.at ?? "bar")));

  const api = {
    /** Sets the soundbank, scenes, layers and view mapping (plugin.json `skin.music` does this). */
    configure(c: MusicConfig) {
      if (config?.soundbank !== c.soundbank) bankP = null;
      config = c;
      const scene = sceneForView(hooks.view()) ?? c.start;
      if (scene) void api.play(scene, { at: "now" });
    },

    /** Loads the soundbank and songs ahead of time, so the first change is instant. */
    async preload(...scenes: string[]) {
      await bank();
      await Promise.all((scenes.length ? scenes : Object.keys(config?.scenes ?? {})).map((s) => song(resolve(s).midi)));
    },

    /**
     * Plays a scene (or a MIDI path). With music playing, the change lands on the next `at`
     * boundary of the current song: "bar" (default), "beat", "end" (its loop end), "now", or a
     * number of beats (2 = every half bar in 4/4). Resolves with the audio time it starts.
     */
    async play(scene: string, { at = "bar" as At | number } = {}) {
      current = scene;
      const s = resolve(scene);
      const [e, sng] = await Promise.all([engine(), song(s.midi), bank()]);
      if (current !== scene) return null; // superseded while loading
      return e.play(sng, scene, at, s.from ?? (config?.entry === "start" ? 0 : null));
    },

    /** Stops at the next `at` boundary (default "bar"); notes release naturally. */
    async stop({ at = "bar" as At | number } = {}) {
      current = null;
      if (!engineP) return null;
      return (await engineP).stop(at);
    },

    /** Plays a short MIDI over the music, on the next beat (or `at`), on its own channels. */
    async stinger(scene: string, { at = "beat" as At | number } = {}) {
      const [e, sng] = await Promise.all([engine(), song(resolve(scene).midi), bank()]);
      return e.stinger(sng, at);
    },

    /**
     * Fades a layer (named in the config, or a channel list) to `level` (0-1) over `fade`
     * seconds, starting at the next `at` boundary ("now" by default).
     */
    async layer(name: string | number[], level = 1, { at = "now" as At | number, fade = 0.5 } = {}) {
      const channels = Array.isArray(name) ? name : (config?.layers?.[name] ?? []);
      const e = await engine();
      e.fadeChannels(channels, level, e.boundary(at), fade);
    },

    /** Playback speed, 0.25-4 (1 = the files' own tempo). */
    async tempo(rate: number) {
      (await engine()).setRate(rate);
    },

    /** The skin's own music level, 0-1, multiplied by the user's Music volume. */
    async volume(v: number) {
      skinLevel = Math.max(0, Math.min(1, v));
      if (engineP) level(await engineP);
    },

    async pause() {
      paused = true;
      if (!engineP) return;
      const e = await engineP;
      level(e, 0.3);
      window.setTimeout(() => paused && void e.suspend(), 350);
    },

    async resume() {
      paused = false;
      if (!engineP || held) return;
      const e = await engineP;
      await e.resume();
      level(e, 0.4);
    },

    /** "scene", "bar", "beat" or "loop", called on the beat (as the audio is heard). */
    on(event: "scene" | "bar" | "beat" | "loop", cb: Listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(cb);
      return () => void listeners.get(event)?.delete(cb);
    },

    /** The scene playing, the beat and bar in it, and the synth's sounding voices. */
    async position() {
      if (!engineP) return { scene: null, beat: 0, bar: 0, voices: 0, state: "closed" as AudioContextState };
      return (await engineP).position();
    },
  };
  return api;
}

export type Music = ReturnType<typeof createMusic>;
