// Built-in Covers view: a virtualized cover grid, or one shelf per group when Group by is set.
// Confirm (Enter / A) opens Spotlight on the cover; double-click launches.

import type { ViewImpl, Vellum } from "../core";
import type { VellumGrid } from "../kit/grid";
import type { VellumShelf } from "../kit/shelf";
import type { UiState } from "../types";

let api: Vellum;
let body: HTMLElement | null = null;
let unsubs: (() => void)[] = [];
let lastKey = "";

function queryKey(s: UiState) {
  return JSON.stringify([s.query, s.filters, s.sort, s.groupBy]);
}

function render() {
  if (!body) return;
  const s = api.state.get();
  const entries = api.library.query();
  if (!entries.length) {
    if (!body.querySelector("vellum-empty")) body.replaceChildren(document.createElement("vellum-empty"));
    return;
  }

  if (!s.groupBy) {
    let grid = body.querySelector<VellumGrid>(":scope > vellum-grid");
    if (!grid) {
      grid = document.createElement("vellum-grid") as VellumGrid;
      grid.activate = "details";
      grid.setAttribute("data-vellum-focus-default", "");
      body.replaceChildren(grid);
    }
    grid.entries = entries;
    return;
  }

  // Shelves: reuse elements by group key so expanding one doesn't rebuild the rest.
  let shelves = body.querySelector<HTMLElement>(":scope > .v-shelves");
  if (!shelves) {
    shelves = document.createElement("div");
    shelves.className = "v-shelves";
    body.replaceChildren(shelves);
  }
  const existing = new Map<string, VellumShelf>();
  for (const el of shelves.querySelectorAll<VellumShelf>(":scope > vellum-shelf")) existing.set(el.group.key, el);
  const collapsed = new Set(api.shelves.prefs().collapsed);
  const next = api.library.groups().map((g, i) => {
    const el = existing.get(g.key) ?? (document.createElement("vellum-shelf") as VellumShelf);
    el.group = g;
    el.by = s.groupBy!;
    el.collapsed = collapsed.has(g.key);
    if (i === 0) el.setAttribute("data-vellum-focus-default", "");
    else el.removeAttribute("data-vellum-focus-default");
    return el;
  });
  shelves.replaceChildren(...next);
}

const view: ViewImpl = {
  mount(el, vellum) {
    api = vellum;
    const bar = document.createElement("div");
    bar.className = "v-view-bar";
    bar.append(document.createElement("vellum-group-menu"));
    body = document.createElement("div");
    body.className = "v-view-body";
    el.append(bar, body);
    lastKey = queryKey(vellum.state.get());
    render();
    unsubs = [vellum.library.on("change", render), vellum.shelves.on("change", render)];
  },

  onState(s) {
    const key = queryKey(s);
    if (key === lastKey) return;
    lastKey = key;
    render();
  },

  unmount() {
    unsubs.forEach((u) => u());
    unsubs = [];
    body = null;
  },
};

export default view;
