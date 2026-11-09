// Settings -> Library: what happens to duplicates, store priority, and hand-added games.
import { LitElement, css, html, nothing } from "lit";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { api, type CustomGame, type LibrarySettings, type PluginView } from "../api";
import { controls, tokens } from "../theme";

/** Every provider in priority order: listed ones first, the rest after by name. */
export function orderProviders(providers: PluginView[], priority: string[]): PluginView[] {
  const rank = (id: string) => {
    const i = priority.indexOf(id);
    return i < 0 ? priority.length : i;
  };
  return [...providers].sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name));
}

export class LibraryPage extends LitElement {
  static properties = {
    games: { state: true },
    enabled: { state: true },
    settings: { state: true },
    providers: { state: true },
    error: { state: true },
  };
  declare games: CustomGame[];
  declare enabled: boolean;
  declare settings: LibrarySettings | null;
  declare providers: PluginView[];
  declare error: string | null;
  /** Opens the shell's dialog; undefined game means adding. */
  editGame: (game?: CustomGame) => Promise<unknown> = async () => {};
  /** Opens the shell's duplicates dialog with every duplicate. */
  reviewDuplicates: () => Promise<number> = async () => 0;
  private unlisten?: Promise<UnlistenFn>;
  private noDuplicates = false;

  constructor() {
    super();
    this.games = [];
    this.enabled = true;
    this.settings = null;
    this.providers = [];
    this.error = null;
  }

  connectedCallback() {
    super.connectedCallback();
    void this.refresh();
    this.unlisten = api.onPluginsChanged(() => void this.refresh());
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.unlisten?.then((f) => f());
  }

  private async refresh() {
    try {
      const [games, plugins, settings] = await Promise.all([api.customGames(), api.listPlugins(), api.librarySettings()]);
      this.games = games;
      this.settings = settings;
      const providers = plugins.filter((p) => p.kind === "provider" && p.status !== "error");
      this.providers = providers;
      this.enabled = !!providers.find((p) => p.id === "custom")?.enabled;
    } catch (e) {
      this.error = String(e);
    }
  }

  private async edit(game?: CustomGame) {
    await this.editGame(game);
    await this.refresh();
  }

  private async change(patch: Partial<LibrarySettings>) {
    try {
      this.error = null;
      this.settings = await api.setLibrarySettings(patch);
    } catch (e) {
      this.error = String(e);
    }
  }

  private move(ordered: PluginView[], i: number, by: number) {
    const ids = ordered.map((p) => p.id);
    [ids[i], ids[i + by]] = [ids[i + by], ids[i]];
    void this.change({ providerPriority: ids });
  }

  private async review() {
    const shown = await this.reviewDuplicates();
    this.noDuplicates = shown === 0;
    this.requestUpdate();
  }

  private renderDuplicates() {
    const s = this.settings;
    if (!s) return nothing;
    const ordered = orderProviders(this.providers, s.providerPriority);
    return html`<section>
      <div class="head">
        <h2>Games on more than one store</h2>
        <span class="spacer"></span>
        <button class="review" @click=${() => this.review()}>Review duplicates…</button>
      </div>
      ${this.noDuplicates ? html`<p class="muted">No game is on more than one store right now.</p>` : nothing}
      <label for="on-dup">When a duplicate is found</label>
      <select id="on-dup" .value=${s.onDuplicate} @change=${(e: Event) => this.change({ onDuplicate: (e.target as HTMLSelectElement).value as LibrarySettings["onDuplicate"] })}>
        <option value="ask" ?selected=${s.onDuplicate === "ask"}>Ask me</option>
        <option value="merge" ?selected=${s.onDuplicate === "merge"}>Make one entry, using the store priority below</option>
        <option value="separate" ?selected=${s.onDuplicate === "separate"}>Keep them as separate entries</option>
      </select>
      <div class="label">Store priority</div>
      <p class="muted">The first store listed is suggested when you're asked, and used when duplicates merge by themselves.</p>
      <ol class="stores">
        ${ordered.map(
          (p, i) => html`<li data-provider=${p.id}>
            <span class="name">${p.name}</span>
            ${p.enabled ? nothing : html`<span class="muted small">Off</span>`}
            <button aria-label="Move ${p.name} up" ?disabled=${i === 0} @click=${() => this.move(ordered, i, -1)}>↑</button>
            <button aria-label="Move ${p.name} down" ?disabled=${i === ordered.length - 1} @click=${() => this.move(ordered, i, 1)}>↓</button>
          </li>`,
        )}
      </ol>
    </section>`;
  }

  render() {
    return html`
      <h1>Library</h1>
      ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing} ${this.renderDuplicates()}
      <section>
        <div class="head">
          <h2>Custom games</h2>
          <span class="spacer"></span>
          <button class="primary add" ?disabled=${!this.enabled} @click=${() => this.edit()}>Add game…</button>
        </div>
        <p class="muted">Emulators, standalone programs and shortcuts that no store knows about.</p>
        ${this.enabled ? nothing : html`<p class="muted">The Custom games provider is turned off in Settings → Plugins, so these games aren't shown.</p>`}
        ${this.games.length
          ? html`<ul>
              ${this.games.map(
                (g) => html`<li>
                  <div class="info">
                    <strong>${g.title}</strong>
                    <div class="muted small path">${g.exe}</div>
                  </div>
                  <button @click=${() => this.edit(g)}>Edit…</button>
                </li>`,
              )}
            </ul>`
          : nothing}
      </section>
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
        font-size: 16px;
        font-weight: 600;
        margin: 0;
      }
      section {
        margin-bottom: 28px;
      }
      .head {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .spacer {
        flex: 1;
      }
      .muted {
        color: var(--v-text-muted);
      }
      .small {
        font-size: 12px;
      }
      p {
        margin: 6px 0 12px;
      }
      label,
      .label {
        display: block;
        margin: 14px 0 4px;
        font-size: 13px;
      }
      select {
        max-width: 100%;
        padding: 6px 8px;
        font: inherit;
        color: inherit;
        background: var(--v-surface-raised);
        border: 1px solid #2b3246;
        border-radius: var(--v-radius);
      }
      select:focus-visible {
        outline: 2px solid var(--v-focus-ring);
        outline-offset: 2px;
      }
      ul,
      ol {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      li {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 10px 14px;
        margin-bottom: 8px;
        background: var(--v-surface);
        border-radius: var(--v-radius);
      }
      .stores li {
        gap: 6px;
        padding: 6px 8px 6px 14px;
        margin-bottom: 4px;
      }
      .stores .name {
        flex: 1;
      }
      .stores button {
        padding: 2px 10px;
      }
      .info {
        flex: 1;
        min-width: 0;
      }
      .path {
        overflow-wrap: anywhere;
      }
      .error {
        background: color-mix(in srgb, var(--v-danger) 15%, transparent);
        color: var(--v-danger);
        padding: 8px 12px;
        border-radius: var(--v-radius);
      }
    `,
  ];
}

customElements.define("vellum-library-page", LibraryPage);
