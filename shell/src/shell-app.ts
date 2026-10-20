import { LitElement, css, html } from "lit";
import { api, type AppInfo } from "./api";
import { store } from "./store";
import { controls, tokens } from "./theme";
import { registerToasts, type ToastHost } from "./toasts";
import "./library-view";
import "./pages/plugins-page";
import "./pages/general-page";
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
  { id: "skins", label: "Skins", phase: 3 },
  { id: "views", label: "Views", phase: 3 },
  { id: "controls", label: "Controls", phase: 6 },
  { id: "art", label: "Art and metadata", phase: 4 },
  { id: "developer", label: "Developer", phase: 3 },
];

export class VellumShell extends LitElement {
  static properties = {
    page: { state: true },
    info: { state: true },
    settingsOpen: { state: true },
    scanning: { state: true },
  };
  declare page: string;
  declare info: AppInfo | null;
  declare settingsOpen: boolean;
  declare scanning: boolean;
  private onKey = (e: KeyboardEvent) => this.hotkey(e);

  constructor() {
    super();
    this.page = "plugins";
    this.info = null;
    this.settingsOpen = false;
    this.scanning = false;
  }

  connectedCallback() {
    super.connectedCallback();
    api.appInfo().then((info) => (this.info = info));
    store.on("providers", () => (this.scanning = store.statuses.some((s) => s.state === "scanning")));
    store.start();
    window.addEventListener("keydown", this.onKey);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("keydown", this.onKey);
  }

  firstUpdated() {
    registerToasts(this.renderRoot.querySelector("vellum-toasts") as ToastHost);
  }

  private hotkey(e: KeyboardEvent) {
    if (e.ctrlKey && e.key.toLowerCase() === "r") {
      e.preventDefault();
      api.refreshLibrary();
    } else if (e.key === "Escape" && this.settingsOpen) {
      this.settingsOpen = false;
    }
  }

  render() {
    const current = PAGES.find((p) => p.id === this.page)!;
    return html`
      <header>
        <span class="brand">${this.info?.name ?? "Vellum"}</span>
        ${this.info?.portable ? html`<span class="pill">Portable</span>` : null}
        <span class="spacer"></span>
        ${this.scanning ? html`<span class="muted">Scanning…</span>` : null}
        <button title="Refresh library (Ctrl+R)" @click=${() => api.refreshLibrary()}>Refresh</button>
        <button
          class=${this.settingsOpen ? "primary" : ""}
          aria-pressed=${this.settingsOpen}
          @click=${() => (this.settingsOpen = !this.settingsOpen)}
        >
          ${this.settingsOpen ? "Back to library" : "Settings"}
        </button>
      </header>
      <!-- The library stays mounted while settings are open, so the skin keeps its place. -->
      <vellum-library-view ?hidden=${this.settingsOpen}></vellum-library-view>
      <div class="settings" ?hidden=${!this.settingsOpen}>
        <nav aria-label="Settings">
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
        <main>${this.renderPage(current)}</main>
      </div>
      <vellum-toasts></vellum-toasts>
    `;
  }

  private renderPage(p: PageDef) {
    if (p.id === "plugins") return html`<vellum-plugins-page></vellum-plugins-page>`;
    if (p.id === "general") return html`<vellum-general-page .info=${this.info}></vellum-general-page>`;
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
      header {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 16px;
        background: var(--v-surface);
        border-bottom: 1px solid #222838;
      }
      .brand {
        font-weight: 650;
        font-size: 16px;
        letter-spacing: 0.02em;
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
      .settings {
        flex: 1;
        display: grid;
        grid-template-columns: 220px 1fr;
        min-height: 0;
      }
      nav {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 12px 8px;
        background: var(--v-surface);
        border-right: 1px solid #222838;
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
