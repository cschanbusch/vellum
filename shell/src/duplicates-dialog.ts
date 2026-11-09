// The same game on more than one store: how many entries should it be, and which store plays it?
// When a new duplicate turns up this has to be answered (no close button, Escape does nothing);
// from Settings → Library it can be reviewed and cancelled. It only collects answers: the caller
// saves them, which also lets the skin dev harness show it with no backend behind it.
import { LitElement, css, html, nothing } from "lit";
import { controls, tokens } from "./theme";

export type ChoiceMode = "one" | "ask" | "separate";

export interface DuplicateCopy {
  record: string;
  provider: string;
  providerName: string;
  title: string;
}

/** One duplicate as the backend reports it. Copies come in store priority order. */
export interface DuplicateView {
  title: string;
  copies: DuplicateCopy[];
  pending: boolean;
  /** How it's listed today; null when only some copies share an entry. */
  current: ChoiceMode | null;
  preferred: string;
  /** A copy's provider suggests separate entries (an emulator's game is usually its own product). */
  suggestSeparate?: boolean;
}

export interface DuplicateAnswer {
  records: string[];
  mode: ChoiceMode;
  preferred?: string;
}

const KEEP = "keep";
const SEPARATE = "separate";
const ASK = "ask";
const via = (provider: string) => `one:${provider}`;

/** What a row's control starts on. An unanswered duplicate suggests its first store. */
export function initialValue(d: DuplicateView): string {
  if (d.pending) return d.suggestSeparate ? SEPARATE : via(d.copies[0].provider);
  if (d.current === "ask") return ASK;
  if (d.current === "separate") return SEPARATE;
  if (d.current === "one") return via(d.preferred);
  return KEEP;
}

export function toAnswer(d: DuplicateView, value: string): DuplicateAnswer | null {
  if (value === KEEP) return null;
  const records = d.copies.map((c) => c.record);
  if (value === ASK) return { records, mode: "ask" };
  if (value === SEPARATE) return { records, mode: "separate" };
  return { records, mode: "one", preferred: value.slice("one:".length) };
}

export class DuplicatesDialog extends LitElement {
  static properties = { list: { state: true }, values: { state: true }, required: { state: true } };
  declare list: DuplicateView[] | null;
  declare values: string[];
  declare required: boolean;
  private resolve: ((answers: DuplicateAnswer[] | null) => void) | null = null;
  private initial: string[] = [];

  constructor() {
    super();
    this.list = null;
    this.values = [];
    this.required = false;
  }

  get isOpen() {
    return !!this.list;
  }

  /** Resolves with the changed rows (all of them when required), or null when cancelled. */
  open(list: DuplicateView[], required: boolean): Promise<DuplicateAnswer[] | null> {
    this.list = list;
    this.required = required;
    this.initial = list.map(initialValue);
    this.values = [...this.initial];
    void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLElement>("select")?.focus());
    return new Promise((r) => (this.resolve = r));
  }

  private finish(answers: DuplicateAnswer[] | null) {
    const r = this.resolve;
    this.resolve = null;
    this.list = null;
    r?.(answers);
  }

  private apply() {
    const list = this.list!;
    const answers = list
      .map((d, i) => (this.required || this.values[i] !== this.initial[i] ? toAnswer(d, this.values[i]) : null))
      .filter((a): a is DuplicateAnswer => !!a);
    this.finish(answers);
  }

  private setAll(e: Event) {
    const el = e.target as HTMLSelectElement;
    const how = el.value;
    if (how) this.values = this.list!.map((d) => (how === "first" ? via(d.copies[0].provider) : how));
    el.value = "";
  }

  private onKey(e: KeyboardEvent) {
    // A key held down from the skin (a hold-to-launch, say) mustn't answer for the user.
    if (e.repeat && (e.key === "Enter" || e.key === " ")) e.preventDefault();
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    if (!this.required) this.finish(null);
  }

  render() {
    const list = this.list;
    if (!list) return nothing;
    return html`<div class="scrim"></div>
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="t" @keydown=${this.onKey}>
        <h2 id="t">${this.required ? (list.length === 1 ? "This game is on more than one store" : "These games are on more than one store") : "Duplicate games"}</h2>
        <p class="muted">Choose how each one shows in your library. You can change this later from the game's menu, under Stores.</p>
        ${list.length > 1
          ? html`<div class="all">
              <label for="all">Set all to</label>
              <select id="all" @change=${this.setAll}>
                <option value="">Choose…</option>
                <option value="first">One entry, using the first store listed</option>
                <option value=${ASK}>One entry, ask me each time</option>
                <option value=${SEPARATE}>Separate entries</option>
              </select>
            </div>`
          : nothing}
        <ul>
          ${list.map(
            (d, i) => html`<li>
              <div class="info">
                <strong>${d.title}</strong>
                <div class="muted small">${d.copies.map((c) => c.providerName).join(", ")}</div>
              </div>
              <select
                aria-label="How ${d.title} shows in your library"
                .value=${this.values[i]}
                @change=${(e: Event) => (this.values = this.values.map((v, n) => (n === i ? (e.target as HTMLSelectElement).value : v)))}
              >
                ${d.copies.map((c) => html`<option value=${via(c.provider)} ?selected=${this.values[i] === via(c.provider)}>One entry, always play via ${c.providerName}</option>`)}
                <option value=${ASK} ?selected=${this.values[i] === ASK}>One entry, ask me each time</option>
                <option value=${SEPARATE} ?selected=${this.values[i] === SEPARATE}>Separate entries, marked by store</option>
                ${this.initial[i] === KEEP ? html`<option value=${KEEP} ?selected=${this.values[i] === KEEP}>Keep as it is now</option>` : nothing}
              </select>
            </li>`,
          )}
        </ul>
        <div class="actions">
          ${this.required ? nothing : html`<button @click=${() => this.finish(null)}>Cancel</button>`}
          <button class="primary" @click=${() => this.apply()}>Apply</button>
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
        z-index: 75;
        display: grid;
        place-items: center;
        pointer-events: none;
      }
      .scrim {
        position: fixed;
        inset: 0;
        background: #000a;
        pointer-events: auto;
      }
      .dialog {
        position: relative;
        display: flex;
        flex-direction: column;
        width: min(720px, 92vw);
        max-height: 88vh;
        padding: 20px;
        border-radius: calc(var(--v-radius) + 4px);
        background: var(--v-surface);
        color: var(--v-text);
        font: 14px var(--v-font-body);
        box-shadow: 0 20px 60px #000a;
        pointer-events: auto;
      }
      h2 {
        margin: 0 0 6px;
        font-size: 17px;
      }
      p {
        margin: 0 0 12px;
      }
      .all {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 8px;
        margin-bottom: 10px;
      }
      ul {
        list-style: none;
        margin: 0;
        padding: 0;
        overflow: auto;
        min-height: 0;
      }
      li {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 8px 12px;
        padding: 10px 12px;
        margin-bottom: 6px;
        border-radius: var(--v-radius);
        background: var(--v-bg);
      }
      .info {
        flex: 1 1 200px;
        min-width: 0;
        overflow-wrap: anywhere;
      }
      select {
        flex: 0 1 300px;
        min-width: 0;
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
      .muted {
        color: var(--v-text-muted);
      }
      .small {
        font-size: 12px;
      }
      .actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 14px;
      }
    `,
  ];
}
customElements.define("vellum-duplicates-dialog", DuplicatesDialog);
