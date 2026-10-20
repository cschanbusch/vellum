// <vellum-app>: the default complete layout. <vellum-view-outlet>: renders the current view.
// <vellum-empty>: the "nothing to show" message. <vellum-window-controls>: min/max/close for
// frameless skins.
//
// <vellum-app> renders into light DOM, so a skin can restyle every part with plain CSS:
//   vellum-app > .v-topbar, .v-brand, .v-tools, .v-count, vellum-view-outlet

import { LitElement, css, html, nothing } from "lit";
import { vellum, type ViewImpl } from "../core";
import { builtinView } from "../views/registry";
import type { ViewInfo } from "../types";
import { controlStyles } from "./shared";

/** Mounts the current view into a child element, following `state.view`. */
export class VellumViewOutlet extends HTMLElement {
  private mounted: { id: string; impl: ViewImpl; el: HTMLElement; style?: HTMLLinkElement } | null = null;
  private unsubs: (() => void)[] = [];
  private seq = 0;

  connectedCallback() {
    this.unsubs.push(
      vellum.state.on("change", (s) => {
        if (s.view !== this.mounted?.id) void this.show();
        else this.mounted?.impl.onState?.(s);
      }),
      vellum.views.on("change", () => void this.show(true)),
    );
    void vellum.ready().then(() => this.show());
  }

  disconnectedCallback() {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.unmount();
  }

  private unmount() {
    const m = this.mounted;
    if (!m) return;
    try {
      m.impl.unmount?.();
    } catch (e) {
      console.error(`[vellum] view ${m.id} failed to unmount`, e);
    }
    m.el.remove();
    m.style?.remove();
    this.mounted = null;
  }

  /** Implementation for a view: registered by skin code, the manifest's module, or built-in. */
  private async resolve(view: ViewInfo): Promise<ViewImpl> {
    const registered = vellum.views.registered(view.id);
    if (registered) return registered;
    if (view.entry) {
      const mod = await import(/* @vite-ignore */ vellum.skin.assetUrl(view.entry));
      if (!mod.default || typeof mod.default.mount !== "function") throw new Error(`${view.entry} has no default export with mount()`);
      return mod.default as ViewImpl;
    }
    const b = builtinView(view.id);
    if (!b) throw new Error(`no implementation for view "${view.id}"`);
    return b;
  }

  private async show(force = false) {
    await vellum.ready();
    const list = vellum.views.list();
    const wanted = vellum.state.get().view;
    const view = list.find((v) => v.id === wanted) ?? list[0];
    if (!view) return;
    if (!force && this.mounted?.id === view.id) return;
    const seq = ++this.seq;
    let impl: ViewImpl;
    try {
      impl = await this.resolve(view);
    } catch (e) {
      console.error(`[vellum] view ${view.id} failed to load`, e);
      impl = builtinView(view.id) ?? errorView(view, e);
    }
    if (seq !== this.seq) return; // a newer switch won
    const hadFocus = this.contains(document.activeElement);
    this.unmount();
    const el = document.createElement("div");
    el.className = "v-view";
    el.dataset.view = view.id;
    let style: HTMLLinkElement | undefined;
    if (view.style) {
      style = document.createElement("link");
      style.rel = "stylesheet";
      style.href = vellum.skin.assetUrl(view.style);
      document.head.append(style);
    }
    this.append(el);
    this.mounted = { id: view.id, impl, el, style };
    try {
      await impl.mount(el, vellum);
    } catch (e) {
      console.error(`[vellum] view ${view.id} failed to mount`, e);
      el.replaceChildren(errorBox(view, e));
    }
    if (hadFocus || !document.activeElement || document.activeElement === document.body) {
      requestAnimationFrame(() => vellum.input.focus.focusDefault());
    }
  }
}
customElements.define("vellum-view-outlet", VellumViewOutlet);

function errorBox(view: ViewInfo, e: unknown): HTMLElement {
  const p = document.createElement("p");
  p.className = "v-view-error";
  p.textContent = `The ${view.name} view couldn't load: ${e instanceof Error ? e.message : String(e)}`;
  return p;
}

function errorView(view: ViewInfo, e: unknown): ViewImpl {
  return { mount: (el) => el.append(errorBox(view, e)) };
}

/** Explains an empty result: still scanning, a missing store folder, no matches, or no games. */
export class VellumEmpty extends LitElement {
  private unsubs: (() => void)[] = [];
  connectedCallback() {
    super.connectedCallback();
    const r = () => this.requestUpdate();
    this.unsubs.push(vellum.providers.on("change", r), vellum.state.on("change", r), vellum.library.on("change", r));
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this.unsubs.forEach((u) => u());
  }

  render() {
    const s = vellum.state.get();
    const providers = vellum.providers.list();
    const filtered = s.query || Object.keys(s.filters).length > 0;
    let title: string;
    let detail: string;
    let action: { label: string; run: () => void } | null = null;
    if (filtered && vellum.library.all().length) {
      title = "No games match";
      detail = s.query ? `Nothing matches “${s.query}” with the current filters.` : "No games match the current filters.";
      action = { label: "Clear search and filters", run: () => vellum.state.set({ query: "", filters: {} }) };
    } else if (providers.some((p) => p.state === "scanning")) {
      title = "Looking for installed games…";
      detail = "Your stores are being scanned.";
    } else if (providers.some((p) => p.state === "inactive")) {
      title = "A store's folder couldn't be found";
      detail = "Use Browse… in the notice above to point Vellum at it.";
    } else {
      title = "No installed games found";
      detail = "Enable a store in Settings → Plugins.";
      action = { label: "Open settings", run: () => vellum.actions.openSettings("plugins") };
    }
    return html`<div part="box">
      <h2 part="title">${title}</h2>
      <p part="detail">${detail}</p>
      ${action ? html`<button data-vellum-focus data-vellum-focus-default @click=${action.run}>${action.label}</button>` : nothing}
    </div>`;
  }

  static styles = [
    controlStyles,
    css`
      :host {
        display: grid;
        place-items: center;
        padding: 4rem 1rem;
        text-align: center;
      }
      h2 {
        margin: 0 0 0.4rem;
        font: 600 1.25rem var(--v-font-display);
      }
      p {
        margin: 0 0 1.2rem;
        color: var(--v-text-muted);
      }
    `,
  ];
}
customElements.define("vellum-empty", VellumEmpty);

/** Minimize / maximize / close, for skins with `window.frameless`. Hidden in framed windows. */
export class VellumWindowControls extends LitElement {
  private unsub?: () => void;
  connectedCallback() {
    super.connectedCallback();
    this.unsub = vellum.window.on("change", () => this.requestUpdate());
    void vellum.ready().then(() => this.requestUpdate());
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this.unsub?.();
  }

  render() {
    if (!vellum.window.isFrameless()) return nothing;
    const max = vellum.window.isMaximized();
    return html`<button part="minimize" aria-label="Minimize" @click=${() => vellum.window.minimize()}>&#xE921;</button>
      <button part="maximize" aria-label=${max ? "Restore" : "Maximize"} @click=${() => vellum.window.toggleMaximize()}>
        ${max ? "" : ""}
      </button>
      <button part="close" class="close" aria-label="Close" @click=${() => vellum.window.close()}>&#xE8BB;</button>`;
  }

  static styles = css`
    :host {
      display: inline-flex;
      align-self: stretch;
    }
    button {
      width: 46px;
      border: 0;
      background: transparent;
      color: var(--v-text);
      font: 10px "Segoe Fluent Icons", "Segoe MDL2 Assets", sans-serif;
      cursor: default;
    }
    button:hover {
      background: color-mix(in srgb, var(--v-text) 10%, transparent);
    }
    button.close:hover {
      background: #c42b1c;
      color: white;
    }
  `;
}
customElements.define("vellum-window-controls", VellumWindowControls);

/** True when some <vellum-window-controls> (other than the fallback) is fully on screen. */
function controlsVisible(): boolean {
  for (const el of document.querySelectorAll("vellum-window-controls:not(.v-window-controls-fallback)")) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && r.right <= innerWidth + 1 && r.top >= -1 && r.bottom <= innerHeight + 1) {
      const style = getComputedStyle(el);
      if (style.visibility !== "hidden" && style.opacity !== "0") return true;
    }
  }
  return false;
}

/**
 * A frameless window must always be closable. If the skin shows no window controls (it left
 * them out, or its layout pushed them off screen), the SDK pins a set to the top-right corner.
 */
export function guardWindowControls() {
  let fallback: HTMLElement | null = null;
  let frame = 0;
  const check = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const need = vellum.window.isFrameless() && !controlsVisible();
      if (need && !fallback) {
        fallback = document.createElement("vellum-window-controls");
        fallback.className = "v-window-controls-fallback";
        document.body.append(fallback);
      } else if (!need && fallback) {
        fallback.remove();
        fallback = null;
      }
    });
  };
  void vellum.ready().then(() => {
    check();
    // Layouts settle after fonts and views load; check again then, and on every change.
    setTimeout(check, 400);
    setTimeout(check, 1500);
  });
  vellum.window.on("change", check);
  vellum.views.on("change", check);
  vellum.skin.on("options", check);
  addEventListener("resize", check);
  new ResizeObserver(check).observe(document.documentElement);
}

/** The default complete layout: top bar with search, views, filters and sort, then the view. */
export class VellumApp extends LitElement {
  private unsubs: (() => void)[] = [];

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    const r = () => this.requestUpdate();
    this.unsubs.push(vellum.library.on("change", r), vellum.state.on("change", r));
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this.unsubs.forEach((u) => u());
  }

  render() {
    const count = vellum.library.query().length;
    return html`<header class="v-topbar" data-vellum-drag>
        <span class="v-brand">Library</span>
        <span class="v-count">${count} ${count === 1 ? "game" : "games"}</span>
        <vellum-view-switcher class="v-views"></vellum-view-switcher>
        <span class="v-spacer"></span>
        <div class="v-tools">
          <vellum-search></vellum-search>
          <vellum-filter-bar></vellum-filter-bar>
          <vellum-sort-menu></vellum-sort-menu>
        </div>
        <button class="v-icon-button v-settings" data-vellum-focus title="Settings (Ctrl+,)" aria-label="Settings" @click=${() => vellum.actions.openSettings()}>
          ⚙
        </button>
        <vellum-window-controls></vellum-window-controls>
      </header>
      <vellum-view-outlet></vellum-view-outlet>`;
  }
}
customElements.define("vellum-app", VellumApp);
