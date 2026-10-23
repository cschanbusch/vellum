// Grand Tour: the help bar for each view, a flash between views, the title screen and the menu
// sounds.
import vellum from "/__vellum/sdk.js";
import { installIgnition } from "./ignition.js";
import { installMenuSounds } from "./menu-sounds.js";
import { notePlaytime } from "./condition.js";
import { ui } from "./sound.js";

// Still mode (the Motion option, and Windows' reduced motion) is switched off for now: with it,
// Spotlight's information and the Garage's spec card disappeared (docs/open-issues.md). The
// still-mode styles and code stay, keyed to data-rl-still, which is now never set.
const moving = () => true;

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

// ---- flash between views -----------------------------------------------------------------------

const wipe = document.querySelector(".rl-wipe");
let lastView = "";
let flashes = 0;
/** Views that said they're still getting ready ("rl-view-busy"), until "rl-view-ready". */
const busy = new Set();
addEventListener("rl-view-busy", (e) => busy.add(e.detail.view));
addEventListener("rl-view-ready", (e) => busy.delete(e.detail.view));

/**
 * Flashes the screen for a change of view: on at once, held until the new view is mounted and
 * ready (a view with work to do says so with rl-view-busy / rl-view-ready, like the Garage), and
 * never longer than MAX_HOLD; then it fades.
 */
const MIN_HOLD = 90;
const MAX_HOLD = 1600;
function flash(view) {
  const n = ++flashes;
  const t0 = performance.now();
  wipe.classList.remove("fade");
  wipe.classList.add("on");
  const check = () => {
    if (n !== flashes) return; // a newer change of view took over
    const held = performance.now() - t0;
    const ready = !!document.querySelector(`.v-view[data-view="${CSS.escape(view)}"]`) && !busy.has(view);
    if ((ready && held >= MIN_HOLD) || held >= MAX_HOLD) {
      // One more frame, so the new view has painted under the flash.
      requestAnimationFrame(() => {
        if (n !== flashes) return;
        wipe.classList.remove("on");
        wipe.classList.add("fade");
      });
    } else requestAnimationFrame(check);
  };
  requestAnimationFrame(check);
}

function onState(s) {
  if (lastView && s.view !== lastView && moving()) flash(s.view);
  lastView = s.view;
  renderHelp();
}

// ---- title screen ------------------------------------------------------------------------------

/** The music (music/ in this skin, if it has any) waits for the title screen. */
const startMusic = () => vellum.music.start();

/** Once per session: a wipe, the chrome wordmark with a glint, and a blinking prompt. It waits
 *  for any key, click or controller button, and that press only dismisses it. The music starts
 *  once it has gone (or at once, without a title screen). */
function boot() {
  const el = document.querySelector(".rl-boot");
  let seen = false;
  try {
    seen = sessionStorage.getItem("rl-boot") === "1";
    sessionStorage.setItem("rl-boot", "1");
  } catch {
    // Storage blocked: show it every time.
  }
  if (seen || vellum.skin.options.boot === false || !moving()) return startMusic();
  el.hidden = false;
  let unNav = () => {};
  const done = () => {
    if (el.classList.contains("out")) return;
    ui("start"); // a key, click or button lets audio play: the title chord
    el.classList.add("out");
    setTimeout(() => {
      el.hidden = true;
      startMusic();
    }, 400);
    removeEventListener("keydown", onKey, true);
    removeEventListener("pointerdown", onPointer, true);
    unNav();
  };
  const onKey = (e) => {
    // Modifier keys alone don't count; the press goes no further.
    if (["Control", "Alt", "Meta", "OS"].includes(e.key)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    done();
  };
  const onPointer = (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    done();
  };
  addEventListener("keydown", onKey, true);
  addEventListener("pointerdown", onPointer, true);
  // Controller buttons arrive from the shell as nav events.
  unNav = vellum.input.on("nav", (e) => {
    e.preventDefault();
    done();
  });
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
// Build the Garage in the background (its code, the 3D library, the case catalogue, the print
// worker and the turntables with their shaders compiled), so even the first switch is instant.
const warm = () => {
  import("./views/garage.js")
    .then((m) => m.prewarm(vellum))
    .catch((err) => console.warn("Grand Tour: Garage warm-up", err));
};
if ("requestIdleCallback" in window) requestIdleCallback(warm, { timeout: 4000 });
else setTimeout(warm, 2000);
vellum.state.on("change", onState);
vellum.skin.on("options", applyOptions);
