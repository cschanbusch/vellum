// Grand Tour: the help bar for each view, a wipe between views, the title screen and the menu
// sounds.
import vellum from "/__vellum/sdk.js";
import { installIgnition } from "./ignition.js";
import { installMenuSounds } from "./menu-sounds.js";
import { notePlaytime } from "./condition.js";
import { ui } from "./sound.js";

const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const moving = () => vellum.skin.options.motion !== false && !reduced.matches;

// ---- help bar ------------------------------------------------------------------------------

/** What each view's main keys do, as [key, action] pairs. */
const HELP = {
  list: [
    ["Enter", "Start"],
    ["↑↓", "Select"],
    ["Ctrl F", "Search"],
    ["Ctrl D", "Favorite"],
  ],
  covers: [
    ["Enter", "Details"],
    ["Arrows", "Select"],
    ["Ctrl F", "Search"],
    ["Ctrl D", "Favorite"],
  ],
  spotlight: [
    ["Enter", "Start"],
    ["←→", "Select"],
    ["Esc", "Back"],
  ],
  garage: [
    ["Enter", "Start"],
    ["←→", "Model"],
    ["↑↓", "Body type"],
    ["S", "Service"],
    ["Ctrl D", "Add to garage"],
  ],
};
const FALLBACK = [
  ["Enter", "Select"],
  ["Esc", "Back"],
];

const bar = document.querySelector(".rl-help");
let shownFor = "";

function renderHelp() {
  const view = vellum.state.get().view;
  if (view === shownFor) return;
  shownFor = view;
  const items = [...(HELP[view] ?? FALLBACK), ["Ctrl Tab", "Mode"], ["Ctrl ,", "Options"]];
  bar.replaceChildren(
    ...items.map(([key, action]) => {
      const p = document.createElement("span");
      p.className = "rl-key";
      const k = document.createElement("kbd");
      k.textContent = key;
      const a = document.createElement("span");
      a.textContent = action;
      p.append(k, a);
      return p;
    }),
  );
}

// ---- wipe between views ------------------------------------------------------------------------

const wipe = document.querySelector(".rl-wipe");
let lastView = "";

function onState(s) {
  if (lastView && s.view !== lastView && moving()) {
    wipe.classList.remove("go");
    void wipe.offsetWidth; // restart the animation
    wipe.classList.add("go");
  }
  lastView = s.view;
  renderHelp();
}
wipe.addEventListener("animationend", () => wipe.classList.remove("go"));

// ---- title screen ------------------------------------------------------------------------------

/** Once per session: a wipe, the chrome wordmark with a glint, and a blinking prompt. Any key or
 *  click skips it, and it never blocks the pointer. */
function boot() {
  const el = document.querySelector(".rl-boot");
  let seen = false;
  try {
    seen = sessionStorage.getItem("rl-boot") === "1";
    sessionStorage.setItem("rl-boot", "1");
  } catch {
    // Storage blocked: show it every time.
  }
  if (seen || vellum.skin.options.boot === false || !moving()) return;
  el.hidden = false;
  const done = (e) => {
    if (el.classList.contains("out")) return;
    // Pressed through (a key or a click lets audio play): the title chord.
    if (e) ui("start");
    el.classList.add("out");
    setTimeout(() => (el.hidden = true), 400);
    removeEventListener("keydown", done, true);
    removeEventListener("pointerdown", done, true);
  };
  addEventListener("keydown", done, true);
  addEventListener("pointerdown", done, true);
  setTimeout(() => done(), 2600);
}

function applyOptions() {
  document.documentElement.toggleAttribute("data-rl-still", !moving());
}

await vellum.ready();
applyOptions();
installIgnition();
installMenuSounds();
// Hours on the clock wear a game too: read the odometers now and whenever the library changes
// (Steam records playtime when a game closes, and Vellum rescans).
notePlaytime(vellum.library.all());
vellum.library.on("change", () => notePlaytime(vellum.library.all()));
boot();
onState(vellum.state.get());
vellum.state.on("change", onState);
vellum.skin.on("options", applyOptions);
reduced.addEventListener("change", applyOptions);
