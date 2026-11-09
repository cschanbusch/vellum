// Add or edit a hand-added game: the program or shortcut, its title, arguments and working
// folder, and when adding, optional art. Later art changes go through Change art.
import { LitElement, css, html, nothing } from "lit";
import { api, type CustomGame } from "./api";
import { controls, tokens } from "./theme";
import type { ArtKind } from "../../sdk/src/types";
import { ART_KINDS } from "../../sdk/src/types";

const LABELS: Record<ArtKind, string> = { cover: "Cover", hero: "Hero", logo: "Logo", header: "Header", icon: "Icon" };

const fileName = (p: string) => p.slice(Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/")) + 1);
const isShortcut = (p: string) => /\.(lnk|url)$/i.test(p.trim());

/** A title from a file name: "hollow_knight.exe" becomes "hollow knight". */
export const titleFromFile = (p: string) =>
  fileName(p)
    .replace(/\.[^.]+$/, "")
    .replace(/[_]+/g, " ")
    .trim();

export class CustomGameDialog extends LitElement {
  static properties = {
    game: { state: true },
    art: { state: true },
    error: { state: true },
    saving: { state: true },
    confirmRemove: { state: true },
  };
  declare game: CustomGame | null;
  declare art: Partial<Record<ArtKind, string>>;
  declare error: string | null;
  declare saving: boolean;
  declare confirmRemove: boolean;
  private resolve: ((recordId: string | null) => void) | null = null;

  constructor() {
    super();
    this.game = null;
    this.art = {};
    this.error = null;
    this.saving = false;
    this.confirmRemove = false;
  }

  get isOpen() {
    return !!this.game;
  }

  /** Resolves with the saved game's record id, or null when cancelled or removed. */
  open(game?: CustomGame): Promise<string | null> {
    this.game = game ? { ...game } : { id: "", title: "", exe: "", args: "", cwd: "" };
    this.art = {};
    this.error = null;
    this.confirmRemove = false;
    void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLElement>("button.browse")?.focus());
    return new Promise((r) => (this.resolve = r));
  }

  private finish(id: string | null) {
    const r = this.resolve;
    this.resolve = null;
    this.game = null;
    r?.(id);
  }

  private set(field: keyof CustomGame, value: string) {
    this.game = { ...this.game!, [field]: value };
  }

  private async browse() {
    const path = await api.pickProgram("Choose the program or shortcut");
    if (!path) return;
    const g = this.game!;
    // A title the user typed stays; one taken from the previous file follows the new one.
    const title = !g.title.trim() || g.title === titleFromFile(g.exe) ? titleFromFile(path) : g.title;
    this.game = { ...g, exe: path, title };
  }

  private async pickCwd() {
    const path = await api.pickFolder("Choose the working folder");
    if (path) this.set("cwd", path);
  }

  private async pickArt(kind: ArtKind) {
    const path = await api.pickImage(`Choose the ${LABELS[kind].toLowerCase()} image`);
    if (path) this.art = { ...this.art, [kind]: path };
  }

  private async save() {
    this.saving = true;
    this.error = null;
    try {
      const id = await api.customGameSave(this.game!);
      for (const [kind, path] of Object.entries(this.art)) await api.setArtOverrideFile(id, kind, path);
      this.finish(id);
    } catch (e) {
      this.error = String(e);
    } finally {
      this.saving = false;
    }
  }

  private async removeGame() {
    if (!this.confirmRemove) {
      this.confirmRemove = true;
      return;
    }
    try {
      await api.customGameRemove(this.game!.id);
      this.finish(null);
    } catch (e) {
      this.error = String(e);
    }
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.finish(null);
    }
  }

  private submit(e: Event) {
    e.preventDefault();
    if (!this.saving) void this.save();
  }

  render() {
    const g = this.game;
    if (!g) return nothing;
    const adding = !g.id;
    const shortcut = isShortcut(g.exe);
    const input = (field: keyof CustomGame) => (e: Event) => this.set(field, (e.target as HTMLInputElement).value);
    return html`<div class="scrim"></div>
      <form class="dialog" role="dialog" aria-modal="true" aria-labelledby="t" @keydown=${this.onKey} @submit=${this.submit}>
        <h2 id="t">${adding ? "Add a game" : `Edit ${g.title}`}</h2>
        ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}
        <label for="exe">Program or shortcut</label>
        <div class="row">
          <input id="exe" spellcheck="false" .value=${g.exe} @input=${input("exe")} />
          <button type="button" class="browse" @click=${() => this.browse()}>Browse…</button>
        </div>
        <label for="title">Title</label>
        <input id="title" .value=${g.title} @input=${input("title")} />
        <label for="args">Arguments <span class="muted">(optional)</span></label>
        <input id="args" spellcheck="false" .value=${shortcut ? "" : g.args} ?disabled=${shortcut} @input=${input("args")} />
        <label for="cwd">Working folder <span class="muted">(optional; the program's folder if empty)</span></label>
        <div class="row">
          <input id="cwd" spellcheck="false" .value=${shortcut ? "" : g.cwd} ?disabled=${shortcut} @input=${input("cwd")} />
          <button type="button" ?disabled=${shortcut} @click=${() => this.pickCwd()}>Browse…</button>
        </div>
        ${shortcut ? html`<p class="muted note">A shortcut starts with its own arguments and working folder.</p>` : nothing}
        ${adding
          ? html`<div class="label">Art <span class="muted">(optional; you can change it later with Change art)</span></div>
              <div class="art">
                ${ART_KINDS.map(
                  (k) => html`<button type="button" title=${this.art[k] ?? `Choose a ${LABELS[k].toLowerCase()} image`} @click=${() => this.pickArt(k)}>
                    ${LABELS[k]}${this.art[k] ? html`: <span class="file">${fileName(this.art[k]!)}</span>` : "…"}
                  </button>`,
                )}
              </div>`
          : nothing}
        <div class="actions">
          ${adding
            ? nothing
            : html`<button type="button" class="danger" @click=${() => this.removeGame()}>${this.confirmRemove ? "Really remove?" : "Remove from library"}</button>`}
          <span class="spacer"></span>
          <button type="button" @click=${() => this.finish(null)}>Cancel</button>
          <button type="submit" class="primary" ?disabled=${this.saving || !g.exe.trim() || !g.title.trim()}>${adding ? "Add game" : "Save"}</button>
        </div>
      </form>`;
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
        width: min(560px, 92vw);
        max-height: 90vh;
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
        margin: 0 0 12px;
        font-size: 17px;
        overflow-wrap: anywhere;
      }
      label,
      .label {
        display: block;
        margin: 12px 0 4px;
        font-size: 13px;
      }
      input {
        box-sizing: border-box;
        width: 100%;
        min-width: 0;
        padding: 6px 8px;
        font: inherit;
        color: inherit;
        background: var(--v-bg);
        border: 1px solid #2b3246;
        border-radius: var(--v-radius);
      }
      input:disabled {
        opacity: 0.5;
      }
      .row {
        display: flex;
        gap: 8px;
      }
      .row button {
        flex: none;
      }
      .art {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .art button {
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .file {
        color: var(--v-accent);
      }
      .muted {
        color: var(--v-text-muted);
      }
      .note {
        margin: 6px 0 0;
        font-size: 13px;
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
        align-items: center;
        gap: 8px;
        margin-top: 18px;
      }
      .spacer {
        flex: 1;
      }
      .danger {
        color: var(--v-danger);
      }
    `,
  ];
}
customElements.define("vellum-custom-game-dialog", CustomGameDialog);
