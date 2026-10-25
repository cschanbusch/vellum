// Change art…: every candidate for one entry, per kind, from the provider, SteamGridDB and
// the user's own files. A choice is saved as an override; Automatic removes it.
import { LitElement, css, html, nothing } from "lit";
import { api, type ArtChoices, type ArtOption } from "./api";
import { controls, tokens } from "./theme";
import type { ArtKind, Entry } from "../../sdk/src/types";
import { ART_KINDS } from "../../sdk/src/types";

const LABELS: Record<ArtKind, string> = { cover: "Cover", hero: "Hero", logo: "Logo", header: "Header", icon: "Icon" };
/** Tile shapes, close to each kind's usual proportions. */
const ASPECT: Record<ArtKind, string> = { cover: "2 / 3", hero: "31 / 10", logo: "2 / 1", header: "46 / 21", icon: "1 / 1" };
const TILE: Record<ArtKind, string> = { cover: "150px", hero: "300px", logo: "220px", header: "220px", icon: "110px" };
/** Previews loaded at once (each may be a download). */
const PREVIEW_CONCURRENCY = 4;

export class ArtDialog extends LitElement {
  static properties = {
    entry: { state: true },
    kind: { state: true },
    choices: { state: true },
    error: { state: true },
    saving: { state: true },
  };
  declare entry: Entry | null;
  declare kind: ArtKind;
  declare choices: ArtChoices | null;
  declare error: string | null;
  declare saving: boolean;
  /** Called with each updated entry, so the skin shows new art straight away. */
  onEntry: (e: Entry) => void = () => {};
  /** Opens Settings at a page (the SteamGridDB hint). */
  onSettings: (page: string) => void = () => {};
  private onClose: (() => void) | null = null;
  private thumbs = new Map<string, string | null>();

  constructor() {
    super();
    this.entry = null;
    this.kind = "cover";
    this.choices = null;
    this.error = null;
    this.saving = false;
  }

  open(entry: Entry, kind: ArtKind, onClose?: () => void) {
    this.entry = entry;
    this.onClose = onClose ?? null;
    this.thumbs.clear();
    void this.show(ART_KINDS.includes(kind) ? kind : "cover");
  }

  get isOpen() {
    return !!this.entry;
  }

  close() {
    this.entry = null;
    this.choices = null;
    const cb = this.onClose;
    this.onClose = null;
    cb?.();
  }

  private async show(kind: ArtKind) {
    this.kind = kind;
    this.choices = null;
    this.error = null;
    await this.reload();
    void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLElement>(".tabs button.active")?.focus());
  }

  private async reload() {
    const e = this.entry;
    if (!e) return;
    const kind = this.kind;
    try {
      const c = await api.artChoices(e.id, kind);
      if (this.entry?.id === e.id && this.kind === kind) {
        this.choices = c;
        this.loadThumbs(c.options);
      }
    } catch (err) {
      this.error = String(err);
    }
  }

  private key(o: ArtOption) {
    return `${this.kind}|${o.id}`;
  }

  /** Fetches previews a few at a time, in order. */
  private loadThumbs(options: ArtOption[]) {
    const e = this.entry!;
    const kind = this.kind;
    const queue = options.filter((o) => o.state !== "missing" && !this.thumbs.has(this.key(o)));
    const next = async () => {
      const o = queue.shift();
      if (!o || this.entry?.id !== e.id) return;
      try {
        this.thumbs.set(`${kind}|${o.id}`, await api.artThumb(e.id, kind, o.id));
      } catch {
        this.thumbs.set(`${kind}|${o.id}`, null);
      }
      this.requestUpdate();
      await next();
    };
    for (let i = 0; i < PREVIEW_CONCURRENCY; i++) void next();
  }

  private async apply(run: () => Promise<Entry>) {
    this.saving = true;
    this.error = null;
    try {
      const updated = await run();
      this.entry = updated;
      this.onEntry(updated);
      await this.reload();
    } catch (err) {
      this.error = String(err);
    } finally {
      this.saving = false;
    }
  }

  private choose(o: ArtOption) {
    if (o.chosen || this.saving || !this.entry) return;
    const id = this.entry.id;
    void this.apply(() => api.setArtOverride(id, this.kind, o.id));
  }

  private automatic() {
    if (!this.entry) return;
    const id = this.entry.id;
    void this.apply(() => api.setArtOverride(id, this.kind, null));
  }

  private async chooseFile() {
    if (!this.entry) return;
    const id = this.entry.id;
    const path = await api.pickImage(`Choose a ${LABELS[this.kind].toLowerCase()} image`);
    if (path) await this.apply(() => api.setArtOverrideFile(id, this.kind, path));
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }
  }

  private tile(o: ArtOption) {
    const src = this.thumbs.get(this.key(o));
    const dims = o.width && o.height ? `${o.width} × ${o.height}` : "";
    const status = o.state === "missing" ? "Not available" : src === undefined ? "Loading…" : src === null ? "No preview" : "";
    return html`<button
      class="tile ${o.chosen ? "chosen" : ""} ${o.inUse ? "in-use" : ""}"
      ?disabled=${o.state === "missing" || this.saving}
      title=${[o.source, dims].filter(Boolean).join(" · ")}
      @click=${() => this.choose(o)}
    >
      <span class="pic" style="aspect-ratio:${ASPECT[this.kind]}">
        ${src ? html`<img src=${src} alt="" />` : html`<span class="status">${status}</span>`}
      </span>
      <span class="meta">
        <span>${o.source}</span>
        ${dims ? html`<span class="muted">${dims}</span>` : nothing}
        ${o.inUse ? html`<span class="badge">${o.chosen ? "Chosen" : "In use"}</span>` : nothing}
      </span>
    </button>`;
  }

  render() {
    const e = this.entry;
    if (!e) return nothing;
    const c = this.choices;
    return html`<div class="scrim" @pointerdown=${() => this.close()}></div>
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="art-title" @keydown=${this.onKey}>
        <header>
          <h2 id="art-title">Art for ${e.title}</h2>
          <button @click=${() => this.close()}>Done</button>
        </header>
        <div class="tabs" role="tablist">
          ${ART_KINDS.map(
            (k) => html`<button
              role="tab"
              class=${k === this.kind ? "active" : ""}
              aria-selected=${k === this.kind ? "true" : "false"}
              @click=${() => k !== this.kind && void this.show(k)}
            >
              ${LABELS[k]}
            </button>`,
          )}
        </div>
        <div class="bar">
          <span class="muted">
            ${c ? (c.automatic ? "Automatic: Vellum picks the best available image." : "You chose this image. Automatic lets Vellum pick again.") : nothing}
          </span>
          <button ?disabled=${!c || c.automatic || this.saving} @click=${() => this.automatic()}>Automatic</button>
          <button ?disabled=${this.saving} @click=${() => this.chooseFile()}>Choose file…</button>
        </div>
        ${this.error ? html`<p class="error">${this.error}</p>` : nothing}
        <div class="grid" style="--tile:${TILE[this.kind]}">
          ${!c
            ? html`<p class="muted">Finding images…</p>`
            : c.options.length
              ? c.options.map((o) => this.tile(o))
              : html`<p class="muted">No ${LABELS[this.kind].toLowerCase()} images found. Choose a file, or Vellum shows a generated one.</p>`}
        </div>
        ${c && c.steamgriddb !== "on"
          ? html`<p class="hint muted">
              ${c.steamgriddb === "rejected" ? "SteamGridDB refused the saved key." : "Add a free SteamGridDB key for many more choices."}
              <button class="link" @click=${() => (this.close(), this.onSettings("art"))}>Art and metadata settings</button>
            </p>`
          : nothing}
      </div>`;
  }

  static styles = [
    tokens,
    controls,
    css`
      :host {
        position: fixed;
        inset: 0;
        z-index: 70;
        display: grid;
        place-items: center;
        pointer-events: none;
      }
      .scrim {
        position: fixed;
        inset: 0;
        background: #0008;
        pointer-events: auto;
      }
      .dialog {
        position: relative;
        display: flex;
        flex-direction: column;
        width: min(1000px, 94vw);
        max-height: 88vh;
        padding: 18px 20px;
        border-radius: calc(var(--v-radius) + 4px);
        background: var(--v-surface);
        color: var(--v-text);
        font: 14px var(--v-font-body);
        box-shadow: 0 20px 60px #000a;
        pointer-events: auto;
      }
      header {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      h2 {
        flex: 1;
        margin: 0;
        font-size: 17px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .tabs {
        display: flex;
        gap: 4px;
        margin: 14px 0 10px;
      }
      .tabs button {
        background: transparent;
        border-color: transparent;
      }
      .tabs button.active {
        background: var(--v-surface-raised);
        color: var(--v-accent);
      }
      .bar {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 12px;
      }
      .bar .muted {
        flex: 1;
        font-size: 13px;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(var(--tile), 1fr));
        gap: 12px;
        overflow: auto;
        min-height: 120px;
        padding: 2px;
      }
      .tile {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 6px;
        text-align: left;
        border-radius: var(--v-radius);
        background: var(--v-bg);
        border: 2px solid transparent;
      }
      .tile.in-use {
        border-color: var(--v-accent);
      }
      .tile:disabled {
        opacity: 0.5;
      }
      .pic {
        display: grid;
        place-items: center;
        width: 100%;
        overflow: hidden;
        border-radius: calc(var(--v-radius) - 2px);
        /* A checkerboard, so transparent logos and icons read as transparent. */
        background: repeating-conic-gradient(#ffffff10 0 25%, #00000020 0 50%) 0 0 / 16px 16px;
      }
      .pic img {
        width: 100%;
        height: 100%;
        object-fit: contain;
      }
      .status {
        font-size: 12px;
        color: var(--v-text-muted);
      }
      .meta {
        display: flex;
        flex-wrap: wrap;
        gap: 2px 8px;
        align-items: center;
        font-size: 12px;
      }
      .badge {
        padding: 0 7px;
        border-radius: 99px;
        background: var(--v-accent);
        color: var(--v-bg);
        font-weight: 600;
      }
      .muted {
        color: var(--v-text-muted);
      }
      .error {
        color: var(--v-danger);
        margin: 0 0 10px;
      }
      .hint {
        margin: 12px 0 0;
        font-size: 13px;
      }
      .link {
        padding: 1px 8px;
        margin-left: 6px;
      }
    `,
  ];
}
customElements.define("vellum-art-dialog", ArtDialog);
