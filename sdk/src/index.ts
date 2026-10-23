// The skin SDK, served to every skin at /__vellum/sdk.js and exposed as `window.vellum`.
// Importing it also defines the kit components and the built-in views.
//
//   import vellum from "/__vellum/sdk.js";
//   await vellum.ready();

import { hello, vellum as core } from "./core";
import { installDefaults } from "./defaults";
import { guardWindowControls } from "./kit/app";
import "./kit/controls";
import "./kit/grid";
import "./kit/items";
import "./kit/list";
import "./kit/shelf";
import { createMusic, type MusicConfig } from "./music";
import { builtinView } from "./views/registry";

export type { Vellum, ViewImpl } from "./core";
export type { NavEvent } from "./input";
export type { BeforeLaunch } from "./hooks";
export type { Group } from "./query";
export type { Music, MusicConfig, MusicScene } from "./music";
export type * from "./types";
export { fold, matches, query, sortEntries, groupEntries } from "./query";
export { placeholderSvg } from "./placeholder";

let lastFocused = true;
let lastView = "";
const music = createMusic({
  audio: core._internal.audio,
  onAudio: core._internal.onAudio,
  onLaunched: core._internal.onLaunched,
  focused: () => core._internal.windowInfo().focused ?? true,
  onFocus: (cb) =>
    core.window.on("change", (w) => {
      const f = w.focused ?? true;
      if (f !== lastFocused) cb((lastFocused = f));
    }),
  view: () => core.state.get().view,
  onView: (cb) =>
    core.state.on("change", (s) => {
      if (s.view !== lastView) cb((lastView = s.view));
    }),
  url: (path) => core.skin.assetUrl(path),
});

/** The SDK object; also `window.vellum`. */
export const vellum = Object.assign(core, {
  views: Object.assign(core.views, {
    /** A built-in view's implementation, for skins that wrap or extend one. */
    builtin: builtinView,
  }),
  /** Adaptive MIDI music from the skin's SoundFont and MIDI files. */
  music,
});

/**
 * A skin that declares `skin.music` in plugin.json gets it configured without code. Otherwise
 * the user's music folder applies: a SoundFont and a MIDI file per view, named after the view
 * (covers.mid, spotlight.mid, garage.mid...). Views without a file are silent.
 */
async function configureMusic() {
  await core.ready();
  lastView = core.state.get().view;
  try {
    const r = await fetch(core.skin.assetUrl("plugin.json"));
    const manifest = r.ok ? ((await r.json()) as { skin?: { music?: MusicConfig } }) : {};
    if (manifest.skin?.music?.soundbank) return music.configure(manifest.skin.music);
  } catch {
    // No manifest to read (a test page): try the user's folder.
  }
  const user = await userMusic();
  if (user) music.configure(user);
}

/** The user's music folder as a config, or null when it has no SoundFont or no MIDI files. */
async function userMusic(): Promise<MusicConfig | null> {
  let names: string[];
  try {
    const r = await fetch("/__vellum/user-music/index.json");
    names = r.ok ? ((await r.json()) as string[]) : [];
  } catch {
    return null;
  }
  const url = (name: string) => `/__vellum/user-music/${encodeURIComponent(name)}`;
  const bank = names.find((n) => /\.(sf2|sf3|dls)$/i.test(n));
  const scenes: Record<string, string> = {};
  const views: Record<string, string> = {};
  for (const n of names) {
    const m = n.match(/^(.+)\.midi?$/i);
    if (!m) continue;
    const view = m[1].toLowerCase();
    scenes[view] = url(n);
    views[view] = view;
  }
  if (!Object.keys(scenes).length) return null;
  if (!bank) {
    console.info("Vellum music: the music folder has MIDI files but no SoundFont (.sf2, .sf3 or .dls), so nothing plays.");
    return null;
  }
  return { soundbank: url(bank), scenes, views, at: "bar" };
}

declare global {
  interface Window {
    vellum: typeof vellum;
  }
}

installDefaults();
window.vellum = vellum;
hello();
guardWindowControls();
void configureMusic();

export default vellum;
