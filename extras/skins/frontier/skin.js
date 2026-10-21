// Frontier: campfire embers, and button prompts that follow the current view.
import vellum from "/__vellum/sdk.js";

// ---- embers --------------------------------------------------------------------------------

function rng(seed) {
  let a = seed;
  return () => {
    a = (a * 1664525 + 1013904223) >>> 0;
    return a / 4294967296;
  };
}

const r = rng(1899);
const embers = document.createDocumentFragment();
for (let i = 0; i < 28; i++) {
  const e = document.createElement("span");
  e.style.cssText = `--x:${r() * 100}%; --size:${1.5 + r() * 3}px; --dur:${7 + r() * 9}s; --delay:${-r() * 16}s; --sway:${(r() - 0.5) * 140}px`;
  embers.append(e);
}
document.querySelector(".fr-embers").append(embers);

// ---- button prompts ------------------------------------------------------------------------

/** What each view's main buttons do, as [key, action] pairs. */
const PROMPTS = {
  list: [
    ["Enter", "Play"],
    ["↑↓", "Browse"],
    ["Ctrl F", "Search"],
    ["Ctrl D", "Favorite"],
    ["Menu", "Options"],
  ],
  covers: [
    ["Enter", "Inspect"],
    ["Dbl-click", "Play"],
    ["Ctrl F", "Search"],
    ["Ctrl D", "Favorite"],
    ["Menu", "Options"],
  ],
  catalogue: [
    ["Enter", "Order"],
    ["←→", "Turn page"],
    ["PgUp PgDn", "Department"],
    ["Esc", "Contents"],
    ["Ctrl D", "Want list"],
  ],
  spotlight: [
    ["Enter", "Play"],
    ["←→", "Browse"],
    ["Ctrl D", "Favorite"],
    ["Menu", "Options"],
    ["Esc", "Back"],
  ],
};
const FALLBACK = [
  ["Enter", "Select"],
  ["Ctrl F", "Search"],
  ["Esc", "Back"],
];

const bar = document.querySelector(".fr-prompts");
let shownFor = "";

function renderPrompts() {
  const view = vellum.state.get().view;
  const show = vellum.skin.options.prompts !== false;
  bar.hidden = !show;
  if (!show || view === shownFor) return;
  shownFor = view;
  const items = [...(PROMPTS[view] ?? FALLBACK), ["Ctrl ,", "Settings"]];
  bar.replaceChildren(
    ...items.map(([key, action]) => {
      const p = document.createElement("span");
      p.className = "fr-prompt";
      const k = document.createElement("kbd");
      k.textContent = key;
      const a = document.createElement("span");
      a.textContent = action;
      p.append(k, a);
      return p;
    }),
  );
}

function applyOptions() {
  const o = vellum.skin.options;
  document.documentElement.toggleAttribute("data-fr-still", o.atmosphere === false);
  shownFor = "";
  renderPrompts();
}

await vellum.ready();
applyOptions();
vellum.state.on("change", renderPrompts);
vellum.skin.on("options", applyOptions);
