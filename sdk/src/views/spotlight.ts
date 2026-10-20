// Built-in Spotlight view: one game at a time over hero art. Also the details view
// (`vellum.actions.showDetails`).
//
// The hero fills the stage above the covers, with a scrim behind the text so titles stay
// readable on any art. Below it, either one strip of the current list or, when Group by is
// set, one row per group (like a streaming app) that up/down move between. The covers hold
// focus by default: left/right step through games with a hero crossfade, confirm plays, and
// up from the first row reaches the actions.

import { html, nothing, render as litRender } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { ViewImpl, Vellum } from "../core";
import type { NavContainer } from "../focus";
import type { NavEvent } from "../input";
import { formatSize, formatWhen, releaseYear } from "../kit/shared";
import type { Entry, UiState } from "../types";

let api: Vellum;
let root: HTMLElement | null = null;
let unsubs: (() => void)[] = [];
let lastKey = "";

function current(list: Entry[]): Entry | undefined {
  const id = api.state.get().selectedId;
  return (id && list.find((e) => e.id === id)) || list[0];
}

/** Warms the browser cache with the neighbours' heroes so stepping is instant. */
function prefetch(list: Entry[], i: number) {
  for (const j of [i - 1, i + 1, i + 2]) {
    const e = list[(j + list.length) % list.length];
    if (e && j !== i) new Image().src = api.art.url(e.id, "hero", window.innerWidth);
  }
}

function step(delta: number) {
  const list = api.library.query();
  if (!list.length) return;
  const e = current(list);
  const i = e ? list.indexOf(e) : 0;
  const next = list[(i + delta + list.length) % list.length];
  void api.state.set({ selectedId: next.id });
}

function rows(): (NavContainer & HTMLElement)[] {
  return [...(root?.querySelectorAll<NavContainer & HTMLElement>(".v-spot-rows vellum-cover-row") ?? [])];
}

function renderCovers(list: Entry[], e: Entry) {
  const s = api.state.get();
  if (!s.groupBy) {
    return html`<vellum-cover-row class="v-spot-strip" centered activate="launch" data-vellum-focus-default .entries=${list}></vellum-cover-row>`;
  }
  const groups = api.library.groups();
  const home = groups.find((g) => g.entries.includes(e))?.key;
  return repeat(
    groups,
    (g) => g.key,
    (g) =>
      html`<section class="v-spot-row" data-key=${g.key}>
        <h3 class="v-spot-row-label">${g.label} <span class="v-spot-row-count">${g.entries.length}</span></h3>
        <vellum-cover-row activate="launch" ?data-vellum-focus-default=${g.key === home} .entries=${g.entries}></vellum-cover-row>
      </section>`,
  );
}

function render() {
  if (!root) return;
  const list = api.library.query();
  const e = current(list);
  if (!e) {
    litRender(html`<vellum-empty></vellum-empty>`, root);
    return;
  }
  if (api.state.get().selectedId !== e.id) void api.state.set({ selectedId: e.id });
  prefetch(list, list.indexOf(e));
  const m = e.metadata;
  const meta = [m.developer, releaseYear(e), m.genres?.slice(0, 3).join(", ")].filter(Boolean).join("  ·  ");
  const facts = [
    e.lastLaunched ? `Last launched ${formatWhen(e.lastLaunched).toLowerCase()}` : "Never launched from Vellum",
    formatSize(e.sizeBytes),
  ].filter(Boolean);
  const grouped = !!api.state.get().groupBy;
  litRender(
    html`<div class="v-spot-stage">
        <vellum-hero class="v-spot-hero" blur .entry=${e}></vellum-hero>
        <div class="v-spot-scrim" aria-hidden="true"></div>
        <div class="v-spot-tools"><vellum-group-menu></vellum-group-menu></div>
        <div class="v-spot-content">
          <div class="v-spot-info">
            <vellum-logo class="v-spot-logo" .entry=${e}></vellum-logo>
            ${meta ? html`<p class="v-spot-meta">${meta}</p>` : nothing}
            <div class="v-spot-badges">
              ${(e.labels ?? []).map((l) => html`<span class="v-spot-label">${l}</span>`)}
              <vellum-source-badges .entry=${e}></vellum-source-badges>
            </div>
            ${m.description ? html`<p class="v-spot-desc">${m.description}</p>` : nothing}
            <div class="v-spot-actions">
              <vellum-play-button .entry=${e}></vellum-play-button>
              <button
                class="v-button"
                data-vellum-focus
                aria-pressed=${e.favorite}
                title="Favorite (Ctrl+D)"
                @click=${() => api.actions.toggleFavorite(e.id)}
              >
                ${e.favorite ? "★ Favorite" : "☆ Favorite"}
              </button>
              <button class="v-button" data-vellum-focus @click=${() => api.actions.changeArt(e.id, "hero")}>Change art…</button>
              <button
                class="v-button"
                data-vellum-focus
                aria-label="More actions"
                @click=${(ev: MouseEvent) => {
                  const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
                  void api.ui.contextMenu(e.id, r.left, r.bottom + 4);
                }}
              >
                ⋯
              </button>
            </div>
            <p class="v-spot-facts">${facts.join("  ·  ")}</p>
          </div>
        </div>
      </div>
      <div class="v-spot-rows" ?data-grouped=${grouped}>${renderCovers(list, e)}</div>`,
    root,
  );
}

/** Moves focus to another row, entering it at the cover nearest to where focus was. */
function focusRow(from: NavContainer & HTMLElement, to: NavContainer & HTMLElement, dir: "up" | "down") {
  const box = from.vellumFocusBox();
  to.closest(".v-spot-row")?.scrollIntoView({ block: "nearest", behavior: "instant" });
  to.focus({ preventScroll: true });
  to.vellumEnter(box, dir);
}

function onNav(e: NavEvent) {
  if (!root) return;
  const all = rows();
  const row = all.find((r) => r === document.activeElement);
  if (row && (e.name === "up" || e.name === "down") && root.querySelector(".v-spot-rows[data-grouped]")) {
    const i = all.indexOf(row);
    const j = e.name === "up" ? i - 1 : i + 1;
    if (j >= 0 && j < all.length) {
      e.preventDefault();
      focusRow(row, all[j], e.name);
    } else if (e.name === "down") {
      e.preventDefault(); // nothing below the last row
    }
    return; // up from the first row: the default moves to the actions
  }
  if ((e.name === "left" || e.name === "right") && !row) {
    // Inside the action row, left/right move between buttons first. (document.activeElement
    // is the shadow host when focus is inside <vellum-play-button>.)
    if (root.querySelector(".v-spot-actions")?.contains(document.activeElement)) {
      if (api.input.focus.move(e.name)) return e.preventDefault();
    }
    e.preventDefault();
    step(e.name === "left" ? -1 : 1);
  } else if (e.name === "back" && api.views.previous()) {
    e.preventDefault();
    void api.views.back();
  }
}

const view: ViewImpl = {
  mount(el, vellum) {
    api = vellum;
    root = el;
    el.classList.add("v-spotlight");
    lastKey = "";
    render();
    unsubs = [vellum.library.on("change", render), vellum.input.on("nav", onNav)];
  },

  onState(s: UiState) {
    const key = JSON.stringify([s.query, s.filters, s.sort, s.groupBy, s.selectedId]);
    if (key === lastKey) return;
    lastKey = key;
    render();
  },

  unmount() {
    unsubs.forEach((u) => u());
    unsubs = [];
    if (root) litRender(nothing, root);
    root = null;
  },
};

export default view;
