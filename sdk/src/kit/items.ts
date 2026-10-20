// Single-entry kit items: <vellum-cover>, <vellum-hero>, <vellum-logo>, <vellum-play-button>,
// <vellum-source-badges>. Each takes `.entry` (an Entry) or an `entry-id` attribute, and
// re-renders when that entry changes in the library.

import { LitElement, css, html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { vellum } from "../core";
import type { Entry } from "../types";
import { controlStyles } from "./shared";

class EntryElement extends LitElement {
  static properties = { entry: { attribute: false }, entryId: { type: String, attribute: "entry-id" } };
  declare entry: Entry | undefined;
  declare entryId: string | undefined;
  private unsub?: () => void;

  connectedCallback() {
    super.connectedCallback();
    this.unsub = vellum.library.on("change", () => {
      const id = this.entryId ?? this.entry?.id;
      const fresh = id ? vellum.library.get(id) : undefined;
      if (fresh && fresh !== this.entry) this.entry = fresh;
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.unsub?.();
  }

  willUpdate(changed: Map<string, unknown>) {
    if (changed.has("entryId") && this.entryId) this.entry = vellum.library.get(this.entryId);
  }
}

/** A portrait cover. Sized by CSS (default --v-cover-width); loads art at that size × DPR. */
export class VellumCover extends EntryElement {
  render() {
    const e = this.entry;
    if (!e) return nothing;
    const width = this.clientWidth || undefined;
    return html`<img
      part="cover"
      src=${vellum.art.url(e.id, "cover", width)}
      alt=${e.title}
      decoding="async"
      loading="lazy"
      draggable="false"
      @load=${(ev: Event) => (ev.target as HTMLElement).classList.add("loaded")}
    />`;
  }

  static styles = css`
    :host {
      display: block;
      width: var(--v-cover-width);
      aspect-ratio: 2 / 3;
      border-radius: var(--v-radius);
      overflow: hidden;
      background: var(--v-surface);
    }
    img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
      opacity: 0;
      transition: opacity 160ms ease;
    }
    img.loaded {
      opacity: 1;
    }
  `;
}
customElements.define("vellum-cover", VellumCover);

/** Full-bleed hero art that crossfades when the entry changes. Attribute `blur` softens it. */
export class VellumHero extends EntryElement {
  static properties = { ...EntryElement.properties, blurred: { type: Boolean, reflect: true, attribute: "blur" } };
  /** Attribute `blur`: soften the art by --v-blur. */
  declare blurred: boolean;
  private layers: { url: string; id: number }[] = [];
  private seq = 0;

  constructor() {
    super();
    this.blurred = false;
  }

  willUpdate(changed: Map<string, unknown>) {
    super.willUpdate(changed);
    const e = this.entry;
    if (!e) return;
    const url = vellum.art.url(e.id, "hero", Math.max(this.clientWidth, window.innerWidth));
    if (this.layers.at(-1)?.url !== url) this.layers = [...this.layers.slice(-1), { url, id: ++this.seq }];
  }

  render() {
    return html`${repeat(
        this.layers,
        (l) => l.id,
        (l, i) =>
          html`<img
            part="hero"
            class=${i === this.layers.length - 1 ? "top" : "under"}
            data-layer=${l.id}
            src=${l.url}
            alt=""
            decoding="async"
            draggable="false"
            @load=${(ev: Event) => (ev.target as HTMLElement).classList.add("loaded")}
          />`,
      )}<div class="overlay" part="overlay"></div>`;
  }

  static styles = css`
    :host {
      display: block;
      position: relative;
      overflow: hidden;
      background: var(--v-bg);
    }
    img {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      opacity: 0;
      transition: opacity 450ms ease;
    }
    :host([blur]) img {
      filter: blur(var(--v-blur));
      transform: scale(1.06);
    }
    img.top.loaded {
      opacity: 1;
    }
    img.under {
      opacity: 1;
    }
    .overlay {
      position: absolute;
      inset: 0;
      background: var(--v-hero-overlay);
    }
  `;
}
customElements.define("vellum-hero", VellumHero);

/** The game's transparent logo, or its title set in the display font when there is none. */
export class VellumLogo extends EntryElement {
  static properties = { ...EntryElement.properties, failed: { state: true } };
  declare failed: boolean;

  constructor() {
    super();
    this.failed = false;
  }

  willUpdate(changed: Map<string, unknown>) {
    super.willUpdate(changed);
    if (changed.has("entry")) this.failed = false;
  }

  render() {
    const e = this.entry;
    if (!e) return nothing;
    if (e.artStatus.logo === "placeholder" || this.failed) {
      return html`<span class="title" part="title">${e.title}</span>`;
    }
    return html`<img
      part="logo"
      src=${vellum.art.url(e.id, "logo", this.clientWidth || undefined)}
      alt=${e.title}
      decoding="async"
      draggable="false"
      @error=${() => (this.failed = true)}
    />`;
  }

  static styles = css`
    :host {
      display: block;
    }
    img {
      display: block;
      max-width: 100%;
      max-height: var(--v-logo-max-height, 100%);
      object-fit: contain;
      object-position: left bottom;
      filter: drop-shadow(0 4px 18px rgb(0 0 0 / 0.5));
    }
    .title {
      display: block;
      font-family: var(--v-font-display);
      font-weight: 750;
      font-size: clamp(2rem, 5vw, 4.5rem);
      line-height: 1.02;
      letter-spacing: -0.02em;
      text-wrap: balance;
      text-shadow: 0 4px 24px rgb(0 0 0 / 0.55);
    }
  `;
}
customElements.define("vellum-logo", VellumLogo);

/** Play, plus Play via… when the entry has more than one source. */
export class VellumPlayButton extends EntryElement {
  static properties = { ...EntryElement.properties, open: { state: true } };
  declare open: boolean;

  constructor() {
    super();
    this.open = false;
  }

  private play(provider?: string) {
    const e = this.entry;
    this.open = false;
    if (e) vellum.actions.launch(e.id, provider).catch(() => {});
  }

  render() {
    const e = this.entry;
    if (!e) return nothing;
    const launchable = e.sources.filter((s) => s.capabilities.includes("launch"));
    const preferred = e.sources.find((s) => s.provider === e.preferredSource);
    return html`<button
        class="primary play"
        part="button"
        data-vellum-focus
        ?disabled=${!launchable.length}
        @click=${() => this.play()}
        title=${preferred ? `Play via ${preferred.providerName}` : "Play"}
      >
        <span aria-hidden="true">▶</span> Play
      </button>
      ${launchable.length > 1
        ? html`<button class="primary via" part="via" data-vellum-focus aria-haspopup="menu" aria-expanded=${this.open} @click=${() => (this.open = !this.open)}>
              Play via…
            </button>
            <div class="menu" part="menu" role="menu" ?hidden=${!this.open}>
              ${launchable.map(
                (s) => html`<button role="menuitem" data-vellum-focus @click=${() => this.play(s.provider)}>${s.providerName}</button>`,
              )}
            </div>`
        : nothing}`;
  }

  static styles = [
    controlStyles,
    css`
      :host {
        display: inline-flex;
        position: relative;
        gap: 2px;
      }
      .play {
        font-size: 1.1rem;
        padding: 0.65em 1.6em;
      }
      .via {
        padding: 0.65em 0.9em;
      }
      .menu {
        position: absolute;
        top: calc(100% + 6px);
        left: 0;
        display: flex;
        flex-direction: column;
        min-width: 12rem;
        padding: 4px;
        border-radius: var(--v-radius);
        background: var(--v-surface-raised);
        box-shadow: 0 10px 30px rgb(0 0 0 / 0.4);
        z-index: 10;
      }
      .menu button {
        justify-content: flex-start;
        background: transparent;
        border-color: transparent;
      }
    `,
  ];
}
customElements.define("vellum-play-button", VellumPlayButton);

/** One pill per store the entry comes from. */
export class VellumSourceBadges extends EntryElement {
  render() {
    const e = this.entry;
    if (!e) return nothing;
    const icons = new Map(vellum.providers.list().map((p) => [p.id, p.icon]));
    return e.sources.map((s) => {
      const icon = icons.get(s.provider);
      return html`<span class="badge" part="badge" data-provider=${s.provider}
        >${icon ? html`<img src=${icon} alt="" />` : nothing}${s.providerName}</span
      >`;
    });
  }

  static styles = css`
    :host {
      display: inline-flex;
      flex-wrap: wrap;
      gap: 0.35rem;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      padding: 0.15rem 0.6rem;
      border-radius: 99px;
      font-size: 0.75rem;
      font-weight: 600;
      background: color-mix(in srgb, var(--v-surface-raised) 80%, transparent);
      color: var(--v-text-muted);
    }
    img {
      width: 0.9rem;
      height: 0.9rem;
    }
  `;
}
customElements.define("vellum-source-badges", VellumSourceBadges);
