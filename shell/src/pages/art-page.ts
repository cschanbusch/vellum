// Settings → Art and metadata: store downloads, Steam store details, SteamGridDB, and how
// long misses and details are kept before Vellum asks again.
import { LitElement, css, html, nothing } from "lit";
import { api, type ArtSettings, type ArtSettingsView } from "../api";
import { toasts } from "../toasts";
import { controls, tokens } from "../theme";
import { pageStyles } from "./page-styles";

const RETRY_CHOICES: [number, string][] = [
  [1, "1 day"],
  [7, "7 days"],
  [30, "30 days"],
  [0, "Never"],
];
const REFRESH_CHOICES: [number, string][] = [
  [7, "7 days"],
  [30, "30 days"],
  [90, "90 days"],
  [0, "Never"],
];

function megabytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(bytes < 100 * 1024 * 1024 ? 1 : 0)} MB`;
}

export class ArtPage extends LitElement {
  static properties = { view: { state: true }, busy: { state: true }, keyError: { state: true } };
  declare view: ArtSettingsView | null;
  declare busy: string | null;
  declare keyError: string | null;
  private timer = 0;

  constructor() {
    super();
    this.view = null;
    this.busy = null;
    this.keyError = null;
  }

  connectedCallback() {
    super.connectedCallback();
    void this.load();
    // Counts move while downloads run; keep them current while the page is open.
    this.timer = window.setInterval(() => void this.load(), 2000);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.clearInterval(this.timer);
  }

  private async load() {
    try {
      this.view = await api.artSettings();
    } catch (e) {
      toasts().show(String(e), true);
    }
  }

  private async set(patch: Partial<ArtSettings>) {
    try {
      this.view = await api.setArtSettings(patch);
    } catch (e) {
      toasts().show(String(e), true);
    }
  }

  private async saveKey() {
    const input = this.renderRoot.querySelector<HTMLInputElement>("#sgdb-key");
    const key = input?.value.trim() ?? "";
    if (!key) return;
    this.busy = "key";
    this.keyError = null;
    try {
      this.view = await api.setSteamGridDbKey(key);
      if (input) input.value = "";
      toasts().show("SteamGridDB key saved. Missing art will be looked up there.");
    } catch (e) {
      this.keyError = String(e);
    } finally {
      this.busy = null;
    }
  }

  private async removeKey() {
    this.busy = "key";
    try {
      this.view = await api.setSteamGridDbKey(null);
      toasts().show("SteamGridDB key removed.");
    } catch (e) {
      toasts().show(String(e), true);
    } finally {
      this.busy = null;
    }
  }

  private async retry() {
    this.busy = "retry";
    try {
      const n = await api.retryMissingArt();
      toasts().show(n ? `Looking again for ${n} missing image${n === 1 ? "" : "s"}.` : "Nothing was recorded as missing; checking for new art anyway.");
      await this.load();
    } finally {
      this.busy = null;
    }
  }

  private async refresh() {
    this.busy = "refresh";
    try {
      const n = await api.refreshDetailsNow();
      const minutes = Math.ceil((n * 1.5) / 60);
      toasts().show(n ? `Refreshing details for ${n} Steam game${n === 1 ? "" : "s"} (about ${minutes} minute${minutes === 1 ? "" : "s"}).` : "There are no Steam games to refresh.");
      await this.load();
    } finally {
      this.busy = null;
    }
  }

  private select(value: number, choices: [number, string][], onChange: (v: number) => void) {
    return html`<select @change=${(e: Event) => onChange(Number((e.target as HTMLSelectElement).value))}>
      ${choices.map(([v, label]) => html`<option value=${v} ?selected=${v === value}>${label}</option>`)}
    </select>`;
  }

  render() {
    const v = this.view;
    if (!v) return html`<h1>Art and metadata</h1><p class="muted">Loading…</p>`;
    const s = v.settings;
    const st = v.stats;
    const queued = st.queuedDownloads + st.queuedLookups + st.queuedDetails;
    return html`
      <h1>Art and metadata</h1>
      <p class="muted">
        Vellum uses the art your stores keep on this PC first. What's missing can be downloaded from the internet. Everything
        downloaded is kept, so the library still looks complete offline.
      </p>

      <section>
        <h2>Downloads</h2>
        <div class="row">
          <label for="store-art">Download art from store servers</label>
          <input id="store-art" type="checkbox" .checked=${s.storeArt} @change=${(e: Event) => this.set({ storeArt: (e.target as HTMLInputElement).checked })} />
        </div>
        <p class="muted small">
          Covers, heroes, logos and headers from Steam's image servers, for games Steam hasn't stored on this PC. Each request
          names only the game's Steam app ID.
        </p>
        <div class="row">
          <label for="details">Fetch game details from Steam</label>
          <input id="details" type="checkbox" .checked=${s.fetchDetails} @change=${(e: Event) => this.set({ fetchDetails: (e.target as HTMLInputElement).checked })} />
        </div>
        <p class="muted small">
          Developer, publisher, release date, genres and a short description from the Steam store, one game every 1.5 seconds
          in the background. Details Steam keeps on this PC always come first.
        </p>
      </section>

      <section>
        <h2>SteamGridDB</h2>
        <p class="muted small">
          SteamGridDB is a community collection of game art, including games that aren't on Steam. Vellum uses it for art
          that's still missing, and the Change art dialog shows its choices. It needs your own free API key: sign in at
          steamgriddb.com, then open Preferences → API. The key is kept in Windows Credential Manager, not in Vellum's data
          folder. Lookups send the game's Steam app ID, or its title for other games.
        </p>
        ${v.steamgriddbKey
          ? html`<div class="row">
              <span class="label">
                ${v.steamgriddbRejected
                  ? html`<span class="error">SteamGridDB refused the saved key. Enter a new one.</span>`
                  : html`A key is saved. SteamGridDB is on.`}
              </span>
              <button ?disabled=${this.busy === "key"} @click=${() => this.removeKey()}>Remove key</button>
            </div>`
          : nothing}
        ${!v.steamgriddbKey || v.steamgriddbRejected
          ? html`<div class="row">
              <input
                id="sgdb-key"
                type="password"
                autocomplete="off"
                spellcheck="false"
                placeholder="SteamGridDB API key"
                aria-label="SteamGridDB API key"
                @keydown=${(e: KeyboardEvent) => e.key === "Enter" && void this.saveKey()}
              />
              <button class="primary" ?disabled=${this.busy === "key"} @click=${() => this.saveKey()}>${this.busy === "key" ? "Checking…" : "Save key"}</button>
            </div>`
          : nothing}
        ${this.keyError ? html`<p class="error small">${this.keyError}</p>` : nothing}
      </section>

      <section>
        <h2>Checking again</h2>
        <div class="row">
          <span class="label">Retry missing art after</span>
          ${this.select(s.retryMissingDays, RETRY_CHOICES, (d) => this.set({ retryMissingDays: d }))}
          <button ?disabled=${this.busy === "retry"} @click=${() => this.retry()}>Retry missing art now</button>
        </div>
        <p class="muted small">
          When an image isn't on a server, Vellum remembers that and doesn't ask again until this time has passed. A failed
          connection doesn't count as missing.
        </p>
        <div class="row">
          <span class="label">Refresh Steam game details every</span>
          ${this.select(s.refreshDetailsDays, REFRESH_CHOICES, (d) => this.set({ refreshDetailsDays: d }))}
          <button ?disabled=${this.busy === "refresh" || !s.fetchDetails} @click=${() => this.refresh()}>Refresh details now</button>
        </div>
        <p class="muted small">Details past this age stay in use until a refresh succeeds. Downloaded art never expires.</p>
      </section>

      <section>
        <h2>Cache</h2>
        <p>
          ${st.images} image${st.images === 1 ? "" : "s"} downloaded (${megabytes(st.bytes)}) · ${st.misses} recorded as
          missing · details for ${st.details} game${st.details === 1 ? "" : "s"}
        </p>
        <p class="muted small">
          ${queued
            ? [
                st.queuedDownloads ? `${st.queuedDownloads} to download` : "",
                st.queuedLookups ? `${st.queuedLookups} to look up on SteamGridDB` : "",
                st.queuedDetails ? `${st.queuedDetails} details to fetch` : "",
              ]
                .filter(Boolean)
                .join(" · ")
            : "Nothing waiting."}
        </p>
      </section>
    `;
  }

  static styles = [
    tokens,
    controls,
    pageStyles,
    css`
      section > p.small {
        margin: 0 0 10px;
      }
      input[type="password"] {
        flex: 1;
        font: inherit;
        color: var(--v-text);
        background: var(--v-surface-raised);
        border: 1px solid #2b3246;
        border-radius: var(--v-radius);
        padding: 5px 8px;
      }
    `,
  ];
}

customElements.define("vellum-art-page", ArtPage);
