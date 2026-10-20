// Built-in List view: dense, sortable rows for fast scanning and launching.
// Written against the public view contract, so skins can read it as an example.

import type { ViewImpl, Vellum } from "../core";
import type { VellumList } from "../kit/list";
import type { UiState } from "../types";

let api: Vellum;
let list: VellumList | null = null;
let empty: HTMLElement | null = null;
let unsub: (() => void) | null = null;
let lastKey = "";

function render() {
  if (!list || !empty) return;
  const entries = api.library.query();
  list.entries = entries;
  list.hidden = entries.length === 0;
  empty.hidden = entries.length > 0;
}

const view: ViewImpl = {
  mount(el, vellum) {
    api = vellum;
    list = document.createElement("vellum-list") as VellumList;
    list.activate = "launch"; // Enter launches; double-click always does
    list.setAttribute("data-vellum-focus-default", "");
    empty = document.createElement("vellum-empty");
    el.append(list, empty);
    lastKey = JSON.stringify([vellum.state.get().query, vellum.state.get().filters, vellum.state.get().sort]);
    render();
    unsub = vellum.library.on("change", render);
  },

  onState(s: UiState) {
    // Only the query matters here; the list follows the selection itself.
    const key = JSON.stringify([s.query, s.filters, s.sort]);
    if (key === lastKey) return;
    lastKey = key;
    render();
  },

  unmount() {
    unsub?.();
    list = empty = null;
  },
};

export default view;
