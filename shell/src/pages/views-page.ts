// Settings → Views: every view (built-in and skin) in the user's order, with show/hide, plus
// the startup view. Reorder by dragging or with the arrow buttons (keyboard and controller).
import { LitElement, css, html } from "lit";
import { host } from "../host/instance";
import { controls, tokens } from "../theme";
import { pageStyles } from "./page-styles";

export class ViewsPage extends LitElement {
  static properties = { dragging: { state: true } };
  declare dragging: string | null;
  private unsubs: (() => void)[] = [];

  constructor() {
    super();
    this.dragging = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this.unsubs = [host.on("views", () => this.requestUpdate()), host.on("skin", () => this.requestUpdate())];
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.unsubs.forEach((u) => u());
  }

  private save(order: string[], hidden: string[]) {
    void host.updateViewPrefs({ order, hidden });
  }

  private move(id: string, to: number) {
    const order = host.views.map((v) => v.id).filter((x) => x !== id);
    order.splice(Math.max(0, Math.min(order.length, to)), 0, id);
    this.save(order, host.ui.views.hidden ?? []);
  }

  private toggle(id: string, visible: boolean) {
    const hidden = new Set(host.ui.views.hidden ?? []);
    if (visible) hidden.delete(id);
    else hidden.add(id);
    if (host.views.every((v) => hidden.has(v.id))) return; // keep at least one view
    this.save(
      host.views.map((v) => v.id),
      [...hidden],
    );
  }

  private async setStart(value: string) {
    host.ui = await host.backend.updateUi({ startView: value });
    this.requestUpdate();
  }

  render() {
    const views = host.views;
    return html`
      <h1>Views</h1>
      <section>
        <h2>Order and visibility</h2>
        <p class="muted small">Ctrl+1–3 always open List, Covers and Spotlight; skin views get Ctrl+4–9 in this order.</p>
        <ol>
          ${views.map(
            (v, i) => html`<li
              draggable="true"
              class=${this.dragging === v.id ? "dragging" : ""}
              @dragstart=${(e: DragEvent) => {
                this.dragging = v.id;
                e.dataTransfer?.setData("text/plain", v.id);
              }}
              @dragend=${() => (this.dragging = null)}
              @dragover=${(e: DragEvent) => e.preventDefault()}
              @drop=${(e: DragEvent) => {
                e.preventDefault();
                if (this.dragging && this.dragging !== v.id) this.move(this.dragging, i);
                this.dragging = null;
              }}
            >
              <span class="grip" aria-hidden="true">⋮⋮</span>
              <label>
                <input type="checkbox" .checked=${!v.hidden} @change=${(e: Event) => this.toggle(v.id, (e.target as HTMLInputElement).checked)} />
                ${v.name}
              </label>
              <span class="muted small">${v.builtin ? "Built in" : `From ${host.skin?.name ?? "the skin"}`}${v.couch ? " · couch" : ""}</span>
              <span class="key">${v.hotkey ?? ""}</span>
              <button aria-label="Move ${v.name} up" ?disabled=${i === 0} @click=${() => this.move(v.id, i - 1)}>↑</button>
              <button aria-label="Move ${v.name} down" ?disabled=${i === views.length - 1} @click=${() => this.move(v.id, i + 1)}>↓</button>
            </li>`,
          )}
        </ol>
        <button @click=${() => this.save([], [])}>Reset to default order</button>
      </section>
      <section>
        <h2>Start in</h2>
        <div class="row">
          <span class="label">View shown when Vellum starts</span>
          <select @change=${(e: Event) => this.setStart((e.target as HTMLSelectElement).value)}>
            <option value="last" ?selected=${host.ui.startView === "last"}>Last used view</option>
            ${views.map((v) => html`<option value=${v.id} ?selected=${host.ui.startView === v.id}>${v.name}</option>`)}
          </select>
        </div>
      </section>
    `;
  }

  static styles = [
    tokens,
    controls,
    pageStyles,
    css`
      ol {
        list-style: none;
        margin: 0 0 12px;
        padding: 0;
      }
      li {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 6px 8px;
        border-radius: var(--v-radius);
        background: var(--v-bg);
        margin-bottom: 4px;
      }
      li.dragging {
        opacity: 0.5;
      }
      li label {
        flex: 1;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .grip {
        cursor: grab;
        color: var(--v-text-muted);
        letter-spacing: -3px;
      }
      .key {
        min-width: 48px;
        font-size: 12px;
        color: var(--v-text-muted);
      }
      li button {
        padding: 2px 8px;
      }
    `,
  ];
}

customElements.define("vellum-views-page", ViewsPage);
