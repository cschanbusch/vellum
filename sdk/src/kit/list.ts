// <vellum-list>: virtualized rows with icon, title, source badges, tags, size and last launched.
// Column headers sort. Enter or double-click launches; right-click opens the context menu.

import { LitElement, css, html } from "lit";
import { vellum } from "../core";
import type { Box, Direction } from "../focus-math";
import type { NavContainer } from "../focus";
import { parseSort } from "../query";
import type { Entry, Sort, SortKey } from "../types";
import { styleFor, type ArtStyle } from "../art";
import { controlStyles, couchScale, fire, formatSize, formatWhen, tokenPx } from "./shared";

interface Row {
  el: HTMLDivElement;
  icon: HTMLImageElement;
  title: HTMLSpanElement;
  fav: HTMLSpanElement;
  tags: HTMLSpanElement;
  source: HTMLSpanElement;
  size: HTMLSpanElement;
  when: HTMLSpanElement;
  index: number;
  iconUrl: string;
}

const COLUMNS: { key: SortKey | null; label: string; cls: string }[] = [
  { key: "title", label: "Title", cls: "c-title" },
  { key: "provider", label: "Source", cls: "c-source" },
  { key: "size", label: "Size", cls: "c-size" },
  { key: "lastLaunched", label: "Last launched", cls: "c-when" },
];

export class VellumList extends LitElement implements NavContainer {
  static properties = { entries: { attribute: false }, activate: { type: String }, sort: { state: true } };
  declare entries: Entry[];
  declare activate: "launch" | "details" | "none";
  declare sort: Sort;

  private rowH = 40;
  private iconStyle: ArtStyle | null = null;
  private pool: Row[] = [];
  private scroller!: HTMLDivElement;
  private layer!: HTMLDivElement;
  private sizer!: HTMLDivElement;
  private selectedIndex = -1;
  private frame = 0;
  private resize = new ResizeObserver(() => this.relayout());
  private unsubs: (() => void)[] = [];

  constructor() {
    super();
    this.entries = [];
    this.activate = "launch";
    this.sort = vellum.state.get().sort;
  }

  connectedCallback() {
    super.connectedCallback();
    this.setAttribute("data-vellum-focus", "");
    if (!this.hasAttribute("tabindex")) this.tabIndex = 0;
    this.setAttribute("role", "grid");
    this.resize.observe(this);
    this.unsubs.push(
      vellum.state.on("change", (s) => {
        this.sort = s.sort;
        this.syncSelection();
      }),
      vellum.library.on("change", () => this.refresh()),
      vellum.skin.on("options", () => requestAnimationFrame(() => this.relayout())),
    );
    this.addEventListener("keydown", this.onKey);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.resize.disconnect();
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
  }

  updated(changed: Map<string, unknown>) {
    if (changed.has("entries") && this.layer) this.relayout();
  }

  firstUpdated() {
    this.scroller = this.renderRoot.querySelector(".scroller")!;
    this.layer = this.renderRoot.querySelector(".layer")!;
    this.sizer = this.renderRoot.querySelector(".sizer")!;
    this.scroller.addEventListener(
      "scroll",
      () => {
        cancelAnimationFrame(this.frame);
        this.frame = requestAnimationFrame(() => this.draw());
      },
      { passive: true },
    );
    for (const kind of ["click", "dblclick", "contextmenu"] as const) {
      this.layer.addEventListener(kind, (e) => this.onPointer(e as MouseEvent, kind));
    }
    this.relayout();
  }

  private sortBy(key: SortKey) {
    const { key: cur, reversed } = parseSort(this.sort);
    const next: Sort = key === cur && !reversed ? (`-${key}` as Sort) : key;
    void vellum.state.set({ sort: next });
  }

  render() {
    const { key: cur, reversed } = parseSort(this.sort);
    return html`
      <div class="head" part="header" role="row">
        <span class="c-icon"></span>
        ${COLUMNS.map(
          (c) => html`<button
            class="ghost ${c.cls}"
            part="column"
            role="columnheader"
            aria-sort=${c.key === cur ? (reversed ? "descending" : "ascending") : "none"}
            @click=${() => c.key && this.sortBy(c.key)}
          >
            ${c.label}${c.key === cur ? html`<span class="arrow" aria-hidden="true">${reversed ? "▴" : "▾"}</span>` : ""}
          </button>`,
        )}
      </div>
      <div class="scroller"><div class="sizer"></div><div class="layer"></div></div>
    `;
  }

  private relayout() {
    if (!this.layer) return;
    this.rowH = Math.round(tokenPx(this, "--v-list-row-height", 40) * couchScale());
    this.iconStyle = styleFor("icon", this);
    this.sizer.style.height = `${this.entries.length * this.rowH}px`;
    for (const r of this.pool) {
      r.el.style.height = `${this.rowH}px`;
      r.index = -1;
    }
    this.syncSelection(false);
    this.draw();
  }

  private makeRow(): Row {
    const el = document.createElement("div");
    el.className = "row";
    el.setAttribute("part", "row");
    el.setAttribute("role", "row");
    el.style.height = `${this.rowH}px`;
    const span = (cls: string, part: string) => {
      const s = document.createElement("span");
      s.className = cls;
      s.setAttribute("part", part);
      return s;
    };
    const iconWrap = span("c-icon", "icon");
    const icon = document.createElement("img");
    icon.alt = "";
    icon.decoding = "async";
    iconWrap.append(icon);
    const titleCell = span("c-title", "title");
    const title = document.createElement("span");
    title.className = "t";
    const fav = span("fav", "favorite");
    fav.textContent = "★";
    const tags = span("tags", "tags");
    titleCell.append(title, fav, tags);
    const source = span("c-source", "source");
    const size = span("c-size", "size");
    const when = span("c-when", "when");
    el.append(iconWrap, titleCell, source, size, when);
    this.layer.append(el);
    return { el, icon, title, fav, tags, source, size, when, index: -1, iconUrl: "" };
  }

  private fill(r: Row, i: number) {
    const e = this.entries[i];
    r.index = i;
    r.el.dataset.index = String(i);
    r.el.dataset.id = e.id;
    this.mark(r, i === this.selectedIndex);
    r.el.style.transform = `translateY(${i * this.rowH}px)`;
    r.title.textContent = e.title;
    r.fav.hidden = !e.favorite;
    r.tags.replaceChildren(
      ...(e.labels ?? []).map((t) => {
        const s = document.createElement("span");
        s.className = "label";
        s.setAttribute("part", "label");
        s.textContent = t;
        return s;
      }),
      ...e.tags.map((t) => {
        const s = document.createElement("span");
        s.className = "tag";
        s.textContent = t;
        return s;
      }),
    );
    r.source.textContent = e.sources.map((s) => s.providerName).join(", ");
    r.size.textContent = formatSize(e.sizeBytes);
    r.when.textContent = formatWhen(e.lastLaunched);
    const url = vellum.art.url(e.id, "icon", 32, this.iconStyle);
    if (url !== r.iconUrl) {
      r.iconUrl = url;
      r.icon.src = url;
    }
    r.el.hidden = false;
  }

  /** Selection state, also as the part name `row-selected` for skins. */
  private mark(r: Row, on: boolean) {
    r.el.setAttribute("aria-selected", String(on));
    r.el.setAttribute("part", on ? "row row-selected" : "row");
  }

  private draw() {
    if (!this.layer) return;
    const h = this.scroller.clientHeight;
    const first = Math.max(0, Math.floor(this.scroller.scrollTop / this.rowH) - 4);
    const last = Math.min(this.entries.length, Math.ceil((this.scroller.scrollTop + h) / this.rowH) + 4);
    while (this.pool.length < last - first) this.pool.push(this.makeRow());
    const free: Row[] = [];
    const shown = new Set<number>();
    for (const r of this.pool) {
      if (r.index >= first && r.index < last && r.index < this.entries.length) shown.add(r.index);
      else free.push(r);
    }
    for (let i = first; i < last; i++) if (!shown.has(i)) this.fill(free.pop()!, i);
    for (const r of free) {
      r.el.hidden = true;
      r.index = -1;
    }
  }

  private refresh() {
    for (const r of this.pool) if (r.index >= 0 && r.index < this.entries.length) this.fill(r, r.index);
  }

  private syncSelection(scroll = true) {
    const id = vellum.state.get().selectedId;
    const i = id ? this.entries.findIndex((e) => e.id === id) : -1;
    if (i === this.selectedIndex) return;
    this.selectedIndex = i;
    for (const r of this.pool) this.mark(r, r.index === i && i >= 0);
    if (scroll && i >= 0) this.reveal(i);
  }

  private reveal(i: number) {
    if (!this.scroller) return;
    const y = i * this.rowH;
    const h = this.scroller.clientHeight;
    if (y < this.scroller.scrollTop) this.scroller.scrollTop = y;
    else if (y + this.rowH > this.scroller.scrollTop + h) this.scroller.scrollTop = y + this.rowH - h;
  }

  private select(i: number) {
    if (i < 0 || i >= this.entries.length) return;
    this.selectedIndex = i;
    for (const r of this.pool) this.mark(r, r.index === i);
    this.reveal(i);
    void vellum.state.set({ selectedId: this.entries[i].id });
  }

  private get page() {
    return Math.max(1, Math.floor((this.scroller?.clientHeight ?? 400) / this.rowH) - 1);
  }

  vellumNav(dir: Direction | "pageUp" | "pageDown"): boolean {
    const n = this.entries.length;
    if (!n) return false;
    const i = this.selectedIndex;
    if (i < 0) {
      this.select(0);
      return true;
    }
    switch (dir) {
      case "up":
        if (i === 0) return false;
        this.select(i - 1);
        return true;
      case "down":
        if (i >= n - 1) return false;
        this.select(i + 1);
        return true;
      case "pageUp":
        this.select(Math.max(0, i - this.page));
        return true;
      case "pageDown":
        this.select(Math.min(n - 1, i + this.page));
        return true;
      default:
        return false;
    }
  }

  vellumFocusBox(): Box | null {
    if (this.selectedIndex < 0 || !this.scroller) return null;
    const r = this.scroller.getBoundingClientRect();
    const top = r.top + this.selectedIndex * this.rowH - this.scroller.scrollTop;
    return { left: r.left, right: r.right, top, bottom: top + this.rowH };
  }

  vellumEnter(_from: Box | null, dir: Direction | null) {
    if (!this.entries.length || !this.scroller) return;
    const firstVisible = Math.ceil(this.scroller.scrollTop / this.rowH);
    const lastVisible = Math.floor((this.scroller.scrollTop + this.scroller.clientHeight) / this.rowH) - 1;
    const i = this.selectedIndex;
    if (i >= firstVisible && i <= lastVisible) return;
    if (i >= 0 && dir === null) this.reveal(i);
    else this.select(dir === "up" ? Math.min(lastVisible, this.entries.length - 1) : Math.min(firstVisible, this.entries.length - 1));
  }

  vellumConfirm() {
    const e = this.entries[this.selectedIndex];
    if (e) this.activateEntry(e, "confirm");
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
    this.select(e.key === "Home" ? 0 : this.entries.length - 1);
  };

  private onPointer(e: MouseEvent, kind: "click" | "dblclick" | "contextmenu") {
    const row = (e.target as Element).closest<HTMLElement>(".row");
    if (!row) return;
    const i = Number(row.dataset.index);
    const entry = this.entries[i];
    if (!entry) return;
    if (kind === "contextmenu") e.preventDefault();
    this.focus({ preventScroll: true });
    if (i !== this.selectedIndex) this.select(i);
    if (kind === "dblclick") this.activateEntry(entry, "dblclick");
    if (kind === "contextmenu" && fire(this, "vellum-contextmenu", { id: entry.id, x: e.clientX, y: e.clientY })) {
      void vellum.ui.contextMenu(entry.id, e.clientX, e.clientY);
    }
  }

  static styles = [
    controlStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        min-height: 0;
        outline: none;
        --cols: 2.5rem minmax(12rem, 1fr) 10rem 6rem 9.5rem;
      }
      .head,
      .row {
        display: grid;
        grid-template-columns: var(--cols);
        align-items: center;
        column-gap: 0.75rem;
        padding: 0 var(--v-gap);
      }
      .head {
        border-bottom: 1px solid color-mix(in srgb, var(--v-text) 10%, transparent);
        font-size: 0.75rem;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--v-text-muted);
      }
      .head button {
        padding: 0.6rem 0;
        justify-content: flex-start;
        text-transform: inherit;
        letter-spacing: inherit;
        border-radius: 0;
      }
      .head button:hover:not(:disabled) {
        background: transparent;
        color: var(--v-text);
      }
      .head .c-size,
      .row .c-size {
        justify-content: flex-end;
        text-align: right;
      }
      .arrow {
        color: var(--v-accent);
      }
      .scroller {
        position: relative;
        flex: 1;
        overflow: auto;
        overscroll-behavior: contain;
      }
      .layer {
        position: absolute;
        inset: 0 0 auto 0;
      }
      .row {
        position: absolute;
        left: 0;
        right: 0;
        top: 0;
        cursor: default;
        border-bottom: 1px solid color-mix(in srgb, var(--v-text) 4%, transparent);
        contain: layout style;
      }
      .row > span {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .row:hover {
        background: var(--v-surface);
      }
      .row[aria-selected="true"] {
        background: var(--v-surface-raised);
        box-shadow: inset 3px 0 0 var(--v-accent);
      }
      :host(:focus-visible) .row[aria-selected="true"] {
        box-shadow:
          inset 3px 0 0 var(--v-accent),
          inset 0 0 0 2px var(--v-focus-ring);
      }
      .c-icon {
        display: flex;
        align-items: center;
      }
      .c-icon img {
        width: 1.75rem;
        height: 1.75rem;
        border-radius: calc(var(--v-radius) / 2);
        object-fit: cover;
        background: var(--v-surface);
      }
      .c-title {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        font-weight: 500;
      }
      .c-title .t {
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .fav {
        color: var(--v-accent);
        font-size: 0.8rem;
      }
      .tags {
        display: flex;
        gap: 0.3rem;
      }
      .label {
        padding: 0 0.45rem;
        border-radius: calc(var(--v-radius) / 2);
        font-size: 0.66rem;
        font-weight: 800;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        background: var(--v-accent);
        color: var(--v-accent-text);
      }
      .tag {
        padding: 0 0.45rem;
        border-radius: 99px;
        font-size: 0.7rem;
        font-weight: 500;
        background: var(--v-surface-raised);
        color: var(--v-text-muted);
      }
      .c-source,
      .c-size,
      .c-when {
        color: var(--v-text-muted);
        font-size: 0.875rem;
        font-variant-numeric: tabular-nums;
      }
    `,
  ];
}

customElements.define("vellum-list", VellumList);
