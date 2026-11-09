// Stores… in the game menu: how one entry plays, which copies it holds, and joining it to another
// entry whose title didn't match. Every change saves at once; the library reloads by itself.
import { LitElement, css, html, nothing } from "lit";
import { api } from "./api";
import { controls, tokens } from "./theme";
import type { Entry } from "../../sdk/src/types";

const shareStore = (a: Entry, b: Entry) => a.sources.some((s) => b.sources.some((t) => t.provider === s.provider));

/** Entries this one can join, closest title first, then alphabetical. */
export function mergeCandidates(entry: Entry, all: Entry[], search: string, limit = 8): Entry[] {
  const q = search.trim().toLowerCase();
  const title = entry.title.toLowerCase();
  return all
    .filter((e) => e.id !== entry.id && !shareStore(entry, e) && (!q || e.title.toLowerCase().includes(q)))
    .sort((a, b) => Number(b.title.toLowerCase() === title) - Number(a.title.toLowerCase() === title) || a.sortTitle.localeCompare(b.sortTitle))
    .slice(0, limit);
}

export class StoresDialog extends LitElement {
  static properties = { entry: { state: true }, search: { state: true }, error: { state: true }, busy: { state: true } };
  declare entry: Entry | null;
  declare search: string;
  declare error: string | null;
  declare busy: boolean;
  private all: Entry[] = [];
  private onClose: (() => void) | null = null;

  constructor() {
    super();
    this.entry = null;
    this.search = "";
    this.error = null;
    this.busy = false;
  }

  get isOpen() {
    return !!this.entry;
  }

  open(entry: Entry, all: Entry[], onClose: () => void) {
    this.entry = entry;
    this.all = all;
    this.onClose = onClose;
    this.search = "";
    this.error = null;
    void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLElement>("select, input")?.focus());
  }

  close() {
    this.entry = null;
    const cb = this.onClose;
    this.onClose = null;
    cb?.();
  }

  /** Runs one change and closes: the entry's shape, and possibly its id, has just changed. */
  private async act(change: Promise<unknown>) {
    this.busy = true;
    this.error = null;
    try {
      await change;
      this.close();
    } catch (e) {
      this.error = String(e);
    } finally {
      this.busy = false;
    }
  }

  private choose(value: string) {
    const id = this.entry!.id;
    if (value === "ask") void this.act(api.setSourceChoice(id, "ask"));
    else if (value === "separate") void this.act(api.setSourceChoice(id, "separate"));
    else void this.act(api.setSourceChoice(id, "one", value.slice("one:".length)));
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }
  }

  render() {
    const e = this.entry;
    if (!e) return nothing;
    const several = e.sources.length > 1;
    const current = e.askSource ? "ask" : `one:${e.preferredSource}`;
    const candidates = mergeCandidates(e, this.all, this.search);
    return html`<div class="scrim" @pointerdown=${() => this.close()}></div>
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="t" @keydown=${this.onKey}>
        <h2 id="t">Stores for ${e.title}</h2>
        ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}
        ${several
          ? html`<label for="how">When you press Play</label>
              <select id="how" ?disabled=${this.busy} .value=${current} @change=${(ev: Event) => this.choose((ev.target as HTMLSelectElement).value)}>
                ${e.sources.map((s) => html`<option value="one:${s.provider}" ?selected=${current === `one:${s.provider}`}>Always play via ${s.providerName}</option>`)}
                <option value="ask" ?selected=${e.askSource}>Ask me each time</option>
                <option value="separate">List each store as its own entry</option>
              </select>`
          : nothing}
        <div class="label">${several ? "Copies in this entry" : "Store"}</div>
        <ul class="copies">
          ${e.sources.map(
            (s) => html`<li>
              <span>${s.providerName}</span>
              ${several ? html`<button ?disabled=${this.busy} @click=${() => this.act(api.separateSource(e.id, s.gameId))}>Separate</button>` : nothing}
            </li>`,
          )}
        </ul>
        <label for="find">Merge with another game</label>
        <input id="find" placeholder="Search your library" .value=${this.search} @input=${(ev: Event) => (this.search = (ev.target as HTMLInputElement).value)} />
        ${candidates.length
          ? html`<ul class="found">
              ${candidates.map(
                (c) => html`<li>
                  <button class="pick" ?disabled=${this.busy} @click=${() => this.act(api.mergeEntries(e.id, c.id))}>
                    <span class="name">${c.title}</span>
                    <span class="muted small">${c.sources.map((s) => s.providerName).join(", ")}</span>
                  </button>
                </li>`,
              )}
            </ul>`
          : html`<p class="muted small">No game on another store matches.</p>`}
        <div class="actions"><button @click=${() => this.close()}>Done</button></div>
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
        width: min(520px, 92vw);
        max-height: 88vh;
        overflow: auto;
        padding: 20px;
        border-radius: calc(var(--v-radius) + 4px);
        background: var(--v-surface);
        color: var(--v-text);
        font: 14px var(--v-font-body);
        box-shadow: 0 20px 60px #000a;
        pointer-events: auto;
      }
      h2 {
        margin: 0 0 10px;
        font-size: 17px;
        overflow-wrap: anywhere;
      }
      label,
      .label {
        display: block;
        margin: 12px 0 4px;
        font-size: 13px;
      }
      select,
      input {
        box-sizing: border-box;
        width: 100%;
        padding: 6px 8px;
        font: inherit;
        color: inherit;
        background: var(--v-bg);
        border: 1px solid #2b3246;
        border-radius: var(--v-radius);
      }
      select:focus-visible {
        outline: 2px solid var(--v-focus-ring);
        outline-offset: 2px;
      }
      ul {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      .copies li {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 4px 0;
      }
      .found {
        margin-top: 6px;
      }
      .found li {
        margin-bottom: 4px;
      }
      .pick {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        width: 100%;
        text-align: left;
      }
      .name {
        overflow-wrap: anywhere;
      }
      .muted {
        color: var(--v-text-muted);
      }
      .small {
        font-size: 12px;
        flex: none;
      }
      p.small {
        margin: 6px 0 0;
      }
      .error {
        margin: 0 0 8px;
        padding: 8px 12px;
        border-radius: var(--v-radius);
        background: color-mix(in srgb, var(--v-danger) 15%, transparent);
        color: var(--v-danger);
        overflow-wrap: anywhere;
      }
      .actions {
        display: flex;
        justify-content: flex-end;
        margin-top: 16px;
      }
    `,
  ];
}
customElements.define("vellum-stores-dialog", StoresDialog);
