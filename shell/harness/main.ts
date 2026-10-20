// The skin dev harness page. It plays the shell's part with the same controller, bridge,
// context menu and overlays as the app, over a mock backend that keeps user data in this
// browser's localStorage. Started by scripts/dev-skin.mjs.

import { LitElement, css, html, nothing } from "lit";
import { NAV_EVENTS, type NavName } from "../../sdk/src/protocol";
import { facets } from "../../sdk/src/query";
import type { Entry, ProviderInfo, SkinOption } from "../../sdk/src/types";
import type { Backend, SkinRecord, UiSettings } from "../src/host/backend";
import { SkinHostController } from "../src/host/controller";
import { entryMenu } from "../src/host/entry-menu";
import type { ContextMenu, DevErrorOverlay, TagsDialog } from "../src/overlays";
import { applySkinTheme, controls, tokens } from "../src/theme";
import { registerToasts, toasts, type ToastHost } from "../src/toasts";
import "../src/overlays";
import "../src/toasts";

interface Config {
  skinOrigin: string;
  skinDir: string;
  manifest: { id: string; name: string; skin?: Record<string, unknown> } | null;
  error: string | null;
  count: number;
  artReady: boolean;
}

interface GameData {
  favorite?: boolean;
  hidden?: boolean;
  tags?: string[];
  lastLaunched?: string;
}

const KEY = "vellum-harness";
const load = <T>(k: string, fallback: T): T => {
  try {
    return JSON.parse(localStorage.getItem(`${KEY}:${k}`) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
};
const save = (k: string, v: unknown) => localStorage.setItem(`${KEY}:${k}`, JSON.stringify(v));

/** The mock backend: library from the harness server, user data and settings in localStorage. */
class MockBackend implements Backend {
  private base: Entry[] = [];
  private games: Record<string, GameData> = load("games", {});
  private listeners = { library: [] as (() => void)[], skin: [] as (() => void)[], file: [] as ((p: string) => void)[] };
  count: number;

  constructor(private cfg: Config) {
    this.count = load("count", cfg.count);
    const events = new EventSource("/__harness/events");
    events.addEventListener("skin-file", (e) => {
      const { path } = JSON.parse((e as MessageEvent).data);
      if (path === "plugin.json") void this.reloadConfig().then(() => this.listeners.skin.forEach((cb) => cb()));
      else this.listeners.file.forEach((cb) => cb(path));
    });
  }

  private async reloadConfig() {
    this.cfg = await (await fetch("/__harness/config")).json();
  }

  async setCount(n: number) {
    this.count = n;
    save("count", n);
    this.base = [];
    this.listeners.library.forEach((cb) => cb());
  }

  private apply(e: Entry): Entry {
    const g = this.games[e.id];
    if (!g) return e;
    return { ...e, favorite: g.favorite ?? e.favorite, hidden: g.hidden ?? e.hidden, tags: g.tags ?? e.tags, lastLaunched: g.lastLaunched ?? e.lastLaunched };
  }

  async entries() {
    if (!this.base.length) this.base = await (await fetch(`/__harness/library?count=${this.count}`)).json();
    return this.base.map((e) => this.apply(e));
  }

  async providers(): Promise<ProviderInfo[]> {
    return [{ id: "mock", name: "Mock library", icon: null, state: "ready", message: null, games: this.base.length }];
  }

  async skin(): Promise<SkinRecord | null> {
    const m = this.cfg.manifest;
    if (!m) return null;
    return { id: m.id, name: m.name, section: m.skin ?? {}, values: load(`options:${m.id}`, {}), fallbackFrom: null, dev: true };
  }

  async uiSettings(): Promise<UiSettings> {
    return load("ui", { startView: "last", last: {}, views: {}, shelves: {}, skinsSeen: [], devMode: true });
  }

  async updateUi(patch: Partial<UiSettings>) {
    const next = { ...(await this.uiSettings()), ...patch };
    save("ui", next);
    return next;
  }

  private update(id: string, f: (g: GameData) => void): Entry {
    const g = (this.games[id] ??= {});
    f(g);
    save("games", this.games);
    const e = this.base.find((x) => x.id === id);
    if (!e) throw new Error(`no entry ${id}`);
    return this.apply(e);
  }

  async runAction(id: string, kind: string) {
    const e = this.base.find((x) => x.id === id)!;
    if (kind === "launch") {
      this.update(id, (g) => (g.lastLaunched = new Date().toISOString()));
      setTimeout(() => this.listeners.library.forEach((cb) => cb()), 50);
    }
    return { title: e.title, providerName: "Mock library (nothing is launched)" };
  }

  setFavorite = async (id: string, v: boolean) => this.update(id, (g) => (g.favorite = v));
  setHidden = async (id: string, v: boolean) => this.update(id, (g) => (g.hidden = v));
  setTags = async (id: string, tags: string[]) => this.update(id, (g) => (g.tags = tags));
  openInstallFolder = async () => toasts().show("The harness has no install folders.");
  window = async () => ({ maximized: false, fullscreen: false });
  refresh = async () => this.listeners.library.forEach((cb) => cb());
  openDevtools = async () => toasts().show("Use the browser's own DevTools (F12).");

  setOption(skin: string, key: string, value: unknown) {
    const values = load<Record<string, unknown>>(`options:${skin}`, {});
    values[key] = value;
    save(`options:${skin}`, values);
    this.listeners.skin.forEach((cb) => cb());
  }

  resetOptions(skin: string) {
    save(`options:${skin}`, {});
    this.listeners.skin.forEach((cb) => cb());
  }

  onLibraryChanged = (cb: () => void) => void this.listeners.library.push(cb);
  onProvidersChanged = () => {};
  onSkinChanged = (cb: () => void) => void this.listeners.skin.push(cb);
  onSkinFileChanged = (cb: (p: string) => void) => void this.listeners.file.push(cb);
  onWindowChanged = () => {};
}

const PAD: { name: NavName; label: string }[] = [
  { name: "prevView", label: "LB" },
  { name: "up", label: "↑" },
  { name: "nextView", label: "RB" },
  { name: "left", label: "←" },
  { name: "confirm", label: "A" },
  { name: "right", label: "→" },
  { name: "pageUp", label: "LT" },
  { name: "down", label: "↓" },
  { name: "pageDown", label: "RT" },
  { name: "back", label: "B" },
  { name: "favorite", label: "X" },
  { name: "search", label: "Y" },
  { name: "menu", label: "Menu" },
  { name: "details", label: "Details" },
  { name: "settings", label: "View" },
];

export class Harness extends LitElement {
  static properties = { cfg: { state: true }, panel: { state: true }, tick: { state: true } };
  declare cfg: Config | null;
  declare panel: boolean;
  declare tick: number;
  private host!: SkinHostController;
  private backend!: MockBackend;

  constructor() {
    super();
    this.cfg = null;
    this.panel = true;
    this.tick = 0;
  }

  async connectedCallback() {
    super.connectedCallback();
    this.cfg = await (await fetch("/__harness/config")).json();
  }

  private get frame() {
    return this.renderRoot.querySelector("iframe");
  }

  async updated() {
    if (!this.cfg || this.host) return;
    registerToasts(this.renderRoot.querySelector("vellum-toasts") as ToastHost);
    const menu = this.renderRoot.querySelector<ContextMenu>("vellum-context-menu")!;
    const tags = this.renderRoot.querySelector<TagsDialog>("vellum-tags-dialog")!;
    const devError = this.renderRoot.querySelector<DevErrorOverlay>("vellum-dev-error")!;
    menu.hidden = true;
    this.backend = new MockBackend(this.cfg);
    const host = (this.host = new SkinHostController(this.backend, {
      toast: (t, e) => toasts().show(t, e),
      contextMenu: (entry, x, y) => {
        const r = this.frame!.getBoundingClientRect();
        const items = entryMenu(host, entry, {
          editTags: async (e) => {
            const t = await tags.edit(e, facets(host.entries).tags);
            if (t) await host.setTags(e.id, t);
            this.frame?.focus();
          },
          changeArt: () => toasts().show("Change art isn't available in the harness."),
        });
        menu.open(entry.title, items, x + r.left, y + r.top, () => this.frame?.focus());
      },
      openSettings: () => {
        this.panel = true;
        toasts().show("Settings open in the app; the harness panel stands in for them.");
      },
      changeArt: () => toasts().show("Change art isn't available in the harness."),
      theme: (t) => applySkinTheme(t),
      devError: (m, s) => devError.show(m, s),
      skinFailed: (r) => toasts().show(`The skin didn't start: ${r}`, true),
    }));
    for (const topic of ["state", "views", "skin", "library"] as const) host.on(topic, () => this.tick++);
    host.on("skin", () => devError.clear());
    await host.start();
    host.attach(this.frame!, this.cfg.skinOrigin, `${this.cfg.skinOrigin}/index.html`);
    this.tick++;
  }

  private option(o: SkinOption, value: unknown) {
    const id = this.host.skin!.id;
    const set = (v: unknown) => this.backend.setOption(id, o.id, v);
    switch (o.type) {
      case "color":
        return html`<input type="color" .value=${String(value)} @input=${(e: Event) => set((e.target as HTMLInputElement).value)} />`;
      case "range":
        return html`<input type="range" min=${o.min ?? 0} max=${o.max ?? 100} step=${o.step ?? 1} .value=${String(value)} @input=${(e: Event) => set(Number((e.target as HTMLInputElement).value))} />`;
      case "toggle":
        return html`<input type="checkbox" .checked=${!!value} @change=${(e: Event) => set((e.target as HTMLInputElement).checked)} />`;
      default:
        return html`<select @change=${(e: Event) => set((e.target as HTMLSelectElement).value)}>
          ${(o.choices ?? []).map((c) => html`<option value=${c.value} ?selected=${c.value === value}>${c.label}</option>`)}
        </select>`;
    }
  }

  private renderPanel() {
    const h = this.host;
    if (!h?.isStarted) return html`<p class="muted">Starting…</p>`;
    const values = h.optionValues();
    return html`
      <h2>${h.skin?.name ?? "No skin"}</h2>
      <p class="muted small">${this.cfg!.skinDir}</p>
      ${this.cfg!.artReady ? nothing : html`<p class="warn small">Mock art isn't generated, so placeholders show. Run <code>npm run mock-art</code> once.</p>`}
      <h3>Views</h3>
      <div class="wrap">
        ${h.available().map(
          (v) => html`<button class=${v.id === h.state.view ? "primary" : ""} title=${v.hotkey ?? ""} @click=${() => h.switchView(v.id)}>${v.name}</button>`,
        )}
      </div>
      <label class="line"><input type="checkbox" .checked=${h.state.couch} @change=${() => h.toggleCouch()} /> Couch mode (F11)</label>
      <h3>Controller</h3>
      <div class="pad">${PAD.map((p) => html`<button title=${p.name} @click=${() => (h.nav(p.name), this.frame?.focus())}>${p.label}</button>`)}</div>
      <h3>Options</h3>
      ${h.options().map((o) => html`<div class="line"><span>${o.label}</span>${this.option(o, values[o.id])}</div>`)}
      ${h.options().length ? html`<button @click=${() => this.backend.resetOptions(h.skin!.id)}>Reset options</button>` : html`<p class="muted small">No options.</p>`}
      <h3>Library</h3>
      <div class="line">
        <span>Mock games</span>
        <select @change=${(e: Event) => this.backend.setCount(Number((e.target as HTMLSelectElement).value))}>
          ${[10, 80, 500, 3000].map((n) => html`<option value=${n} ?selected=${n === this.backend.count}>${n}</option>`)}
        </select>
      </div>
      <div class="wrap">
        <button @click=${() => h.reloadSkinPage()}>Reload skin</button>
        <button
          @click=${() => {
            localStorage.clear();
            location.reload();
          }}
        >
          Reset harness data
        </button>
      </div>
      <p class="muted small">Selected: ${h.state.selectedId ?? "none"} · ${h.entries.length} entries · nav events: ${NAV_EVENTS.length}</p>
    `;
  }

  render() {
    if (!this.cfg) return html`<p class="muted">Loading…</p>`;
    if (this.cfg.error || !this.cfg.manifest) return html`<p class="warn">${this.cfg.error ?? "No manifest"}</p>`;
    return html`
      <div class="stage">
        <iframe sandbox="allow-scripts allow-same-origin" title="Skin"></iframe>
      </div>
      <aside ?hidden=${!this.panel}>${this.renderPanel()}</aside>
      <button class="toggle" @click=${() => (this.panel = !this.panel)}>${this.panel ? "Hide panel" : "Panel"}</button>
      <vellum-context-menu></vellum-context-menu>
      <vellum-tags-dialog></vellum-tags-dialog>
      <vellum-dev-error></vellum-dev-error>
      <vellum-toasts></vellum-toasts>
    `;
  }

  static styles = [
    tokens,
    controls,
    css`
      :host {
        display: flex;
        height: 100vh;
        background: var(--v-bg);
        color: var(--v-text);
        font: 13px/1.45 var(--v-font-body);
      }
      .stage {
        flex: 1;
        display: flex;
        min-width: 0;
      }
      iframe {
        flex: 1;
        border: 0;
        background: var(--v-bg);
      }
      aside {
        width: 300px;
        overflow: auto;
        padding: 14px;
        background: var(--v-surface);
        border-left: 1px solid #2b3246;
      }
      aside[hidden] {
        display: none;
      }
      h2 {
        margin: 0 0 2px;
        font-size: 16px;
      }
      h3 {
        margin: 16px 0 6px;
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--v-text-muted);
      }
      .muted {
        color: var(--v-text-muted);
      }
      .small {
        font-size: 12px;
        word-break: break-all;
      }
      .warn {
        color: var(--v-warning);
      }
      .wrap {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .line {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin: 6px 0;
      }
      .pad {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 4px;
      }
      .pad button {
        padding: 5px 0;
      }
      select {
        font: inherit;
        color: inherit;
        background: var(--v-surface-raised);
        border: 1px solid #2b3246;
        border-radius: 6px;
        padding: 3px 6px;
      }
      .toggle {
        position: fixed;
        right: 8px;
        bottom: 8px;
        z-index: 40;
        opacity: 0.8;
      }
    `,
  ];
}

customElements.define("vellum-harness", Harness);
