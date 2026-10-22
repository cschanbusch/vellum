import { LitElement, css, html } from "lit";
import { api, type AppInfo } from "./api";
import { entryMenu } from "./host/entry-menu";
import { host, hostUi } from "./host/instance";
import type { LibraryView } from "./library-view";
import type { ContextMenu, DevErrorOverlay, TagsDialog } from "./overlays";
import { store } from "./store";
import { applySkinTheme, controls, tokens } from "./theme";
import { registerToasts, toasts, type ToastHost } from "./toasts";
import type { Entry } from "../../sdk/src/types";
import { facets } from "../../sdk/src/query";
import "./library-view";
import "./overlays";
import "./pages/plugins-page";
import "./pages/general-page";
import "./pages/skins-page";
import "./pages/views-page";
import "./pages/developer-page";
import "./pages/versions-page";
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
  { id: "library", label: "Library", phase: 5 },
  { id: "plugins", label: "Plugins" },
  { id: "skins", label: "Skins" },
  { id: "views", label: "Views" },
  { id: "controls", label: "Controls", phase: 6 },
  { id: "art", label: "Art and metadata", phase: 4 },
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
  private get devError() {
    return this.renderRoot.querySelector<DevErrorOverlay>("vellum-dev-error")!;
  }

  async firstUpdated() {
    registerToasts(this.renderRoot.querySelector("vellum-toasts") as ToastHost);
    this.menu.hidden = true;
    Object.assign(hostUi, {
      toast: (text: string, error = false) => toasts().show(text, error),
      contextMenu: (entry: Entry, x: number, y: number) => this.openMenu(entry, x, y),
      openSettings: (page?: string) => this.openSettings(page),
      changeArt: () => toasts().show("Choosing art arrives with the remote art update. Custom Steam grid art is picked up already."),
      theme: (t: Record<string, string>) => applySkinTheme(t),
      devError: (message: string, stack: string) => {
        console.error(`[skin] ${message}\n${stack}`);
        if (host.skin?.dev) this.devError.show(message, stack);
      },
      skinFailed: (reason: string) => this.skinFailed(reason),
    });
    host.on("skin", () => {
      this.requestUpdate(); // frameless skins get window controls in the settings header
      this.devError?.clear();
      if (host.skin?.fallbackFrom) toasts().show(`The ${host.skin.fallbackFrom} skin couldn't load, so ${host.skin.name} is shown instead.`, true);
    });
    await host.start();
    this.library.attachSkin();
  }

  private async skinFailed(reason: string) {
    const failed = host.skin;
    if (!failed || failed.id === "basis" || failed.fallbackFrom) {
      toasts().show(`The skin couldn't load: ${reason}`, true);
      return;
    }
    await api.useFallbackSkin(reason);
  }

  private openMenu(entry: Entry, x: number, y: number) {
    const r = this.library.frame?.getBoundingClientRect();
    const items = entryMenu(host, entry, {
      editTags: (e) => void this.editTags(e),
      changeArt: (e) => hostUi.changeArt(e, "cover"),
    });
    this.menu.open(entry.title, items, x + (r?.left ?? 0), y + (r?.top ?? 0), () => {
      if (!this.settingsOpen && !this.tags.entry) this.library.focusSkin();
    });
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
      <vellum-dev-error></vellum-dev-error>
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
      case "versions":
        return html`<vellum-versions-page></vellum-versions-page>`;
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
