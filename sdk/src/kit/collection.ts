// Virtualized cover collections: <vellum-grid> (rows that wrap) and the single row inside
// <vellum-shelf>. A fixed pool of absolutely positioned cells is moved with transforms as you
// scroll (the approach the Phase 0 perf spike measured at 60 fps with 3,000 covers).
//
// The collection element itself takes DOM focus; arrows move the selection, which is the
// shared `state.selectedId`. Leaving the collection is the focus manager's job.

import { LitElement, css, html, type CSSResultGroup, type PropertyValues } from "lit";
import { vellum } from "../core";
import type { Box, Direction } from "../focus-math";
import type { NavContainer } from "../focus";
import type { Entry } from "../types";
import { styleFor, type ArtStyle } from "../art";
import { couchScale, fire, tokenPx } from "./shared";

export type ActivateAction = "details" | "launch" | "none";

interface Cell {
  el: HTMLDivElement;
  art: HTMLDivElement;
  img: HTMLImageElement;
  label: HTMLSpanElement;
  title: HTMLSpanElement;
  index: number;
  url: string;
}

export const cellStyles = css`
  /* Spare pooled cells are hidden; without this, .cell's display:flex would keep them (and
     the games they last showed) on screen after a filter shrinks the results. */
  [hidden] {
    display: none !important;
  }
  .cell {
    position: absolute;
    top: 0;
    left: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    contain: layout style;
    cursor: pointer;
    will-change: transform;
  }
  .art {
    position: relative;
    aspect-ratio: 2 / 3;
    border-radius: var(--v-radius);
    overflow: hidden;
    background: var(--v-surface);
    box-shadow: 0 2px 10px rgb(0 0 0 / 0.25);
    transition:
      transform var(--v-transition),
      box-shadow var(--v-transition);
  }
  .art img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    opacity: 0;
    transition: opacity 160ms ease;
  }
  .art img.loaded {
    opacity: 1;
  }
  .caption {
    display: var(--v-cover-caption, block);
    height: 1.4em;
    font-size: 0.85rem;
    line-height: 1.4;
    color: var(--v-text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .fav {
    position: absolute;
    top: 0.4rem;
    right: 0.4rem;
    padding: 0.1rem 0.35rem;
    border-radius: 99px;
    font-size: 0.75rem;
    background: rgb(0 0 0 / 0.55);
    color: var(--v-accent);
    display: none;
  }
  .cell[data-favorite] .fav {
    display: block;
  }
  .label {
    position: absolute;
    left: 0;
    bottom: 0.7rem;
    padding: 0.15rem 0.55rem 0.15rem 0.45rem;
    border-radius: 0 calc(var(--v-radius) / 2) calc(var(--v-radius) / 2) 0;
    font-size: 0.68rem;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    background: var(--v-accent);
    color: var(--v-accent-text);
    box-shadow: 0 2px 6px rgb(0 0 0 / 0.4);
  }
  .cell:hover .art {
    transform: translateY(-2px);
  }
  .cell[aria-selected="true"] .art {
    box-shadow:
      0 0 0 2px var(--v-bg),
      0 0 0 4px color-mix(in srgb, var(--v-accent) 55%, transparent),
      0 8px 24px rgb(0 0 0 / 0.4);
  }
  .cell[aria-selected="true"] .caption {
    color: var(--v-text);
  }
  :host(:focus-visible) .cell[aria-selected="true"] .art,
  :host([data-focused]) .cell[aria-selected="true"] .art {
    box-shadow:
      0 0 0 2px var(--v-bg),
      0 0 0 5px var(--v-focus-ring),
      0 10px 28px rgb(0 0 0 / 0.45);
    transform: scale(1.03);
  }
`;

export abstract class CoverCollection extends LitElement implements NavContainer {
  static properties = {
    entries: { attribute: false },
    activate: { type: String },
  };
  declare entries: Entry[];
  /** What confirm / double-click does when the `vellum-activate` event isn't cancelled. */
  declare activate: ActivateAction;

  protected cellWidth = 200;
  protected rowHeight = 300;
  protected gap = 16;
  protected pad = 16;
  protected viewportW = 0;
  protected viewportH = 0;
  /** From --v-art-style, read with the other tokens. */
  protected artStyle: ArtStyle | null = null;
  private pool: Cell[] = [];
  private layer!: HTMLDivElement;
  private sizer!: HTMLDivElement;
  private frame = 0;
  private resize = new ResizeObserver(() => this.relayout());
  private unsubs: (() => void)[] = [];
  protected selectedIndex = -1;

  constructor() {
    super();
    this.entries = [];
    this.activate = "details";
  }

  connectedCallback() {
    super.connectedCallback();
    this.setAttribute("data-vellum-focus", "");
    if (!this.hasAttribute("tabindex")) this.tabIndex = 0;
    this.setAttribute("role", "listbox");
    this.resize.observe(this);
    this.unsubs.push(
      vellum.state.on("change", () => this.syncSelection()),
      vellum.library.on("change", () => this.refreshCells()),
      // Options can change tokens this layout depends on (cover size, art style).
      vellum.skin.on("options", () => requestAnimationFrame(() => this.relayout())),
    );
    this.addEventListener("scroll", this.onScroll, { passive: true });
    this.addEventListener("keydown", this.onKey);
    this.addEventListener("focus", () => {
      this.toggleAttribute("data-focused", this.matches(":focus-visible"));
      this.remark();
    });
    this.addEventListener("blur", () => {
      this.removeAttribute("data-focused");
      this.remark();
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.resize.disconnect();
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    cancelAnimationFrame(this.frame);
  }

  render() {
    return html`<div class="sizer" part="sizer"></div>
      <div class="layer"></div>`;
  }

  firstUpdated() {
    this.sizer = this.renderRoot.querySelector(".sizer")!;
    this.layer = this.renderRoot.querySelector(".layer")!;
    this.layer.addEventListener("click", (e) => this.onPointer(e, "click"));
    this.layer.addEventListener("dblclick", (e) => this.onPointer(e, "dblclick"));
    this.layer.addEventListener("contextmenu", (e) => this.onPointer(e, "contextmenu"));
    this.relayout();
  }

  updated(changed: PropertyValues) {
    if (changed.has("entries") && this.layer) {
      this.relayout();
    }
  }

  // ---- geometry (subclasses) ----------------------------------------------------------------

  /** Content size for the sizer. */
  protected abstract contentSize(): { w: number; h: number };
  /** Cell position in content coordinates. */
  protected abstract position(i: number): { x: number; y: number };
  /** Index range [first, last) worth rendering for the current scroll position. */
  protected abstract visibleRange(): [number, number];
  /** Moves the selection; returns the new index, or -1 to leave. */
  protected abstract step(dir: Direction | "pageUp" | "pageDown" | "home" | "end", i: number): number;
  /** Scrolls so index `i` is fully visible. */
  protected abstract reveal(i: number, smooth: boolean): void;

  protected measure() {
    const scale = couchScale();
    this.cellWidth = tokenPx(this, "--v-cover-width", 200) * scale;
    this.gap = tokenPx(this, "--v-gap", 16) * scale;
    this.pad = this.gap;
    const caption = getComputedStyle(this).getPropertyValue("--v-cover-caption").trim() === "none" ? 0 : 1;
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    this.rowHeight = Math.round(this.cellWidth * 1.5 + caption * (0.4 * rem + 0.85 * rem * 1.4));
    this.viewportW = this.clientWidth;
    this.viewportH = this.clientHeight;
    this.artStyle = styleFor("cover", this);
  }

  relayout() {
    if (!this.layer) return;
    this.measure();
    const { w, h } = this.contentSize();
    this.sizer.style.width = `${w}px`;
    this.sizer.style.height = `${h}px`;
    for (const c of this.pool) {
      c.el.style.width = `${this.cellWidth}px`;
      c.index = -1;
    }
    this.syncSelection(false);
    this.draw();
  }

  private onScroll = () => {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.draw());
  };

  private makeCell(): Cell {
    const el = document.createElement("div");
    el.className = "cell";
    el.setAttribute("part", "cell");
    el.setAttribute("role", "option");
    el.style.width = `${this.cellWidth}px`;
    const art = document.createElement("div");
    art.className = "art";
    art.setAttribute("part", "art");
    const img = document.createElement("img");
    img.setAttribute("part", "cover");
    img.decoding = "async";
    img.alt = "";
    img.draggable = false;
    img.addEventListener("load", () => img.classList.add("loaded"));
    const fav = document.createElement("span");
    fav.className = "fav";
    fav.setAttribute("part", "favorite");
    fav.textContent = "★";
    const label = document.createElement("span");
    label.className = "label";
    label.setAttribute("part", "label");
    art.append(img, fav, label);
    const caption = document.createElement("div");
    caption.className = "caption";
    caption.setAttribute("part", "caption");
    const title = document.createElement("span");
    title.setAttribute("part", "title");
    caption.append(title);
    el.append(art, caption);
    this.layer.append(el);
    return { el, art, img, label, title, index: -1, url: "" };
  }

  private fill(c: Cell, i: number) {
    const e = this.entries[i];
    c.index = i;
    c.el.dataset.id = e.id;
    c.el.dataset.index = String(i);
    c.el.toggleAttribute("data-favorite", e.favorite);
    c.el.dataset.art = e.artStatus.cover;
    c.el.setAttribute("aria-label", e.title);
    this.mark(c, i === this.selectedIndex);
    c.title.textContent = e.title;
    c.label.textContent = e.labels?.[0] ?? "";
    c.label.hidden = !e.labels?.length;
    const url = vellum.art.url(e.id, "cover", this.cellWidth, this.artStyle);
    if (url !== c.url) {
      c.url = url;
      c.img.classList.remove("loaded");
      c.img.src = url;
      if (c.img.complete && c.img.naturalWidth) c.img.classList.add("loaded");
    }
    const p = this.position(i);
    c.el.style.transform = `translate(${p.x}px, ${p.y}px)`;
    c.el.hidden = false;
  }

  /**
   * Selection state, also as part names so skins can style it: `cell-selected`,
   * `art-selected`, and `art-focused` while the collection has keyboard focus.
   */
  private mark(c: Cell, on: boolean) {
    c.el.setAttribute("aria-selected", String(on));
    c.el.setAttribute("part", on ? "cell cell-selected" : "cell");
    const focused = on && this.hasAttribute("data-focused");
    c.art.setAttribute("part", on ? (focused ? "art art-selected art-focused" : "art art-selected") : "art");
  }

  private remark() {
    for (const c of this.pool) if (c.index >= 0) this.mark(c, c.index === this.selectedIndex);
  }

  /** Assigns pooled cells to the visible range. */
  protected draw() {
    if (!this.layer) return;
    const [first, last] = this.visibleRange();
    const need = Math.max(0, last - first);
    while (this.pool.length < need) this.pool.push(this.makeCell());
    const free: Cell[] = [];
    const shown = new Set<number>();
    for (const c of this.pool) {
      if (c.index >= first && c.index < last && c.index < this.entries.length) shown.add(c.index);
      else free.push(c);
    }
    for (let i = first; i < last; i++) {
      if (shown.has(i)) continue;
      const c = free.pop();
      if (!c) break;
      this.fill(c, i);
    }
    for (const c of free) {
      c.el.hidden = true;
      c.index = -1;
    }
  }

  /** Library changed (favorite toggled, art updated): refill the visible cells. */
  private refreshCells() {
    for (const c of this.pool) if (c.index >= 0 && c.index < this.entries.length) this.fill(c, c.index);
  }

  protected syncSelection(scroll = true) {
    const id = vellum.state.get().selectedId;
    const i = id ? this.entries.findIndex((e) => e.id === id) : -1;
    if (i === this.selectedIndex) return;
    this.selectedIndex = i;
    for (const c of this.pool) this.mark(c, c.index === i && i >= 0);
    if (scroll && i >= 0 && this.matches(":focus-within")) this.reveal(i, false);
  }

  protected select(i: number, reveal = true) {
    if (i < 0 || i >= this.entries.length) return;
    this.selectedIndex = i;
    for (const c of this.pool) this.mark(c, c.index === i);
    if (reveal) this.reveal(i, false);
    void vellum.state.set({ selectedId: this.entries[i].id });
  }

  // ---- NavContainer -------------------------------------------------------------------------

  vellumNav(dir: Direction | "pageUp" | "pageDown"): boolean {
    if (!this.entries.length) return false;
    if (this.selectedIndex < 0) {
      this.select(0);
      return true;
    }
    const next = this.step(dir, this.selectedIndex);
    if (next < 0 || next === this.selectedIndex) return dir === "pageUp" || dir === "pageDown";
    this.select(next);
    return true;
  }

  /** Viewport box of cell `i` (it need not be rendered). */
  protected boxOf(i: number): Box {
    const r = this.getBoundingClientRect();
    const p = this.position(i);
    const left = r.left + p.x - this.scrollLeft;
    const top = r.top + p.y - this.scrollTop;
    return { left, top, right: left + this.cellWidth, bottom: top + this.rowHeight };
  }

  vellumFocusBox(): Box | null {
    return this.selectedIndex >= 0 ? this.boxOf(this.selectedIndex) : null;
  }

  vellumEnter(from: Box | null, _dir: Direction | null) {
    if (!this.entries.length) return;
    const [first, last] = this.visibleRange();
    const sel = this.selectedIndex;
    const selVisible = sel >= 0 && this.isFullyVisible(sel);
    if (!from) {
      if (selVisible) this.reveal(sel, false);
      else this.select(sel >= 0 ? sel : first);
      return;
    }
    // Nearest visible cell to where focus came from.
    const cx = (from.left + from.right) / 2;
    const cy = (from.top + from.bottom) / 2;
    let best = -1;
    let bestD = Infinity;
    for (let i = first; i < Math.min(last, this.entries.length); i++) {
      if (!this.isFullyVisible(i)) continue;
      const b = this.boxOf(i);
      const d = Math.abs((b.left + b.right) / 2 - cx) + 2 * Math.abs((b.top + b.bottom) / 2 - cy);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    this.select(best >= 0 ? best : first);
  }

  protected isFullyVisible(i: number): boolean {
    const b = this.boxOf(i);
    const r = this.getBoundingClientRect();
    return b.left >= r.left - 1 && b.right <= r.right + 1 && b.top >= r.top - 1 && b.bottom <= r.bottom + 1;
  }

  vellumConfirm() {
    if (this.selectedIndex >= 0) this.activateEntry(this.entries[this.selectedIndex], "confirm");
  }

  private activateEntry(e: Entry, how: "confirm" | "dblclick") {
    if (!fire(this, "vellum-activate", { id: e.id, how })) return;
    const action = how === "dblclick" ? "launch" : this.activate;
    if (action === "launch") vellum.actions.launch(e.id).catch(() => {});
    else if (action === "details") void vellum.actions.showDetails(e.id);
  }

  private onKey = (e: KeyboardEvent) => {
    if (e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    e.stopPropagation();
    this.select(this.step(e.key === "Home" ? "home" : "end", this.selectedIndex));
  };

  private onPointer(e: MouseEvent, kind: "click" | "dblclick" | "contextmenu") {
    const cell = (e.target as Element).closest<HTMLElement>(".cell");
    if (!cell) return;
    const i = Number(cell.dataset.index);
    const entry = this.entries[i];
    if (!entry) return;
    if (kind === "contextmenu") e.preventDefault();
    this.focus({ preventScroll: true });
    if (i !== this.selectedIndex) this.select(i, false);
    if (kind === "dblclick") this.activateEntry(entry, "dblclick");
    if (kind === "contextmenu" && fire(this, "vellum-contextmenu", { id: entry.id, x: e.clientX, y: e.clientY })) {
      void vellum.ui.contextMenu(entry.id, e.clientX, e.clientY);
    }
  }

  static styles: CSSResultGroup = [
    cellStyles,
    css`
      :host {
        display: block;
        position: relative;
        overflow: auto;
        outline: none;
        overscroll-behavior: contain;
      }
      .sizer {
        pointer-events: none;
      }
      .layer {
        position: absolute;
        inset: 0 auto auto 0;
      }
    `,
  ];
}
