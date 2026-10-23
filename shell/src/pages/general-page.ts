import { LitElement, css, html } from "lit";
import { api, type AppInfo } from "../api";
import { host } from "../host/instance";
import { controls, tokens } from "../theme";

export class GeneralPage extends LitElement {
  static properties = { info: { attribute: false } };
  declare info: AppInfo | null;

  constructor() {
    super();
    this.info = null;
  }

  private volume(e: Event, preview: boolean) {
    void host.setMusicVolume(Number((e.target as HTMLInputElement).value) / 100, preview);
    this.requestUpdate();
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
            ? "Portable mode is on: portable.flag exists beside Vellum Game Launcher.exe, so all data is stored in the data folder next to it."
            : "Data is stored in your Windows profile. Create an empty portable.flag file beside Vellum Game Launcher.exe to keep data next to the program instead."}
        </p>
        <button @click=${() => api.openDataFolder()}>Open data folder</button>
      </section>
      <section>
        <h2>Sound</h2>
        <label class="row">
          <span>Music volume</span>
          <input
            type="range"
            min="0"
            max="100"
            step="1"
            .value=${String(Math.round((host.ui.musicVolume ?? 0.7) * 100))}
            @input=${(e: Event) => this.volume(e, true)}
            @change=${(e: Event) => this.volume(e, false)}
          />
          <output>${Math.round((host.ui.musicVolume ?? 0.7) * 100)}%</output>
        </label>
        <p class="muted">For skins that play music. It plays only while Vellum's window is in front, and pauses while you're in a game or another window.</p>
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
      .row {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 6px;
      }
      .row input {
        flex: 1;
        max-width: 280px;
      }
      output {
        min-width: 3em;
        font-variant-numeric: tabular-nums;
      }
    `,
  ];
}

customElements.define("vellum-general-page", GeneralPage);
