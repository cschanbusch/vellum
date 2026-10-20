import { LitElement, css, html } from "lit";
import { api, type AppInfo } from "./api";
import { controls, tokens } from "./theme";
import "./pages/plugins-page";
import "./pages/general-page";

interface PageDef {
  id: string;
  label: string;
  /** Phase in which the page gets its real contents; absent = available now. */
  phase?: number;
}

// The settings pages from the spec, in its order.
const PAGES: PageDef[] = [
  { id: "general", label: "General" },
  { id: "library", label: "Library", phase: 2 },
  { id: "plugins", label: "Plugins" },
  { id: "skins", label: "Skins", phase: 3 },
  { id: "views", label: "Views", phase: 3 },
  { id: "controls", label: "Controls", phase: 6 },
  { id: "art", label: "Art and metadata", phase: 4 },
  { id: "developer", label: "Developer", phase: 3 },
];

export class VellumShell extends LitElement {
  static properties = { page: { state: true }, info: { state: true } };
  declare page: string;
  declare info: AppInfo | null;

  constructor() {
    super();
    this.page = "plugins";
    this.info = null;
  }

  connectedCallback() {
    super.connectedCallback();
    api.appInfo().then((info) => (this.info = info));
  }

  render() {
    const current = PAGES.find((p) => p.id === this.page)!;
    return html`
      <header>
        <span class="brand">${this.info?.name ?? "Vellum"}</span>
        <span class="muted">${this.info ? `v${this.info.version}` : ""}</span>
        ${this.info?.portable ? html`<span class="pill">Portable</span>` : null}
        <span class="spacer"></span>
        <span class="muted">Library view arrives in Phase 2 — settings below</span>
      </header>
      <div class="body">
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
      header {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 16px;
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
      .body {
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
