import { LitElement, css, html } from "lit";
import { api, type AppInfo } from "../api";
import { controls, tokens } from "../theme";

export class GeneralPage extends LitElement {
  static properties = { info: { attribute: false } };
  declare info: AppInfo | null;

  constructor() {
    super();
    this.info = null;
  }

  render() {
    const i = this.info;
    if (!i) return html`<p class="muted">Loading…</p>`;
    return html`
      <h1>General</h1>
      <section>
        <h2>Data folder</h2>
        <p><code>${i.dataDir}</code></p>
        <p class="muted">
          ${i.portable
            ? "Portable mode is on: portable.flag exists beside Vellum.exe, so all data is stored in the data folder next to it."
            : "Data is stored in your Windows profile. Create an empty portable.flag file beside Vellum.exe to keep data next to the program instead."}
        </p>
        <button @click=${() => api.openDataFolder()}>Open data folder</button>
      </section>
      <section>
        <h2>About</h2>
        <p>${i.name} ${i.version} · plugin API version ${i.apiVersion}</p>
      </section>
      <p class="muted">Start-up view, couch mode, and launch behaviour settings arrive with the features they control.</p>
    `;
  }

  static styles = [
    tokens,
    controls,
    css`
      h1 {
        font-size: 22px;
        font-weight: 600;
        margin: 0 0 16px;
      }
      h2 {
        font-size: 15px;
        margin: 0 0 6px;
      }
      section {
        background: var(--v-surface);
        border-radius: var(--v-radius);
        padding: 14px 16px;
        margin-bottom: 14px;
      }
      code {
        font-family: ui-monospace, "Cascadia Mono", monospace;
        font-size: 13px;
        word-break: break-all;
      }
      .muted {
        color: var(--v-text-muted);
      }
    `,
  ];
}

customElements.define("vellum-general-page", GeneralPage);
