// Grand Tourer's menu sounds: which input makes which sound (the sounds are in sound.js).
//
// Keyboard and controller steps tick when they move the cursor (the selection or focus changed)
// and knock softly when they hit an edge. Confirm and Back chime up and down, a mode change
// swooshes, and Favorite sparkles. With the mouse, picking a game ticks and pressing a button
// chimes. Only listens; never takes an input away from the views.
import vellum from "/__vellum/sdk.js";
import { ui } from "./sound.js";

const STEPS = new Set(["up", "down", "left", "right", "pageUp", "pageDown"]);
// Collections select on click; their selection tick is enough.
const COLLECTIONS = new Set(["VELLUM-GRID", "VELLUM-LIST", "VELLUM-SHELF"]);
const PRESSABLE = 'button, a[href], [role="button"], [role="tab"], [role="menuitem"], summary, input[type="checkbox"], vellum-play-button';

/** The focused element, looking into shadow roots. */
function deepActive() {
  let a = document.activeElement;
  while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
  return a;
}

const frames = (n) => new Promise((r) => (n ? requestAnimationFrame(() => frames(n - 1).then(r)) : r()));

let stepping = 0; // steps whose outcome is still being checked
let view = "";
let selected = null;

export function installMenuSounds() {
  vellum.input.on("nav", (e) => {
    if (STEPS.has(e.name)) {
      const sel = vellum.state.get().selectedId;
      const focus = deepActive();
      stepping++;
      // Views move synchronously or within a frame; two frames settle it either way.
      void frames(2).then(() => {
        stepping--;
        const moved = vellum.state.get().selectedId !== sel || deepActive() !== focus;
        ui(moved ? "move" : "bump", e.name);
      });
    } else if (e.name === "confirm") ui("select");
    else if (e.name === "back") ui("back");
    else if (e.name === "favorite") ui("favorite");
    else if (e.name === "menu") ui("open");
  });

  const s = vellum.state.get();
  view = s.view;
  selected = s.selectedId;
  vellum.state.on("change", (s) => {
    if (s.view !== view) {
      view = s.view;
      ui("view");
    }
    // A selection that changed without a step: the mouse, or search.
    if (s.selectedId !== selected) {
      selected = s.selectedId;
      if (!stepping && s.selectedId) ui("move");
    }
  });

  document.addEventListener(
    "click",
    (e) => {
      if (!e.isTrusted) return; // confirm already chimed for keyboard presses
      const path = e.composedPath();
      if (path.some((n) => COLLECTIONS.has(n.tagName))) return;
      if (path.some((n) => n instanceof Element && n.matches(PRESSABLE))) ui("select");
    },
    true,
  );
}
