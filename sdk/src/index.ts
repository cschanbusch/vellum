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
import { builtinView } from "./views/registry";

export type { Vellum, ViewImpl } from "./core";
export type { NavEvent } from "./input";
export type { Group } from "./query";
export type * from "./types";
export { fold, matches, query, sortEntries, groupEntries } from "./query";
export { placeholderSvg } from "./placeholder";

/** The SDK object; also `window.vellum`. */
export const vellum = Object.assign(core, {
  views: Object.assign(core.views, {
    /** A built-in view's implementation, for skins that wrap or extend one. */
    builtin: builtinView,
  }),
});

declare global {
  interface Window {
    vellum: typeof vellum;
  }
}

installDefaults();
window.vellum = vellum;
hello();
guardWindowControls();

export default vellum;
