// Overlays the shell draws above the skin, so they look and behave the same in every skin:
// the per-game context menu, the tag editor, and developer mode's error overlay.

import { LitElement, css, html, nothing } from "lit";
import type { Entry } from "../../sdk/src/types";
import { controls, tokens } from "./theme";

export interface MenuAction {
  label: string;
  run: () => void;
  disabled?: boolean;
  /** Draw a separator before this item. */
  separated?: boolean;
  hint?: string;
}

/** A keyboard-navigable menu at a point; closes on Escape, a choice, or a click outside. */
export class ContextMenu extends LitElement {
  static properties = { items: { state: true }, x: { state: true }, y: { state: true }, title: { state: true } };
  declare items: MenuAction[];
  declare x: number;
  declare y: number;
  declare title: string;
  private onClose: (() => void) | null = null;

  constructor() {
    super();
    this.items = [];
    this.x = 0;
    this.y = 0;
    this.title = "";
  }

  open(title: string, items: MenuAction[], x: number, y: number, onClose: () => void) {
    this.title = title;
    this.items = items;
    this.x = x;
    this.y = y;
    this.onClose = onClose;
    this.hidden = false;
    void this.updateComplete.then(() => {
      // Keep the menu on screen.
      const box = this.renderRoot.querySelector<HTMLElement>(".menu")!;
      const r = box.getBoundingClientRect();
      if (r.right > innerWidth - 8) this.x = Math.max(8, innerWidth - r.width - 8);
      if (r.bottom > innerHeight - 8) this.y = Math.max(8, innerHeight - r.height - 8);
      this.renderRoot.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
    });
  }

  close() {
    if (this.hidden) return;
    this.hidden = true;
    this.items = [];
    const cb = this.onClose;
    this.onClose = null;
    cb?.();
  }

  get isOpen() {
    return !this.hidden;
  }

  private onKey(e: KeyboardEvent) {
    const buttons = [...this.renderRoot.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const i = buttons.indexOf((this.renderRoot as ShadowRoot).activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const d = e.key === "ArrowDown" ? 1 : -1;
      buttons[(i + d + buttons.length) % buttons.length]?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      buttons[e.key === "Home" ? 0 : buttons.length - 1]?.focus();
    } else if (e.key === "Escape" || e.key === "Backspace") {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }
  }

  private choose(a: MenuAction) {
    this.close();
    a.run();
  }

  render() {
    if (this.hidden) return nothing;
    return html`<div class="backdrop" @pointerdown=${() => this.close()} @contextmenu=${(e: Event) => (e.preventDefault(), this.close())}></div>
      <div class="menu" role="menu" aria-label=${this.title} style="left:${this.x}px;top:${this.y}px" @keydown=${this.onKey}>
        <div class="title">${this.title}</div>
        ${this.items.map(
          (a) => html`${a.separated ? html`<hr />` : nothing}
            <button role="menuitem" ?disabled=${a.disabled} @click=${() => this.choose(a)}>
              <span>${a.label}</span>${a.hint ? html`<span class="hint">${a.hint}</span>` : nothing}
            </button>`,
        )}
      </div>`;
  }

  static styles = [
    tokens,
    controls,
    css`
      :host {
        position: fixed;
        inset: 0;
        z-index: 60;
      }
      .backdrop {
        position: absolute;
        inset: 0;
      }
      .menu {
        position: absolute;
        min-width: 220px;
        max-width: 340px;
        padding: 4px;
        display: flex;
        flex-direction: column;
        background: var(--v-surface-raised);
        border: 1px solid color-mix(in srgb, var(--v-text) 12%, transparent);
        border-radius: var(--v-radius);
        box-shadow: 0 16px 40px #0009;
        font: 14px var(--v-font-body);
        color: var(--v-text);
      }
      .title {
        padding: 6px 10px 4px;
        font-size: 12px;
        color: var(--v-text-muted);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      button {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        text-align: left;
        background: transparent;
        border-color: transparent;
        padding: 7px 10px;
      }
      button:hover:not(:disabled),
      button:focus-visible {
        background: color-mix(in srgb, var(--v-accent) 18%, transparent);
        outline: none;
      }
      .hint {
        color: var(--v-text-muted);
        font-size: 12px;
      }
      hr {
        border: 0;
        border-top: 1px solid color-mix(in srgb, var(--v-text) 10%, transparent);
        margin: 4px 6px;
      }
    `,
  ];
}
customElements.define("vellum-context-menu", ContextMenu);

/** Edits an entry's user tags; suggests tags used elsewhere in the library. */
export class TagsDialog extends LitElement {
  static properties = { entry: { state: true }, tags: { state: true }, known: { state: true } };
  declare entry: Entry | null;
  declare tags: string[];
  declare known: string[];
  private resolve: ((tags: string[] | null) => void) | null = null;

  constructor() {
    super();
    this.entry = null;
    this.tags = [];
    this.known = [];
  }

  edit(entry: Entry, known: string[]): Promise<string[] | null> {
    this.entry = entry;
    this.tags = [...entry.tags];
    this.known = known;
    void this.updateComplete.then(() => this.renderRoot.querySelector("input")?.focus());
    return new Promise((r) => (this.resolve = r));
  }

  private finish(save: boolean) {
    const r = this.resolve;
    this.resolve = null;
    this.entry = null;
    r?.(save ? this.tags : null);
  }

  private add(raw: string) {
    for (const part of raw.split(",")) {
      const t = part.trim().slice(0, 40);
      if (t && !this.tags.some((x) => x.toLowerCase() === t.toLowerCase()) && this.tags.length < 32) this.tags = [...this.tags, t];
    }
  }

  private onKey(e: KeyboardEvent) {
    const input = e.target as HTMLInputElement;
    if (e.key === "Enter") {
      e.preventDefault();
      if (input.value.trim()) {
        this.add(input.value);
        input.value = "";
      } else this.finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.finish(false);
    } else if (e.key === "Backspace" && !input.value && this.tags.length) {
      this.tags = this.tags.slice(0, -1);
    }
  }

  render() {
    if (!this.entry) return nothing;
    const suggestions = this.known.filter((k) => !this.tags.some((t) => t.toLowerCase() === k.toLowerCase())).slice(0, 12);
    return html`<div class="scrim" @pointerdown=${() => this.finish(false)}></div>
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="t">
        <h2 id="t">Tags for ${this.entry.title}</h2>
        <div class="chips">
          ${this.tags.map(
            (t) => html`<span class="chip">${t}<button aria-label="Remove ${t}" @click=${() => (this.tags = this.tags.filter((x) => x !== t))}>×</button></span>`,
          )}
          <input placeholder=${this.tags.length ? "Add another…" : "Type a tag and press Enter"} @keydown=${this.onKey} aria-label="New tag" />
        </div>
        ${suggestions.length
          ? html`<div class="suggest">
              <span class="muted">Used elsewhere:</span>
              ${suggestions.map((s) => html`<button class="link" @click=${() => this.add(s)}>${s}</button>`)}
            </div>`
          : nothing}
        <div class="actions">
          <button @click=${() => this.finish(false)}>Cancel</button>
          <button class="primary" @click=${() => this.finish(true)}>Save</button>
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
        padding: 20px;
        border-radius: calc(var(--v-radius) + 4px);
        background: var(--v-surface);
        color: var(--v-text);
        font: 14px var(--v-font-body);
        box-shadow: 0 20px 60px #000a;
        pointer-events: auto;
      }
      h2 {
        margin: 0 0 14px;
        font-size: 17px;
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        padding: 8px;
        border-radius: var(--v-radius);
        background: var(--v-bg);
        border: 1px solid #2b3246;
      }
      .chip {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px 4px 2px 10px;
        border-radius: 99px;
        background: var(--v-surface-raised);
      }
      .chip button {
        padding: 0 6px;
        border: 0;
        background: transparent;
      }
      input {
        flex: 1;
        min-width: 140px;
        border: 0;
        background: transparent;
        color: inherit;
        font: inherit;
        outline: none;
        padding: 4px;
      }
      .suggest {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        align-items: center;
        margin-top: 10px;
        font-size: 13px;
      }
      .link {
        padding: 1px 8px;
        border-radius: 99px;
      }
      .muted {
        color: var(--v-text-muted);
      }
      .actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 18px;
      }
    `,
  ];
}
customElements.define("vellum-tags-dialog", TagsDialog);

/** Developer mode: the latest error thrown by skin code. */
export class DevErrorOverlay extends LitElement {
  static properties = { message: { state: true }, stack: { state: true }, count: { state: true } };
  declare message: string;
  declare stack: string;
  declare count: number;

  constructor() {
    super();
    this.message = "";
    this.stack = "";
    this.count = 0;
  }

  show(message: string, stack: string) {
    this.message = message;
    this.stack = stack;
    this.count++;
  }

  clear() {
    this.message = "";
    this.count = 0;
  }

  render() {
    if (!this.message) return nothing;
    return html`<div class="box" role="alert">
      <div class="head">
        <strong>Skin error${this.count > 1 ? ` (${this.count})` : ""}</strong>
        <button @click=${() => this.clear()}>Dismiss</button>
      </div>
      <div class="msg">${this.message}</div>
      ${this.stack ? html`<pre>${this.stack}</pre>` : nothing}
    </div>`;
  }

  static styles = [
    tokens,
    controls,
    css`
      :host {
        position: fixed;
        left: 16px;
        right: 16px;
        bottom: 16px;
        z-index: 80;
        pointer-events: none;
      }
      .box {
        pointer-events: auto;
        max-height: 40vh;
        overflow: auto;
        padding: 12px 14px;
        border-radius: var(--v-radius);
        background: #2a1216;
        border: 1px solid var(--v-danger);
        color: #ffdede;
        font: 13px var(--v-font-body);
        box-shadow: 0 12px 40px #000a;
      }
      .head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 6px;
      }
      .msg {
        font-weight: 600;
      }
      pre {
        margin: 8px 0 0;
        white-space: pre-wrap;
        font: 12px ui-monospace, "Cascadia Mono", monospace;
        opacity: 0.85;
      }
    `,
  ];
}
customElements.define("vellum-dev-error", DevErrorOverlay);
