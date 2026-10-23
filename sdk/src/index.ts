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
 * A skin that declares `skin.music` in plugin.json gets it configured without code. With
 * `folder`, the folder in the skin is read for its SoundFont (the first .sf2, .sf3 or .dls) and a
 * MIDI file per view, named after the view (covers.mid, garage.mid...); views without one are
 * silent. Fields given explicitly win over what the folder provides.
 */
async function configureMusic() {
  await core.ready();
  lastView = core.state.get().view;
  let declared: MusicConfig | undefined;
  try {
    const r = await fetch(core.skin.assetUrl("plugin.json"));
    if (r.ok) declared = ((await r.json()) as { skin?: { music?: MusicConfig } }).skin?.music;
  } catch {
    return; // no manifest to read (a test page): music stays off until configured
  }
  if (!declared) return;
  const found = declared.folder ? await musicFolder(declared.folder) : {};
  const c: MusicConfig = {
    ...declared,
    soundbank: declared.soundbank ?? found.soundbank ?? "",
    scenes: { ...found.scenes, ...declared.scenes },
    views: declared.views || found.views ? { ...found.views, ...declared.views } : undefined,
  };
  if (!c.soundbank) {
    if (Object.keys(c.scenes ?? {}).length) console.info(`Vellum music: no SoundFont (.sf2, .sf3 or .dls) in ${declared.folder ?? "the skin"}, so nothing plays.`);
    return;
  }
  music.configure(c);
}

/** What a skin's music folder offers: its SoundFont, and a scene per view-named MIDI file. */
async function musicFolder(folder: string): Promise<Partial<MusicConfig>> {
  let names: string[] = [];
  try {
    const r = await fetch(`/__vellum/skin-files/${folder.replace(/^\/+|\/+$/g, "")}`);
    if (r.ok) names = (await r.json()) as string[];
  } catch {
    return {};
  }
  const path = (name: string) => `${folder.replace(/\/+$/, "")}/${encodeURIComponent(name)}`;
  const bank = names.find((n) => /\.(sf2|sf3|dls)$/i.test(n));
  const scenes: Record<string, string> = {};
  const views: Record<string, string> = {};
  for (const n of names) {
    const m = n.match(/^(.+)\.midi?$/i);
    if (!m) continue;
    const view = m[1].toLowerCase();
    scenes[view] = path(n);
    views[view] = view;
  }
  return { soundbank: bank ? path(bank) : undefined, scenes, views };
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
