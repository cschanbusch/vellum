// A one-off recommendation at start-up: "Recommended Installation: GRAND TOUR skin", with a
// screenshot of its Garage, what it does, and Install (from the skins catalog, as Settings →
// Get skins does). ✕ closes it until the next start; "Don't ask again" stores the choice
// (UiSettings.dismissedRecommendations). It only appears when the skin isn't there already and
// the catalog can be reached, so Install can work.
import { LitElement, css, html, nothing } from "lit";
import { api, type CatalogPlugin } from "./api";
import garageShot from "./assets/grand-tour-garage.jpg";
import { host } from "./host/instance";
import { RECOMMENDED_SKIN, shouldRecommend } from "./recommend-rules";
import { tokens } from "./theme";
import { toasts } from "./toasts";


export class RecommendDialog extends LitElement {
  static properties = { plugin: { state: true }, state: { state: true }, progress: { state: true } };
  declare plugin: CatalogPlugin | null;
  declare state: "closed" | "offer" | "installing" | "installed";
  declare progress: number | null;
  private unlisten: (() => void) | null = null;

  constructor() {
    super();
    this.plugin = null;
    this.state = "closed";
    this.progress = null;
  }

  /** Looks the skin up in the catalog and offers it if it should be. Never throws. */
  async check() {
    try {
      const catalog = await api.catalogInfo(true);
      const plugin = catalog.plugins.find((p) => p.id === RECOMMENDED_SKIN);
      if (!shouldRecommend(plugin, host.ui.dismissedRecommendations ?? [])) return;
      this.plugin = plugin!;
      this.state = "offer";
    } catch {
      // Offline or no catalog: nothing to offer.
    }
  }

  private close() {
    this.state = "closed";
  }

  private async dontAsk() {
    const id = this.plugin?.id;
    this.close();
    if (!id) return;
    const dismissedRecommendations = [...new Set([...(host.ui.dismissedRecommendations ?? []), id])];
    host.ui = await api.updateUiSettings({ dismissedRecommendations });
  }

  private async install() {
    const p = this.plugin;
    const version = p?.versions.find((v) => !v.unavailable)?.version;
    if (!p || !version) return;
    this.state = "installing";
    this.progress = null;
    const off = await api.onCatalogProgress((e) => {
      if (e.id === p.id && e.total) this.progress = e.done / e.total;
    });
    this.unlisten = off;
    try {
      await api.catalogInstall(p.id, version);
      this.state = "installed";
    } catch (e) {
      this.state = "offer";
      toasts().show(String(e), true);
    } finally {
      off();
      this.unlisten = null;
    }
  }

  private async useNow() {
    const p = this.plugin;
    this.close();
    if (!p) return;
    try {
      await api.activateSkin(p.id);
    } catch (e) {
      toasts().show(String(e), true);
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.unlisten?.();
  }

  render() {
    if (this.state === "closed" || !this.plugin) return nothing;
    const busy = this.state === "installing";
    return html`
      <div class="scrim"></div>
      <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="rec-title">
        <button class="x" aria-label="Close" title="Close" ?disabled=${busy} @click=${() => this.close()}>&#xE8BB;</button>
        <p class="eyebrow">Recommended Installation</p>
        <h2 id="rec-title">GRAND TOUR <span>skin</span></h2>
        <img src=${garageShot} alt="Grand Tour's Garage: a game's case on a turntable beside its spec card" />
        <ul>
          <li><b>A showroom for your games.</b> The Garage puts each game's case on a turntable under studio lights, with a spec card: model year, body type, mileage and condition.</li>
          <li><b>Every start is an ignition.</b> Each game has its own engine, picked by genre, and wears with play. A worn one may stall until you service it.</li>
          <li><b>Polished all the way through.</b> A title screen, menu sounds and adaptive music from its own folder.</li>
        </ul>
        ${this.state === "installed"
          ? html`<p class="done">Grand Tour is installed.</p>
              <div class="actions">
                <button class="primary" @click=${() => this.useNow()}>Use it now</button>
              </div>`
          : html`<div class="actions">
              <button class="primary" ?disabled=${busy} @click=${() => this.install()}>
                ${busy ? (this.progress === null ? "Installing…" : `Installing… ${Math.round(this.progress * 100)}%`) : "Install"}
              </button>
              <button class="danger" ?disabled=${busy} @click=${() => this.dontAsk()}>Don't ask again</button>
            </div>`}
      </section>
    `;
  }

  static styles = [
    tokens,
    css`
      :host {
        position: fixed;
        inset: 0;
        z-index: 50;
        display: grid;
        place-items: center;
        pointer-events: none;
        font-family: var(--v-font-body);
        color: var(--v-text);
      }
      .scrim {
        position: absolute;
        inset: 0;
        background: rgb(0 0 0 / 0.55);
        pointer-events: auto;
      }
      .dialog {
        position: relative;
        width: min(640px, calc(100vw - 48px));
        max-height: calc(100vh - 48px);
        overflow: auto;
        padding: 22px 24px 20px;
        border-radius: 12px;
        background: var(--v-surface);
        box-shadow: 0 24px 60px rgb(0 0 0 / 0.5), 0 0 0 1px rgb(255 255 255 / 0.06);
        pointer-events: auto;
      }
      .x {
        position: absolute;
        top: 10px;
        right: 10px;
        width: 32px;
        height: 32px;
        border: 0;
        border-radius: 6px;
        background: transparent;
        color: var(--v-text-muted);
        font: 12px "Segoe Fluent Icons", "Segoe MDL2 Assets";
        cursor: pointer;
      }
      .x:hover:not(:disabled) {
        background: rgb(255 255 255 / 0.08);
        color: var(--v-text);
      }
      .eyebrow {
        margin: 0 0 2px;
        font-size: 12px;
        font-weight: 600;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: var(--v-text-muted);
      }
      h2 {
        margin: 0 0 14px;
        font-size: 26px;
        font-weight: 700;
        letter-spacing: 0.06em;
      }
      h2 span {
        font-weight: 400;
        letter-spacing: 0;
        color: var(--v-text-muted);
      }
      img {
        display: block;
        width: 100%;
        aspect-ratio: 960 / 541;
        border-radius: 8px;
        box-shadow: 0 0 0 1px rgb(255 255 255 / 0.08);
      }
      ul {
        margin: 14px 0 0;
        padding-left: 18px;
        line-height: 1.45;
        font-size: 14px;
      }
      li + li {
        margin-top: 6px;
      }
      .done {
        margin: 14px 0 0;
        color: var(--v-ok);
      }
      .actions {
        display: flex;
        gap: 10px;
        margin-top: 18px;
      }
      .actions button {
        padding: 9px 18px;
        border: 0;
        border-radius: 8px;
        font: 600 14px var(--v-font-body);
        color: #fff;
        cursor: pointer;
      }
      .actions button:disabled {
        opacity: 0.6;
        cursor: default;
      }
      .primary {
        background: #2f6fe0;
      }
      .primary:hover:not(:disabled) {
        background: #3f7ff0;
      }
      .danger {
        background: #c8352d;
      }
      .danger:hover:not(:disabled) {
        background: #d8453d;
      }
      button:focus-visible {
        outline: 2px solid var(--v-focus-ring);
        outline-offset: 2px;
      }
    `,
  ];
}

customElements.define("vellum-recommend", RecommendDialog);
