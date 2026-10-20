import { LitElement, css, html, nothing } from "lit";
import { api, browseForLocation } from "./api";
import { SKIN_ORIGIN, host } from "./host/instance";
import { store } from "./store";
import { controls, tokens } from "./theme";

/** Hosts the active skin in a sandboxed iframe, plus the shell's notice bar. */
export class LibraryView extends LitElement {
  static properties = { notices: { state: true }, noticeErrors: { state: true } };
  declare notices: typeof store.notices;
  declare noticeErrors: Record<string, string>;
  private unsub?: () => void;

  constructor() {
    super();
    this.notices = [];
    this.noticeErrors = {};
  }

  connectedCallback() {
    super.connectedCallback();
    this.unsub = store.on("providers", () => (this.notices = store.notices));
    this.notices = store.notices;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.unsub?.();
    host.detach();
  }

  /** Called once the host has loaded state, so the skin's hello gets a full init. */
  attachSkin() {
    const frame = this.renderRoot.querySelector("iframe")!;
    host.attach(frame, SKIN_ORIGIN, `${SKIN_ORIGIN}/index.html`);
  }

  get frame(): HTMLIFrameElement | null {
    return this.renderRoot.querySelector("iframe");
  }

  focusSkin() {
    this.frame?.focus();
  }

  private async browse(n: (typeof store.notices)[number]) {
    const error = await browseForLocation(n.provider, n.key, n.label);
    this.noticeErrors = { ...this.noticeErrors, [n.id]: error ?? "" };
  }

  render() {
    return html`
      ${this.notices.length
        ? html`<div class="notices">
            ${this.notices.map(
              (n) => html`<div class="notice" role="alert">
                <span class="msg">${n.message}.</span>
                ${this.noticeErrors[n.id] ? html`<span class="err">${this.noticeErrors[n.id]}</span>` : nothing}
                <span class="spacer"></span>
                <button class="primary" @click=${() => this.browse(n)}>Browse…</button>
                <button @click=${() => api.dismissNotice(n.id)}>Skip for now</button>
                <button @click=${() => api.setPluginEnabled("provider", n.provider, false)}>Disable ${n.providerName}</button>
              </div>`,
            )}
          </div>`
        : nothing}
      <iframe sandbox="allow-scripts allow-same-origin" title="Library"></iframe>
    `;
  }

  static styles = [
    tokens,
    controls,
    css`
      :host {
        display: flex;
        flex-direction: column;
        min-height: 0;
        flex: 1;
      }
      iframe {
        flex: 1;
        width: 100%;
        border: 0;
        background: var(--v-bg);
      }
      .notices {
        display: flex;
        flex-direction: column;
        gap: 1px;
      }
      .notice {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 16px;
        background: color-mix(in srgb, var(--v-warning) 14%, var(--v-surface));
        font: 14px var(--v-font-body);
        color: var(--v-text);
      }
      .err {
        color: var(--v-danger);
      }
      .spacer {
        flex: 1;
      }
    `,
  ];
}

customElements.define("vellum-library-view", LibraryView);
