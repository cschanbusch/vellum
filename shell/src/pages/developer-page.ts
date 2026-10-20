// Settings → Developer: developer mode (skin file watching, live CSS, error overlay, DevTools),
// logs, and the diagnostics report.
import { LitElement, css, html, nothing } from "lit";
import { api } from "../api";
import { host } from "../host/instance";
import { toasts } from "../toasts";
import { controls, tokens } from "../theme";
import { pageStyles } from "./page-styles";

export class DeveloperPage extends LitElement {
  static properties = { report: { state: true }, busy: { state: true } };
  declare report: string | null;
  declare busy: boolean;
  private unsub?: () => void;

  constructor() {
    super();
    this.report = null;
    this.busy = false;
  }

  connectedCallback() {
    super.connectedCallback();
    this.unsub = host.on("skin", () => this.requestUpdate());
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.unsub?.();
  }

  private async setDev(on: boolean) {
    host.ui = await api.updateUiSettings({ devMode: on });
    this.requestUpdate();
  }

  private async diagnose() {
    this.busy = true;
    try {
      this.report = await api.runDiagnostics();
    } catch (e) {
      toasts().show(String(e), true);
    } finally {
      this.busy = false;
    }
  }

  render() {
    const dev = host.skin?.dev ?? host.ui.devMode;
    const forced = dev && !host.ui.devMode;
    return html`
      <h1>Developer</h1>
      <section>
        <div class="row">
          <label for="dev">
            <strong>Developer mode</strong>
            <div class="muted small">
              Watches the active skin's folder: CSS changes apply without a reload, other changes reload the skin and
              keep your place. Shows skin errors on screen and enables DevTools (Ctrl+Shift+I).
            </div>
          </label>
          <input id="dev" type="checkbox" .checked=${dev} ?disabled=${forced} @change=${(e: Event) => this.setDev((e.target as HTMLInputElement).checked)} />
        </div>
        ${forced ? html`<p class="muted small">On for this run because Vellum was started with --dev.</p>` : nothing}
        <div class="row">
          <span class="label">DevTools for the shell and the skin</span>
          <button ?disabled=${!dev} @click=${() => api.openDevtools().catch((e) => toasts().show(String(e), true))}>Open DevTools</button>
        </div>
        <div class="row">
          <span class="label">Reload the skin (state is kept)</span>
          <button @click=${() => host.reloadSkinPage()}>Reload skin</button>
        </div>
      </section>
      <section>
        <div class="row">
          <span class="label">Rolling logs, kept for 7 days</span>
          <button @click=${() => api.openLogsFolder()}>Open logs folder</button>
        </div>
        <div class="row">
          <span class="label">
            Diagnostics report
            <div class="muted small">Structure only: file names become patterns, account folders become &lt;account-n&gt;, no values. Review it before sharing.</div>
          </span>
          <button ?disabled=${this.busy} @click=${() => this.diagnose()}>${this.busy ? "Running…" : "Run diagnostics"}</button>
        </div>
        ${this.report ? html`<p class="small">Report written to <code>${this.report}</code></p>` : nothing}
      </section>
    `;
  }

  static styles = [
    tokens,
    controls,
    pageStyles,
    css`
      label {
        cursor: pointer;
      }
    `,
  ];
}

customElements.define("vellum-developer-page", DeveloperPage);
