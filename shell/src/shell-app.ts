import { LitElement, css, html } from "lit";
import { api, type AppInfo, type CustomGame } from "./api";
import { entryMenu, withSkinItems } from "./host/entry-menu";
import { host, hostUi } from "./host/instance";
import type { LibraryView } from "./library-view";
import type { ContextMenu, DevErrorOverlay, StorePicker, TagsDialog } from "./overlays";
import "./art-dialog";
import type { ArtDialog } from "./art-dialog";
import "./duplicates-dialog";
import type { DuplicatesDialog } from "./duplicates-dialog";
import "./stores-dialog";
import type { StoresDialog } from "./stores-dialog";
import "./launch-options-dialog";
import type { LaunchOptionsDialog } from "./launch-options-dialog";
import "./custom-game-dialog";
import type { CustomGameDialog } from "./custom-game-dialog";
import "./recommend";
import type { RecommendDialog } from "./recommend";
import { store } from "./store";
import { applySkinTheme, controls, tokens } from "./theme";
import { registerToasts, toasts, type ToastHost } from "./toasts";
import type { ArtKind, Entry, MenuItem } from "../../sdk/src/types";
import { facets } from "../../sdk/src/query";
import "./library-view";
import "./overlays";
import "./pages/plugins-page";
import "./pages/general-page";
import "./pages/skins-page";
import "./pages/views-page";
import "./pages/developer-page";
import "./pages/versions-page";
import "./pages/catalog-page";
import "./pages/art-page";
import "./pages/library-page";
import "./toasts";

interface PageDef {
  id: string;
  label: string;
  /** Phase in which the page gets its real contents; absent = available now. */
  phase?: number;
}

// The settings pages from the spec, in its order.
const PAGES: PageDef[] = [
  { id: "general", label: "General" },
  { id: "library", label: "Library" },
  { id: "plugins", label: "Plugins" },
  { id: "skins", label: "Skins" },
  { id: "catalog", label: "Get skins" },
  { id: "views", label: "Views" },
  { id: "controls", label: "Controls", phase: 6 },
  { id: "art", label: "Art and metadata" },
  { id: "versions", label: "Versions" },
  { id: "developer", label: "Developer" },
];

/**
 * The window: the skin fills it; settings slide in from the right over the skin (so option
 * changes preview live), and the shell draws menus, dialogs and toasts on top.
 */
export class VellumShell extends LitElement {
  static properties = {
    page: { state: true },
    info: { state: true },
    settingsOpen: { state: true },
  };
  declare page: string;
  declare info: AppInfo | null;
  declare settingsOpen: boolean;
  private onKey = (e: KeyboardEvent) => this.hotkey(e);
  private duplicateTimer = 0;

  constructor() {
    super();
    this.page = "general";
    this.info = null;
    this.settingsOpen = false;
  }

  connectedCallback() {
    super.connectedCallback();
    api.appInfo().then((info) => (this.info = info));
    void store.start();
    window.addEventListener("keydown", this.onKey);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("keydown", this.onKey);
  }

  private get library() {
    return this.renderRoot.querySelector<LibraryView>("vellum-library-view")!;
  }
  private get menu() {
    return this.renderRoot.querySelector<ContextMenu>("vellum-context-menu")!;
  }
  private get tags() {
    return this.renderRoot.querySelector<TagsDialog>("vellum-tags-dialog")!;
  }
  private get art() {
    return this.renderRoot.querySelector<ArtDialog>("vellum-art-dialog")!;
  }
  private get customGame() {
    return this.renderRoot.querySelector<CustomGameDialog>("vellum-custom-game-dialog")!;
  }
  private get duplicates() {
    return this.renderRoot.querySelector<DuplicatesDialog>("vellum-duplicates-dialog")!;
  }
  private get stores() {
    return this.renderRoot.querySelector<StoresDialog>("vellum-stores-dialog")!;
  }
  private get launchOptions() {
    return this.renderRoot.querySelector<LaunchOptionsDialog>("vellum-launch-options-dialog")!;
  }
  private get picker() {
    return this.renderRoot.querySelector<StorePicker>("vellum-store-picker")!;
  }
  private get devError() {
    return this.renderRoot.querySelector<DevErrorOverlay>("vellum-dev-error")!;
  }
  private get recommend() {
    return this.renderRoot.querySelector<RecommendDialog>("vellum-recommend")!;
  }

  async firstUpdated() {
    registerToasts(this.renderRoot.querySelector("vellum-toasts") as ToastHost);
    this.menu.hidden = true;
    Object.assign(hostUi, {
      toast: (text: string, error = false) => toasts().show(text, error),
      contextMenu: (entry: Entry, x: number, y: number, items?: MenuItem[]) => this.openMenu(entry, x, y, items),
      openSettings: (page?: string) => this.openSettings(page),
      changeArt: (entry: Entry, kind: ArtKind) => this.changeArt(entry, kind),
      chooseSource: async (entry: Entry) => {
        const provider = await this.picker.choose(entry);
        if (!this.settingsOpen) this.library.focusSkin();
        return provider;
      },
      theme: (t: Record<string, string>) => applySkinTheme(t),
      devError: (message: string, stack: string) => {
        console.error(`[skin] ${message}\n${stack}`);
        if (host.skin?.dev) this.devError.show(message, stack);
      },
      skinFailed: (reason: string) => this.skinFailed(reason),
    });
    this.art.onEntry = (e) => host.entryChanged(e);
    this.art.onSettings = (page) => this.openSettings(page);
    host.on("skin", () => {
      this.requestUpdate(); // frameless skins get window controls in the settings header
      this.devError?.clear();
      if (host.skin?.fallbackFrom) toasts().show(`The ${host.skin.fallbackFrom} skin couldn't load, so ${host.skin.name} is shown instead.`, true);
    });
    await host.start();
    this.library.attachSkin();
    void this.recommend.check();
    host.on("library", () => this.checkDuplicates());
    store.on("providers", () => this.checkDuplicates());
    this.checkDuplicates();
  }

  /**
   * Asks about new duplicates, when the moment is right: every scan finished (a provider still
   * scanning may add a copy), Vellum in front (never over a game), and no other dialog waiting.
   * Until then it looks again every couple of seconds.
   */
  private checkDuplicates(delay = 800) {
    clearTimeout(this.duplicateTimer);
    this.duplicateTimer = window.setTimeout(() => void this.askDuplicates(), delay);
  }

  private async askDuplicates() {
    if (this.duplicates.isOpen) return;
    const busy =
      !host.focused ||
      store.statuses.some((s) => s.state === "scanning") ||
      this.recommend.state !== "closed" ||
      this.menu.isOpen ||
      !!this.tags.entry ||
      this.art.isOpen ||
      this.customGame.isOpen ||
      this.stores.isOpen ||
      this.launchOptions.isOpen ||
      this.picker.isOpen;
    if (busy) return this.checkDuplicates(2000);
    const pending = await api.duplicates(false).catch(() => []);
    if (pending.length) await this.showDuplicates(pending, true);
  }

  private async showDuplicates(list: Awaited<ReturnType<typeof api.duplicates>>, required: boolean) {
    const answers = await this.duplicates.open(list, required);
    if (answers?.length) await api.resolveDuplicates(answers).catch((err) => toasts().show(String(err), true));
    if (!this.settingsOpen) this.library.focusSkin();
  }

  /** Review duplicates… in Settings. Returns how many there are to review. */
  private async reviewDuplicates() {
    const all = await api.duplicates(true);
    if (all.length) await this.showDuplicates(all, false);
    return all.length;
  }

  private async skinFailed(reason: string) {
    const failed = host.skin;
    if (!failed || failed.id === "basis" || failed.fallbackFrom) {
      toasts().show(`The skin couldn't load: ${reason}`, true);
      return;
    }
    await api.useFallbackSkin(reason);
  }

  private openMenu(entry: Entry, x: number, y: number, skinItems?: MenuItem[]) {
    const r = this.library.frame?.getBoundingClientRect();
    const items = entryMenu(host, entry, {
      editTags: (e) => void this.editTags(e),
      changeArt: (e) => hostUi.changeArt(e, "cover"),
      editCustomGame: (id) => void this.editCustomGameById(id),
      stores: (e) =>
        this.stores.open(e, host.entries, () => {
          if (!this.settingsOpen) this.library.focusSkin();
        }),
      launchOptions: (e, provider) =>
        void this.launchOptions
          .open(e.id, provider, () => {
            if (!this.settingsOpen) this.library.focusSkin();
          })
          .catch((err) => toasts().show(String(err), true)),
    });
    return withSkinItems(
      items,
      skinItems,
      (all, onClose) => this.menu.open(entry.title, all, x + (r?.left ?? 0), y + (r?.top ?? 0), onClose),
      () => {
        if (!this.settingsOpen && !this.tags.entry && !this.art.isOpen && !this.customGame.isOpen && !this.stores.isOpen && !this.launchOptions.isOpen && !this.picker.isOpen) this.library.focusSkin();
      },
    );
  }

  private changeArt(e: Entry, kind: ArtKind) {
    this.art.open(e, kind, () => {
      if (!this.settingsOpen) this.library.focusSkin();
    });
  }

  private async editCustomGameById(id: string) {
    try {
      const game = (await api.customGames()).find((g) => g.id === id);
      if (game) await this.editCustomGame(game);
    } catch (err) {
      toasts().show(String(err), true);
    }
  }

  /** The add/edit dialog; art it attached reaches the skin once the dialog has saved. */
  private async editCustomGame(game?: CustomGame) {
    const id = await this.customGame.open(game);
    if (id) {
      const saved = (await api.libraryEntries()).find((e) => e.id === id || e.sources.some((s) => s.gameId === id));
      if (saved) host.entryChanged(saved);
    }
    if (!this.settingsOpen) this.library.focusSkin();
  }

  private async editTags(e: Entry) {
    const tags = await this.tags.edit(e, facets(host.entries).tags);
    if (tags) await host.setTags(e.id, tags).catch((err) => toasts().show(String(err), true));
    this.library.focusSkin();
  }

  openSettings(page?: string) {
    if (page && PAGES.some((p) => p.id === page)) this.page = page;
    this.settingsOpen = true;
    void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLElement>("nav button.active")?.focus());
  }

  closeSettings() {
    this.settingsOpen = false;
    this.library.focusSkin();
  }

  /** Keys pressed while the shell (not the skin) has focus. The SDK handles them in the skin. */
  private hotkey(e: KeyboardEvent) {
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key === ",") {
      e.preventDefault();
      if (this.settingsOpen) this.closeSettings();
      else this.openSettings();
    } else if (e.key === "Escape" && this.art.isOpen) {
      e.preventDefault();
      this.art.close();
    } else if (e.key === "Escape" && this.settingsOpen && !this.menu.isOpen && !this.tags.entry) {
      e.preventDefault();
      this.closeSettings();
    } else if (ctrl && !e.shiftKey && e.key.toLowerCase() === "r") {
      e.preventDefault();
      void api.refreshLibrary();
    } else if (e.key === "F11") {
      e.preventDefault();
      void host.toggleCouch();
    } else if (ctrl && e.shiftKey && e.key.toLowerCase() === "i") {
      e.preventDefault();
      api.openDevtools().catch((err) => toasts().show(String(err), true));
    } else if (!this.settingsOpen && ctrl && /^Digit[1-9]$/.test(e.code)) {
      if (host.switchByHotkey(`Ctrl+${e.code.slice(5)}`)) e.preventDefault();
    } else if (!this.settingsOpen && ctrl && e.key === "Tab") {
      e.preventDefault();
      host.cycleView(e.shiftKey ? -1 : 1);
    }
  }

  render() {
    const current = PAGES.find((p) => p.id === this.page)!;
    return html`
      <vellum-library-view ?inert=${this.settingsOpen}></vellum-library-view>
      <div class="drawer-wrap" ?hidden=${!this.settingsOpen}>
        <div class="scrim" @click=${() => this.closeSettings()}></div>
        <aside class="drawer" role="dialog" aria-modal="true" aria-label="Settings">
          <header>
            <span class="brand">Settings</span>
            ${this.info?.portable ? html`<span class="pill">Portable</span>` : null}
            <span class="spacer"></span>
            <button title="Close settings (Esc)" @click=${() => this.closeSettings()}>Done</button>
            ${host.frameless()
              ? html`<span class="winctl">
                  <button aria-label="Minimize" @click=${() => api.windowAction("minimize")}>&#xE921;</button>
                  <button aria-label="Maximize or restore" @click=${() => api.windowAction("toggleMaximize")}>&#xE922;</button>
                  <button class="close" aria-label="Close" @click=${() => api.windowAction("close")}>&#xE8BB;</button>
                </span>`
              : null}
          </header>
          <div class="body">
            <nav aria-label="Settings pages">
              ${PAGES.map(
                (p) => html`<button
                  class=${p.id === this.page ? "active" : ""}
                  aria-current=${p.id === this.page ? "page" : "false"}
                  @click=${() => (this.page = p.id)}
                >
                  ${p.label}
                </button>`,
              )}
            </nav>
            <main>${this.settingsOpen ? this.renderPage(current) : null}</main>
          </div>
        </aside>
      </div>
      <vellum-context-menu></vellum-context-menu>
      <vellum-tags-dialog></vellum-tags-dialog>
      <vellum-art-dialog></vellum-art-dialog>
      <vellum-custom-game-dialog></vellum-custom-game-dialog>
      <vellum-stores-dialog></vellum-stores-dialog>
      <vellum-launch-options-dialog></vellum-launch-options-dialog>
      <vellum-store-picker></vellum-store-picker>
      <vellum-duplicates-dialog></vellum-duplicates-dialog>
      <vellum-dev-error></vellum-dev-error>
      <vellum-recommend></vellum-recommend>
      <vellum-toasts></vellum-toasts>
    `;
  }

  private renderPage(p: PageDef) {
    switch (p.id) {
      case "plugins":
        return html`<vellum-plugins-page></vellum-plugins-page>`;
      case "general":
        return html`<vellum-general-page .info=${this.info}></vellum-general-page>`;
      case "skins":
        return html`<vellum-skins-page></vellum-skins-page>`;
      case "views":
        return html`<vellum-views-page></vellum-views-page>`;
      case "catalog":
        return html`<vellum-catalog-page></vellum-catalog-page>`;
      case "versions":
        return html`<vellum-versions-page></vellum-versions-page>`;
      case "art":
        return html`<vellum-art-page></vellum-art-page>`;
      case "library":
        return html`<vellum-library-page
          .editGame=${(g?: CustomGame) => this.editCustomGame(g)}
          .reviewDuplicates=${() => this.reviewDuplicates()}
        ></vellum-library-page>`;
      case "developer":
        return html`<vellum-developer-page></vellum-developer-page>`;
    }
    return html`<h1>${p.label}</h1>
      <p class="muted">This page is built in Phase ${p.phase}.</p>`;
  }

  static styles = [
    tokens,
    controls,
    css`
      :host {
        display: flex;
        flex-direction: column;
        height: 100vh;
        background: var(--v-bg);
        color: var(--v-text);
        font: 14px/1.45 var(--v-font-body);
      }
      [hidden] {
        display: none !important;
      }
      .drawer-wrap {
        position: fixed;
        inset: 0;
        z-index: 50;
      }
      .scrim {
        position: absolute;
        inset: 0;
        background: #0006;
      }
      .drawer {
        position: absolute;
        top: 0;
        right: 0;
        bottom: 0;
        width: min(920px, calc(100vw - 280px));
        min-width: min(640px, 100vw);
        display: flex;
        flex-direction: column;
        background: var(--v-bg);
        border-left: 1px solid color-mix(in srgb, var(--v-text) 10%, transparent);
        box-shadow: -20px 0 60px #0008;
        animation: slide 160ms ease-out;
      }
      @keyframes slide {
        from {
          transform: translateX(40px);
          opacity: 0;
        }
      }
      header {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 16px;
        background: var(--v-surface);
        border-bottom: 1px solid color-mix(in srgb, var(--v-text) 8%, transparent);
      }
      .brand {
        font-weight: 650;
        font-size: 16px;
      }
      .winctl {
        display: inline-flex;
        align-self: stretch;
        margin: -10px -16px -10px 4px;
      }
      .winctl button {
        width: 46px;
        border: 0;
        border-radius: 0;
        background: transparent;
        font: 10px "Segoe Fluent Icons", "Segoe MDL2 Assets", sans-serif;
      }
      .winctl button:hover {
        background: color-mix(in srgb, var(--v-text) 10%, transparent);
      }
      .winctl button.close:hover {
        background: #c42b1c;
        color: #fff;
      }
      .spacer {
        flex: 1;
      }
      .muted {
        color: var(--v-text-muted);
      }
      .pill {
        font-size: 12px;
        padding: 1px 8px;
        border-radius: 99px;
        background: var(--v-surface-raised);
        color: var(--v-accent);
      }
      .body {
        flex: 1;
        display: grid;
        grid-template-columns: 200px 1fr;
        min-height: 0;
      }
      nav {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 12px 8px;
        background: var(--v-surface);
        border-right: 1px solid color-mix(in srgb, var(--v-text) 8%, transparent);
      }
      nav button {
        text-align: left;
        background: transparent;
        border-color: transparent;
      }
      nav button.active {
        background: var(--v-surface-raised);
        color: var(--v-accent);
      }
      main {
        overflow: auto;
        padding: 20px 28px;
      }
      h1 {
        font-size: 22px;
        font-weight: 600;
        margin: 0 0 8px;
      }
    `,
  ];
}

customElements.define("vellum-shell", VellumShell);
