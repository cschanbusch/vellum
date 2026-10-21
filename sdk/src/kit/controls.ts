// Layout controls: <vellum-search>, <vellum-view-switcher>, <vellum-sort-menu>,
// <vellum-group-menu>, <vellum-filter-bar>, and the <vellum-menu> popover they share.
// Menus are lists of focusable buttons, so arrows and a controller work the same as a mouse.

import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { vellum } from "../core";
import { focus } from "../focus";
import { parseSort } from "../query";
import { GROUP_KEYS, type EntryKind, type Filters, type GroupKey, type Sort, type SortKey } from "../types";
import { controlStyles } from "./shared";

export interface MenuItem {
  value: string;
  label: string;
  checked?: boolean;
  /** Section heading shown before this item. */
  section?: string;
}

/** A button that opens a popover menu. Fires `vellum-select` with `{ value }`. */
export class VellumMenu extends LitElement {
  static properties = {
    label: { type: String },
    items: { attribute: false },
    multiple: { type: Boolean },
    badge: { type: String },
  };
  declare label: string;
  declare items: MenuItem[];
  /** Keep the menu open after a choice (checkbox-style menus). */
  declare multiple: boolean;
  declare badge: string;

  constructor() {
    super();
    this.label = "";
    this.items = [];
    this.multiple = false;
    this.badge = "";
  }

  private get panel() {
    return this.renderRoot.querySelector<HTMLElement>(".panel")!;
  }

  private toggle() {
    const p = this.panel;
    if (p.matches(":popover-open")) return p.hidePopover();
    const r = this.renderRoot.querySelector(".trigger")!.getBoundingClientRect();
    p.style.top = `${r.bottom + 6}px`;
    p.style.left = `${Math.min(r.left, innerWidth - 280)}px`;
    p.showPopover();
    const first = p.querySelector<HTMLElement>('[aria-checked="true"]') ?? p.querySelector<HTMLElement>("button");
    first?.focus();
  }

  private choose(value: string) {
    this.dispatchEvent(new CustomEvent("vellum-select", { detail: { value }, bubbles: true, composed: true }));
    if (!this.multiple) {
      this.panel.hidePopover();
      this.renderRoot.querySelector<HTMLElement>(".trigger")?.focus();
    }
  }

  render() {
    const role = this.multiple ? "menuitemcheckbox" : "menuitemradio";
    return html`<button class="trigger" part="trigger" data-vellum-focus aria-haspopup="menu" @click=${this.toggle}>
        <span part="label">${this.label}</span>
        ${this.badge ? html`<span class="badge" part="badge">${this.badge}</span>` : nothing}
        <span class="caret" part="caret" aria-hidden="true">▾</span>
      </button>
      <div class="panel" part="panel" popover role="menu">
        ${this.items.map(
          (it) => html`${it.section ? html`<div class="section" part="section">${it.section}</div>` : nothing}
            <button role=${role} aria-checked=${!!it.checked} data-vellum-focus @click=${() => this.choose(it.value)}>
              <span class="check" aria-hidden="true">${it.checked ? "✓" : ""}</span>${it.label}
            </button>`,
        )}
      </div>`;
  }

  static styles = [
    controlStyles,
    css`
      :host {
        display: inline-block;
      }
      .trigger {
        white-space: nowrap;
      }
      .caret {
        font-size: 0.7em;
        color: var(--v-text-muted);
      }
      .badge {
        min-width: 1.3em;
        padding: 0 0.35em;
        border-radius: 99px;
        background: var(--v-accent);
        color: var(--v-accent-text);
        font-size: 0.75em;
        font-weight: 700;
        text-align: center;
      }
      .panel {
        position: fixed;
        inset: auto;
        margin: 0;
        min-width: 14rem;
        max-height: min(70vh, 32rem);
        overflow: auto;
        padding: 0.3rem;
        border: 1px solid color-mix(in srgb, var(--v-text) 10%, transparent);
        border-radius: var(--v-radius);
        background: var(--v-surface-raised);
        color: var(--v-text);
        box-shadow: 0 16px 40px rgb(0 0 0 / 0.45);
      }
      .panel:popover-open {
        display: flex;
        flex-direction: column;
      }
      .panel button {
        justify-content: flex-start;
        background: transparent;
        border-color: transparent;
        padding: 0.45em 0.7em;
      }
      .panel button:hover {
        background: color-mix(in srgb, var(--v-text) 8%, transparent);
      }
      .check {
        width: 1em;
        color: var(--v-accent);
      }
      .section {
        padding: 0.6rem 0.7rem 0.2rem;
        font-size: 0.7rem;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--v-text-muted);
      }
    `,
  ];
}
customElements.define("vellum-menu", VellumMenu);

/** Base for controls that re-render on SDK state/library/view changes. */
class Bound extends LitElement {
  private unsubs: (() => void)[] = [];
  connectedCallback() {
    super.connectedCallback();
    const r = () => this.requestUpdate();
    this.unsubs.push(vellum.state.on("change", r), vellum.library.on("change", r), vellum.views.on("change", r), vellum.providers.on("change", r));
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
  }
}

/** Search box bound to `state.query`. Ctrl+F, the search button or just typing focuses it. */
export class VellumSearch extends Bound {
  private timer = 0;
  private local: string | null = null;

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener("vellum-search-focus", this.onFocusRequest);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("vellum-search-focus", this.onFocusRequest);
  }

  private get inputEl() {
    return this.renderRoot.querySelector("input")!;
  }

  private onFocusRequest = (e: Event) => {
    const char = (e as CustomEvent<{ char?: string }>).detail?.char;
    const input = this.inputEl;
    input.focus();
    if (char) {
      input.value += char;
      this.onInput();
    }
  };

  private onInput() {
    this.local = this.inputEl.value;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      void vellum.state.set({ query: this.local ?? "" });
      this.local = null;
    }, 120);
  }

  private onKey(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    // Escape clears first, then leaves the box.
    e.preventDefault();
    e.stopPropagation();
    if (this.inputEl.value) {
      this.inputEl.value = "";
      this.local = null;
      clearTimeout(this.timer);
      void vellum.state.set({ query: "" });
    } else {
      this.inputEl.blur();
      focus.focusDefault();
    }
  }

  render() {
    const q = this.local ?? vellum.state.get().query;
    return html`<label part="box">
      <span class="icon" part="icon" aria-hidden="true">⌕</span>
      <input
        part="input"
        type="search"
        placeholder="Search"
        aria-label="Search games"
        autocomplete="off"
        spellcheck="false"
        data-vellum-focus
        data-vellum-search
        .value=${q}
        @input=${this.onInput}
        @keydown=${this.onKey}
      />
    </label>`;
  }

  static styles = [
    controlStyles,
    css`
      :host {
        display: block;
        min-width: 12rem;
      }
      label {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        padding: 0 0.75rem;
        border-radius: 99px;
        background: var(--v-surface);
        border: 1px solid color-mix(in srgb, var(--v-text) 8%, transparent);
        transition: border-color var(--v-transition);
      }
      label:focus-within {
        border-color: var(--v-focus-ring);
      }
      .icon {
        color: var(--v-text-muted);
        font-size: 1.1em;
      }
      input {
        flex: 1;
        min-width: 0;
        border: 0;
        background: transparent;
        padding: 0.5rem 0;
        outline: none;
      }
      input::-webkit-search-cancel-button {
        filter: grayscale(1);
      }
    `,
  ];
}
customElements.define("vellum-search", VellumSearch);

/** Tabs for the views on offer, in the user's order. */
export class VellumViewSwitcher extends Bound {
  render() {
    const current = vellum.state.get().view;
    return html`<div class="tabs" role="tablist" part="tabs">
      ${vellum.views.list().map(
        (v) => html`<button
          role="tab"
          part=${`tab tab-${v.id}${v.id === current ? " tab-selected" : ""}`}
          data-vellum-focus
          aria-selected=${v.id === current}
          title=${v.hotkey ? `${v.name} (${v.hotkey})` : v.name}
          @click=${() => vellum.views.switch(v.id)}
        >
          ${v.icon ? html`<img src=${vellum.skin.assetUrl(v.icon)} alt="" />` : nothing}${v.name}
        </button>`,
      )}
    </div>`;
  }

  static styles = [
    controlStyles,
    css`
      .tabs {
        display: inline-flex;
        padding: 3px;
        gap: 2px;
        border-radius: calc(var(--v-radius) + 3px);
        background: var(--v-surface);
      }
      button {
        background: transparent;
        border-color: transparent;
        color: var(--v-text-muted);
        padding: 0.35em 0.9em;
      }
      button[aria-selected="true"] {
        background: var(--v-surface-raised);
        color: var(--v-text);
      }
      img {
        width: 1em;
        height: 1em;
      }
    `,
  ];
}
customElements.define("vellum-view-switcher", VellumViewSwitcher);

const SORT_LABELS: Record<SortKey, string> = {
  title: "Title",
  lastLaunched: "Last launched",
  added: "Date added",
  size: "Size",
  releaseDate: "Release date",
  provider: "Store",
};

/** Sort key and direction. */
export class VellumSortMenu extends Bound {
  private pick(value: string) {
    const { key, reversed } = parseSort(vellum.state.get().sort);
    let next: string;
    if (value === "reverse") next = reversed ? key : `-${key}`;
    else next = value;
    void vellum.state.set({ sort: next as Sort });
  }

  render() {
    const { key, reversed } = parseSort(vellum.state.get().sort);
    const items: MenuItem[] = [
      ...(Object.keys(SORT_LABELS) as SortKey[]).map((k) => ({ value: k, label: SORT_LABELS[k], checked: k === key })),
      { value: "reverse", label: "Reverse order", checked: reversed, section: "Direction" },
    ];
    return html`<vellum-menu
      exportparts="trigger, panel, caret"
      label=${`Sort: ${SORT_LABELS[key]}${reversed ? " ↑" : ""}`}
      .items=${items}
      @vellum-select=${(e: CustomEvent<{ value: string }>) => this.pick(e.detail.value)}
    ></vellum-menu>`;
  }
}
customElements.define("vellum-sort-menu", VellumSortMenu);

const GROUP_LABELS: Record<GroupKey, string> = {
  category: "Store collection",
  tag: "Tag",
  provider: "Store",
  favorites: "Favorites",
  recent: "Recently launched",
  letter: "First letter",
};

/** Group by: none, or one of the shelf groupings. */
export class VellumGroupMenu extends Bound {
  render() {
    const by = vellum.state.get().groupBy;
    const items: MenuItem[] = [
      { value: "", label: "None", checked: !by },
      ...GROUP_KEYS.map((k) => ({ value: k, label: GROUP_LABELS[k], checked: k === by })),
    ];
    return html`<vellum-menu
      exportparts="trigger, panel, caret"
      label=${by ? `Group: ${GROUP_LABELS[by]}` : "Group: None"}
      .items=${items}
      @vellum-select=${(e: CustomEvent<{ value: string }>) => vellum.state.set({ groupBy: (e.detail.value || null) as GroupKey | null })}
    ></vellum-menu>`;
  }
}
customElements.define("vellum-group-menu", VellumGroupMenu);

function toggleIn<T>(list: T[] | undefined, v: T): T[] {
  const l = list ?? [];
  return l.includes(v) ? l.filter((x) => x !== v) : [...l, v];
}

/** Every filter in one menu: kinds, favorites, hidden, stores, tags and store collections. */
export class VellumFilterBar extends Bound {
  private apply(value: string) {
    const f: Filters = { ...vellum.state.get().filters };
    const [kind, arg] = value.split(":", 2) as [string, string];
    switch (kind) {
      case "clear":
        return vellum.state.set({ filters: {} });
      case "kind": {
        const kinds = toggleIn<EntryKind>(f.kinds ?? ["game"], arg as EntryKind);
        f.kinds = kinds.length ? kinds : ["game"];
        if (kinds.length === 1 && kinds[0] === "game") delete f.kinds;
        break;
      }
      case "favorites":
        f.favorites = !f.favorites || undefined;
        break;
      case "hidden":
        f.showHidden = !f.showHidden || undefined;
        break;
      case "provider":
        f.providers = toggleIn(f.providers, arg);
        break;
      case "tag":
        f.tags = toggleIn(f.tags, value.slice(4));
        break;
      case "cat":
        f.categories = toggleIn(f.categories, value.slice(4));
        break;
    }
    for (const k of Object.keys(f) as (keyof Filters)[]) {
      const v = f[k];
      if (v === undefined || (Array.isArray(v) && !v.length)) delete f[k];
    }
    return vellum.state.set({ filters: f });
  }

  render(): TemplateResult {
    const f = vellum.state.get().filters;
    const kinds = f.kinds ?? ["game"];
    const { tags, categories } = vellum.library.facets();
    const items: MenuItem[] = [
      { value: "favorites", label: "Favorites only", checked: !!f.favorites, section: "Show" },
      { value: "hidden", label: "Hidden games", checked: !!f.showHidden },
      { value: "kind:tool", label: "Tools and redistributables", checked: kinds.includes("tool") },
      { value: "kind:dlc", label: "DLC", checked: kinds.includes("dlc") },
      { value: "kind:other", label: "Soundtracks and other extras", checked: kinds.includes("other") },
      ...vellum.providers.list().map((p, i) => ({
        value: `provider:${p.id}`,
        label: p.name,
        checked: !!f.providers?.includes(p.id),
        ...(i === 0 ? { section: "Stores" } : {}),
      })),
      ...tags.map((t, i) => ({ value: `tag:${t}`, label: t, checked: !!f.tags?.includes(t), ...(i === 0 ? { section: "Tags" } : {}) })),
      ...categories.map((c, i) => ({
        value: `cat:${c.id}`,
        label: c.name,
        checked: !!f.categories?.includes(c.id),
        ...(i === 0 ? { section: "Store collections" } : {}),
      })),
    ];
    const active = Object.keys(f).length;
    if (active) items.push({ value: "clear", label: "Clear all filters", section: " " });
    return html`<vellum-menu
      multiple
      exportparts="trigger, panel, badge, caret"
      label="Filters"
      badge=${active ? String(active) : ""}
      .items=${items}
      @vellum-select=${(e: CustomEvent<{ value: string }>) => this.apply(e.detail.value)}
    ></vellum-menu>`;
  }
}
customElements.define("vellum-filter-bar", VellumFilterBar);
