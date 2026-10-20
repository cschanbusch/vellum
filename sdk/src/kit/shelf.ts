// <vellum-cover-row>: a horizontal, virtualized row of covers.
// <vellum-shelf>: a titled, collapsible cover row; one per group when Covers is grouped.

import { LitElement, css, html, nothing } from "lit";
import { vellum } from "../core";
import type { Direction } from "../focus-math";
import type { Group } from "../query";
import type { GroupKey } from "../types";
import { CoverCollection } from "./collection";
import { controlStyles } from "./shared";

export class VellumCoverRow extends CoverCollection {
  static properties = { ...CoverCollection.properties, centered: { type: Boolean } };
  /** Keep the selection centred (the Spotlight strip). */
  declare centered: boolean;

  constructor() {
    super();
    this.centered = false;
  }

  protected measure() {
    super.measure();
    this.style.height = `${this.rowHeight + this.pad * 2}px`;
  }

  protected contentSize() {
    const n = this.entries.length;
    return { w: n ? this.pad * 2 + n * this.cellWidth + (n - 1) * this.gap : 0, h: this.rowHeight + this.pad * 2 };
  }

  private get pitch() {
    return this.cellWidth + this.gap;
  }

  protected position(i: number) {
    return { x: this.pad + i * this.pitch, y: this.pad };
  }

  protected visibleRange(): [number, number] {
    const first = Math.max(0, Math.floor((this.scrollLeft - this.pad) / this.pitch) - 3);
    const last = Math.ceil((this.scrollLeft + this.viewportW) / this.pitch) + 3;
    return [first, Math.min(this.entries.length, last)];
  }

  protected step(dir: Direction | "pageUp" | "pageDown" | "home" | "end", i: number): number {
    const n = this.entries.length;
    const page = Math.max(1, Math.floor(this.viewportW / this.pitch));
    switch (dir) {
      case "left":
        return i > 0 ? i - 1 : -1;
      case "right":
        return i + 1 < n ? i + 1 : -1;
      case "up":
      case "down":
        return -1;
      case "pageUp":
        return Math.max(0, i - page);
      case "pageDown":
        return Math.min(n - 1, i + page);
      case "home":
        return 0;
      case "end":
        return n - 1;
    }
  }

  protected reveal(i: number, smooth: boolean) {
    const x = this.position(i).x;
    let left = this.scrollLeft;
    if (this.centered) left = x + this.cellWidth / 2 - this.viewportW / 2;
    else if (x - this.gap < left) left = x - this.gap;
    else if (x + this.cellWidth + this.gap > left + this.viewportW) left = x + this.cellWidth + this.gap - this.viewportW;
    if (left !== this.scrollLeft) this.scrollTo({ left, behavior: smooth ? "smooth" : "instant" });
  }

  protected syncSelection(scroll = true) {
    super.syncSelection(scroll);
    // The strip follows the selection even while focus is elsewhere (e.g. on Play).
    if (this.centered && this.selectedIndex >= 0) this.reveal(this.selectedIndex, true);
  }

  static styles = [
    CoverCollection.styles,
    css`
      :host {
        overflow-y: hidden;
        scrollbar-width: none;
      }
    `,
  ];
}

customElements.define("vellum-cover-row", VellumCoverRow);

export class VellumShelf extends LitElement {
  static properties = {
    group: { attribute: false },
    by: { type: String },
    collapsed: { type: Boolean, reflect: true },
  };
  declare group: Group;
  declare by: GroupKey;
  declare collapsed: boolean;

  constructor() {
    super();
    this.collapsed = false;
  }

  private toggle() {
    void vellum.shelves.setCollapsed(this.group.key, !this.collapsed);
  }

  /** Moves this shelf one place up or down among the orderable shelves. */
  private move(delta: number) {
    const labels = vellum.library
      .groups(this.by)
      .filter((g) => g.orderable)
      .map((g) => g.label);
    const i = labels.indexOf(this.group.label);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= labels.length) return;
    [labels[i], labels[j]] = [labels[j], labels[i]];
    void vellum.shelves.setOrder(this.by, labels);
  }

  render() {
    const g = this.group;
    if (!g) return nothing;
    return html`
      <header part="header">
        <button
          class="ghost toggle"
          part="toggle"
          data-vellum-focus
          aria-expanded=${!this.collapsed}
          @click=${this.toggle}
          title=${this.collapsed ? "Expand" : "Collapse"}
        >
          <span class="chevron" aria-hidden="true">▾</span>
          <span part="label">${g.label}</span>
          <span part="count" class="count">${g.entries.length}</span>
        </button>
        ${g.orderable
          ? html`<span class="order" part="order">
              <button class="ghost" title="Move shelf up" aria-label="Move shelf up" @click=${() => this.move(-1)}>↑</button>
              <button class="ghost" title="Move shelf down" aria-label="Move shelf down" @click=${() => this.move(1)}>↓</button>
            </span>`
          : nothing}
      </header>
      ${this.collapsed ? nothing : html`<vellum-cover-row part="row" exportparts="cell, cell-selected, art, art-selected, art-focused, cover, caption, title, favorite, label: cover-label" .entries=${g.entries}></vellum-cover-row>`}
    `;
  }

  static styles = [
    controlStyles,
    css`
      :host {
        display: block;
        content-visibility: auto;
        contain-intrinsic-size: auto 360px;
      }
      header {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0 var(--v-gap);
      }
      .toggle {
        font-size: 1.05rem;
        font-weight: 600;
        padding-left: 0.3rem;
      }
      .chevron {
        display: inline-block;
        transition: transform var(--v-transition);
        color: var(--v-text-muted);
      }
      :host([collapsed]) .chevron {
        transform: rotate(-90deg);
      }
      .count {
        font-size: 0.8rem;
        font-weight: 500;
        color: var(--v-text-muted);
      }
      .order {
        opacity: 0;
        transition: opacity var(--v-transition);
      }
      header:hover .order,
      .order:focus-within {
        opacity: 1;
      }
      .order button {
        padding: 0.2em 0.5em;
      }
    `,
  ];
}

customElements.define("vellum-shelf", VellumShelf);
