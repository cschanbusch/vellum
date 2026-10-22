// Settings → Get skins: the plugin catalog (src-tauri/src/catalog.rs). Skins published outside
// Vellum's own releases, each with its versions: download one, update it, go back to an older
// version, or remove it. Downloads go to the user's plugins folder and work without a restart.
import { LitElement, css, html, nothing } from "lit";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { api, type CatalogPlugin, type CatalogView } from "../api";
import { toasts } from "../toasts";
import { controls, tokens } from "../theme";
import { pageStyles } from "./page-styles";

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "");

export class CatalogPage extends LitElement {
  static properties = {
    view: { state: true },
    loading: { state: true },
    busy: { state: true },
    progress: { state: true },
    chosen: { state: true },
    previews: { state: true },
    confirming: { state: true },
  };
  declare view: CatalogView | null;
  declare loading: boolean;
  /** Plugin id being installed or removed. */
  declare busy: string | null;
  declare progress: { id: string; done: number; total: number } | null;
  /** The version picked in each plugin's list (default: newest usable). */
  declare chosen: Record<string, string>;
  declare previews: Record<string, string>;
  declare confirming: string | null;
  private unlisten?: Promise<UnlistenFn>;
  private static fetched = false;

  constructor() {
    super();
    this.view = null;
    this.loading = false;
    this.busy = null;
    this.progress = null;
    this.chosen = {};
    this.previews = {};
    this.confirming = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this.unlisten = api.onCatalogProgress((p) => (this.progress = p));
    void this.refresh(!CatalogPage.fetched);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    void this.unlisten?.then((u) => u());
  }

  private async refresh(fetch: boolean) {
    this.loading = fetch;
    try {
      this.view = await api.catalogInfo(fetch);
      if (!this.view.error) CatalogPage.fetched = true;
      for (const p of this.view.plugins) {
        if (p.preview && !this.previews[p.id]) {
          api.catalogPreview(p.preview).then(
            (url) => (this.previews = { ...this.previews, [p.id]: url }),
            () => {},
          );
        }
      }
    } catch (e) {
      toasts().show(String(e), true);
    } finally {
      this.loading = false;
    }
  }

  private newest(p: CatalogPlugin) {
    return p.versions.find((v) => !v.unavailable) ?? null;
  }

  private async install(p: CatalogPlugin, version: string) {
    this.busy = p.id;
    this.progress = null;
    try {
      await api.catalogInstall(p.id, version);
      toasts().show(`${p.name} ${version} is installed.${p.kind === "skin" ? " Activate it in Skins." : ""}`);
    } catch (e) {
      toasts().show(String(e), true);
    } finally {
      this.busy = null;
      this.progress = null;
      await this.refresh(false);
    }
  }

  private async removePlugin(p: CatalogPlugin) {
    if (this.confirming !== p.id) {
      this.confirming = p.id;
      return;
    }
    this.confirming = null;
    this.busy = p.id;
    try {
      await api.catalogRemove(p.kind, p.id);
      toasts().show(`Removed ${p.name}.`);
    } catch (e) {
      toasts().show(String(e), true);
    } finally {
      this.busy = null;
      await this.refresh(false);
    }
  }

  private async activate(p: CatalogPlugin) {
    try {
      await api.activateSkin(p.id);
    } catch (e) {
      toasts().show(String(e), true);
    }
  }

  private renderPlugin(p: CatalogPlugin) {
    const newest = this.newest(p);
    const pick = this.chosen[p.id] ?? p.installed ?? newest?.version ?? p.versions[0]?.version ?? "";
    const v = p.versions.find((x) => x.version === pick);
    const mine = this.busy === p.id;
    const pct = mine && this.progress?.id === p.id && this.progress.total ? Math.round((this.progress.done / this.progress.total) * 100) : null;
    const update = p.installed && newest && newest.version !== p.installed && p.versions.findIndex((x) => x.version === newest.version) < p.versions.findIndex((x) => x.version === p.installed);
    let action = "Download";
    if (p.installed === pick) action = "Download again";
    else if (p.installed) action = update && pick === newest?.version ? "Update" : "Switch to this version";
    return html`<article>
      <div class="preview">${this.previews[p.id] ? html`<img src=${this.previews[p.id]} alt="" />` : html`<span class="muted small">No preview</span>`}</div>
      <div class="meta">
        <div>
          <strong>${p.name}</strong>
          ${p.installed ? html`<span class="pill accent">Installed ${p.installed}</span>` : nothing}
          ${update ? html`<span class="pill warn">Update: ${newest!.version}</span>` : nothing}
          ${p.present ? html`<span class="pill">Included with Vellum${p.present ? ` (${p.present})` : ""}</span>` : nothing}
        </div>
        <div class="muted small">${p.description}</div>
        <div class="muted small">${[p.author, p.license ? `Licence: ${p.license}` : null].filter(Boolean).join(" · ")}</div>
        <div class="row">
          <label class="small" for=${`v-${p.id}`}>Version</label>
          <select id=${`v-${p.id}`} .value=${pick} ?disabled=${!!this.busy} @change=${(e: Event) => (this.chosen = { ...this.chosen, [p.id]: (e.target as HTMLSelectElement).value })}>
            ${p.versions.map(
              (x) => html`<option value=${x.version} ?selected=${x.version === pick} ?disabled=${!!x.unavailable}>
                ${x.version}${x === newest ? " (newest)" : ""}${x.version === p.installed ? " (installed)" : ""}${x.unavailable ? ` — ${x.unavailable}` : ""}
              </option>`,
            )}
          </select>
          <button class="primary" ?disabled=${!!this.busy || !v || !!v.unavailable} @click=${() => v && this.install(p, v.version)}>
            ${mine && !this.confirming ? "Downloading…" : action}
          </button>
          ${p.installed && p.kind === "skin" ? html`<button ?disabled=${!!this.busy} @click=${() => this.activate(p)}>Activate</button>` : nothing}
          ${p.installed
            ? html`<button class="danger" ?disabled=${!!this.busy} @click=${() => this.removePlugin(p)}>
                ${this.confirming === p.id ? "Click again to remove" : "Remove"}
              </button>`
            : nothing}
        </div>
        ${v ? html`<div class="muted small">${mb(v.size)}${v.published ? ` · ${day(v.published)}` : ""}${v.notes ? ` · ${v.notes}` : ""}</div>` : nothing}
        ${mine && pct != null
          ? html`<div class="progress" role="progressbar" aria-valuenow=${pct}><i style="width:${pct}%"></i><span>Downloading · ${pct}%</span></div>`
          : nothing}
      </div>
    </article>`;
  }

  render() {
    const view = this.view;
    return html`
      <h1>Get skins</h1>
      <section>
        <div class="row">
          <div class="label">
            <strong>Skins published outside Vellum's releases</strong>
            <div class="muted small">
              Downloads go to your plugins folder, so they stay when you switch Vellum versions. Pick any published version, or go
              back to an older one.
            </div>
          </div>
          <button ?disabled=${this.loading} @click=${() => this.refresh(true)}>${this.loading ? "Checking…" : "Check for updates"}</button>
        </div>
        ${view?.error ? html`<p class="error small">${view.error}</p>` : nothing}
      </section>
      ${!view ? html`<p class="muted">Loading…</p>` : nothing}
      ${view && !view.error && view.plugins.length === 0 ? html`<p class="muted">Nothing in the catalog yet.</p>` : nothing}
      <div class="list">${view?.plugins.map((p) => this.renderPlugin(p))}</div>
    `;
  }

  static styles = [
    tokens,
    controls,
    pageStyles,
    css`
      .list {
        display: grid;
        gap: 14px;
      }
      article {
        display: grid;
        grid-template-columns: 200px 1fr;
        gap: 14px;
        padding: 14px;
        border-radius: var(--v-radius);
        background: var(--v-surface);
      }
      .preview {
        aspect-ratio: 16 / 10;
        border-radius: var(--v-radius);
        overflow: hidden;
        background: var(--v-surface-raised);
        display: grid;
        place-items: center;
      }
      .preview img {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
      .meta {
        display: grid;
        gap: 4px;
        align-content: start;
        min-width: 0;
      }
      .row {
        flex-wrap: wrap;
      }
      select {
        min-width: 0;
        max-width: 260px;
      }
      .pill {
        display: inline-block;
        margin-left: 6px;
        padding: 1px 8px;
        border-radius: 999px;
        font-size: 12px;
        background: var(--v-surface-raised);
        color: var(--v-text-muted);
      }
      .pill.accent {
        background: color-mix(in srgb, var(--v-accent) 25%, transparent);
        color: var(--v-text);
      }
      .pill.warn {
        background: color-mix(in srgb, #e0a020 25%, transparent);
        color: var(--v-text);
      }
      .progress {
        position: relative;
        height: 20px;
        border-radius: 4px;
        overflow: hidden;
        background: var(--v-surface-raised);
        font-size: 12px;
      }
      .progress i {
        position: absolute;
        inset: 0 auto 0 0;
        background: color-mix(in srgb, var(--v-accent) 45%, transparent);
      }
      .progress span {
        position: relative;
        padding: 0 8px;
        line-height: 20px;
      }
      button.danger {
        color: var(--v-danger);
      }
    `,
  ];
}

customElements.define("vellum-catalog-page", CatalogPage);
