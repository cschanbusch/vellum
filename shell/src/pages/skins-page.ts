// Settings → Skins: installed skins with previews, activation, and the active skin's options
// (generated from its manifest) with live preview behind the settings drawer.
import { LitElement, css, html, nothing } from "lit";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { api, type PluginView } from "../api";
import { host } from "../host/instance";
import type { SkinOption } from "../../../sdk/src/types";
import { controls, tokens } from "../theme";
import { pageStyles } from "./page-styles";

export class SkinsPage extends LitElement {
  static properties = { skins: { state: true }, previews: { state: true }, error: { state: true } };
  declare skins: PluginView[];
  declare previews: Record<string, string | null>;
  declare error: string | null;
  private unlisten?: Promise<UnlistenFn>;
  private unsub?: () => void;
  private timers = new Map<string, number>();

  constructor() {
    super();
    this.skins = [];
    this.previews = {};
    this.error = null;
  }

  connectedCallback() {
    super.connectedCallback();
    void this.refresh();
    this.unlisten = api.onPluginsChanged(() => void this.refresh());
    this.unsub = host.on("skin", () => this.requestUpdate());
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.unlisten?.then((f) => f());
    this.unsub?.();
  }

  private async refresh() {
    this.skins = (await api.listPlugins()).filter((p) => p.kind === "skin");
    for (const s of this.skins) {
      if (!(s.id in this.previews)) {
        api.skinPreview(s.id).then((url) => (this.previews = { ...this.previews, [s.id]: url }));
      }
    }
  }

  private async activate(id: string) {
    try {
      await api.activateSkin(id);
      this.error = null;
    } catch (e) {
      this.error = String(e);
    }
  }

  /** Writes are debounced so dragging a slider doesn't flood settings.json. */
  private set(opt: SkinOption, value: unknown) {
    const skin = host.skin;
    if (!skin) return;
    skin.values = { ...skin.values, [opt.id]: value };
    clearTimeout(this.timers.get(opt.id));
    this.timers.set(
      opt.id,
      window.setTimeout(() => void api.setSkinOption(skin.id, opt.id, value).catch((e) => (this.error = String(e))), 60),
    );
  }

  private control(opt: SkinOption, value: unknown) {
    switch (opt.type) {
      case "color":
        return html`<input type="color" .value=${String(value)} @input=${(e: Event) => this.set(opt, (e.target as HTMLInputElement).value)} />`;
      case "range":
        return html`<input
            type="range"
            min=${opt.min ?? 0}
            max=${opt.max ?? 100}
            step=${opt.step ?? 1}
            .value=${String(value)}
            @input=${(e: Event) => this.set(opt, Number((e.target as HTMLInputElement).value))}
          />
          <span class="value">${value}${opt.unit ?? ""}</span>`;
      case "toggle":
        return html`<input type="checkbox" .checked=${!!value} @change=${(e: Event) => this.set(opt, (e.target as HTMLInputElement).checked)} />`;
      case "select":
      case "font":
      case "image": {
        const choices = opt.choices ?? (opt.type === "font" ? [{ value: "builtin", label: "Inter (built in)" }] : []);
        return html`<select @change=${(e: Event) => this.set(opt, (e.target as HTMLSelectElement).value)}>
          ${choices.map((c) => html`<option value=${c.value} ?selected=${c.value === value}>${c.label}</option>`)}
        </select>`;
      }
    }
  }

  render() {
    const active = host.skin;
    const options = host.options();
    const values = host.optionValues();
    return html`
      <h1>Skins</h1>
      ${this.error ? html`<p class="error">${this.error}</p>` : nothing}
      ${active?.fallbackFrom
        ? html`<p class="error">The ${active.fallbackFrom} skin failed to load this session, so ${active.name} is shown. Fix it and choose Activate again.</p>`
        : nothing}
      <div class="gallery">
        ${this.skins.map((s) => {
          const isActive = active?.id === s.id;
          const preview = this.previews[s.id];
          return html`<article class=${isActive ? "active" : ""}>
            <div class="preview">${preview ? html`<img src=${preview} alt="" />` : html`<span class="muted">No preview</span>`}</div>
            <div class="meta">
              <strong>${s.name}</strong> <span class="muted small">${s.version ?? ""}</span>
              <div class="muted small">${s.description ?? ""}</div>
              ${s.status === "error" ? html`<div class="error small">${s.errors[0]}</div>` : nothing}
            </div>
            ${isActive
              ? html`<span class="badge">Active</span>`
              : html`<button ?disabled=${s.status === "error"} @click=${() => this.activate(s.id)}>Activate</button>`}
          </article>`;
        })}
      </div>

      ${active
        ? html`<section>
            <h2>${active.name} options</h2>
            ${options.length
              ? options.map(
                  (o) => html`<div class="row">
                    <span class="label">${o.label}</span>
                    ${this.control(o, values[o.id])}
                  </div>`,
                )
              : html`<p class="muted">This skin has no options.</p>`}
            ${options.length
              ? html`<div class="row"><span class="label muted small">Changes apply live.</span><button @click=${() => api.resetSkinOptions(active.id)}>Reset options</button></div>`
              : nothing}
          </section>`
        : nothing}
    `;
  }

  static styles = [
    tokens,
    controls,
    pageStyles,
    css`
      .gallery {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
        gap: 12px;
        margin-bottom: 16px;
      }
      article {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 10px;
        border-radius: var(--v-radius);
        background: var(--v-surface);
        border: 2px solid transparent;
      }
      article.active {
        border-color: var(--v-accent);
      }
      .preview {
        aspect-ratio: 16 / 10;
        display: grid;
        place-items: center;
        border-radius: calc(var(--v-radius) - 2px);
        background: var(--v-bg);
        overflow: hidden;
      }
      .preview img {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
      .meta {
        flex: 1;
      }
      .badge {
        align-self: flex-start;
        font-size: 12px;
        padding: 2px 10px;
        border-radius: 99px;
        background: var(--v-accent);
        color: var(--v-accent-text);
      }
      article button {
        align-self: flex-start;
      }
      .value {
        min-width: 56px;
        text-align: right;
        font-variant-numeric: tabular-nums;
        color: var(--v-text-muted);
      }
    `,
  ];
}

customElements.define("vellum-skins-page", SkinsPage);
