// Launch options… in the game menu: one copy's values for its provider's per-game settings
// (`provider.gameSettings`), such as an emulator's fullscreen or boot options. Saved on Save;
// they apply from the next launch, so nothing in the library redraws.
import { LitElement, css, html, nothing } from "lit";
import { api, type GameSettingsView, type PluginOption } from "./api";
import { controls, tokens } from "./theme";

export class LaunchOptionsDialog extends LitElement {
  static properties = { view: { state: true }, values: { state: true }, error: { state: true }, busy: { state: true } };
  declare view: GameSettingsView | null;
  declare values: Record<string, unknown>;
  declare error: string | null;
  declare busy: boolean;
  private target: { entryId: string; provider: string } | null = null;
  private onClose: (() => void) | null = null;

  constructor() {
    super();
    this.view = null;
    this.values = {};
    this.error = null;
    this.busy = false;
  }

  get isOpen() {
    return !!this.view;
  }

  async open(entryId: string, provider: string, onClose: () => void) {
    this.onClose = onClose;
    this.target = { entryId, provider };
    this.error = null;
    try {
      this.view = await api.gameSettings(entryId, provider);
      this.values = { ...this.view.values };
      await this.updateComplete;
      this.renderRoot.querySelector<HTMLElement>("select, input")?.focus();
    } catch (e) {
      this.view = null;
      this.onClose = null;
      throw e;
    }
  }

  close() {
    this.view = null;
    const cb = this.onClose;
    this.onClose = null;
    cb?.();
  }

  private async save() {
    if (!this.target) return;
    this.busy = true;
    this.error = null;
    try {
      await api.setGameSettings(this.target.entryId, this.target.provider, this.values);
      this.close();
    } catch (e) {
      this.error = String(e);
    } finally {
      this.busy = false;
    }
  }

  /** Every option back to its default, which is how the provider's own settings apply. */
  private reset() {
    const v: Record<string, unknown> = {};
    for (const o of this.view?.options ?? []) v[o.id] = o.default;
    this.values = v;
  }

  private set(id: string, value: unknown) {
    this.values = { ...this.values, [id]: value };
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    } else if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT" && (e.target as HTMLInputElement).type === "text") {
      e.preventDefault();
      void this.save();
    }
  }

  private field(o: PluginOption) {
    const value = this.values[o.id];
    const id = `o-${o.id}`;
    const tip = o.tooltip ?? nothing;
    switch (o.type) {
      case "toggle":
        return html`<label class="check" title=${tip}>
          <input type="checkbox" id=${id} .checked=${value === true} @change=${(e: Event) => this.set(o.id, (e.target as HTMLInputElement).checked)} />
          <span>${o.label}</span>
        </label>`;
      case "select":
        return html`<label for=${id} title=${tip}>${o.label}</label>
          <select id=${id} title=${tip} @change=${(e: Event) => this.set(o.id, (e.target as HTMLSelectElement).value)}>
            ${(o.choices ?? []).map((c) => html`<option value=${c.value} ?selected=${c.value === value}>${c.label}</option>`)}
          </select>`;
      case "range":
        return html`<label for=${id} title=${tip}>${o.label}</label>
          <input type="number" id=${id} title=${tip} min=${o.min ?? nothing} max=${o.max ?? nothing} step=${o.step ?? nothing} .value=${String(value ?? "")} @change=${(e: Event) => this.set(o.id, Number((e.target as HTMLInputElement).value))} />`;
      case "text":
        return html`<label for=${id} title=${tip}>${o.label}</label>
          <input type="text" id=${id} title=${tip} spellcheck="false" .value=${String(value ?? "")} @input=${(e: Event) => this.set(o.id, (e.target as HTMLInputElement).value)} />`;
    }
    return nothing;
  }

  render() {
    const v = this.view;
    if (!v) return nothing;
    return html`<div class="scrim" @pointerdown=${() => this.close()}></div>
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="t" @keydown=${this.onKey}>
        <h2 id="t">Launch options for ${v.title}</h2>
        <p class="muted small">Through ${v.providerName}. These apply to this game from its next launch.</p>
        ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}
        ${v.options.map((o) => this.field(o))}
        <div class="actions">
          <button class="left" ?disabled=${this.busy} @click=${() => this.reset()}>Reset to defaults</button>
          <button ?disabled=${this.busy} @click=${() => this.close()}>Cancel</button>
          <button class="primary" ?disabled=${this.busy} @click=${() => this.save()}>Save</button>
        </div>
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
        width: min(480px, 92vw);
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
        margin: 0 0 4px;
        font-size: 17px;
        overflow-wrap: anywhere;
      }
      label {
        display: block;
        margin: 12px 0 4px;
        font-size: 13px;
      }
      label.check {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      select,
      input[type="text"],
      input[type="number"] {
        box-sizing: border-box;
        width: 100%;
        padding: 6px 8px;
        font: inherit;
        color: inherit;
        background: var(--v-bg);
        border: 1px solid #2b3246;
        border-radius: var(--v-radius);
      }
      input[type="text"] {
        font-family: ui-monospace, Consolas, monospace;
      }
      select:focus-visible,
      input:focus-visible {
        outline: 2px solid var(--v-focus-ring);
        outline-offset: 2px;
      }
      .muted {
        color: var(--v-text-muted, #9aa3b5);
      }
      .small {
        font-size: 12px;
        margin: 0 0 8px;
      }
      .error {
        color: #ff8a8a;
      }
      .actions {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
        margin-top: 18px;
      }
      .actions .left {
        margin-right: auto;
      }
    `,
  ];
}

customElements.define("vellum-launch-options-dialog", LaunchOptionsDialog);
