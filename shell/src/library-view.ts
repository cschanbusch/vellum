import { LitElement, css, html, nothing } from "lit";
import { api, browseForLocation, type ActionKind } from "./api";
import { SkinBridge } from "./bridge";
import { store } from "./store";
import { controls, tokens } from "./theme";
import { toasts } from "./toasts";

const SKIN_ORIGIN = navigator.userAgent.includes("Windows") ? "http://skin.localhost" : "skin://localhost";

const ACTION_VERB: Record<ActionKind, string> = {
  launch: "Launching",
  install: "Installing",
  uninstall: "Uninstalling",
  openStore: "Opening the store page for",
};

/** Hosts the active skin in a sandboxed iframe, plus the shell's notice bar. */
export class LibraryView extends LitElement {
  static properties = { notices: { state: true }, noticeErrors: { state: true } };
  declare notices: typeof store.notices;
  declare noticeErrors: Record<string, string>;
  private bridge?: SkinBridge;
  private unsubs: (() => void)[] = [];
  private providerNames = new Map<string, string>();

  constructor() {
    super();
    this.notices = [];
    this.noticeErrors = {};
  }

  connectedCallback() {
    super.connectedCallback();
    this.unsubs.push(
      store.on("library", () => this.bridge?.push("library", store.entries)),
      store.on("state", () => this.bridge?.push("state", store.state)),
      store.on("providers", () => {
        this.notices = store.notices;
        this.bridge?.push("providers", store.providerInfo(this.providerNames));
      }),
    );
    this.notices = store.notices;
    api.listPlugins().then((ps) => ps.forEach((p) => this.providerNames.set(p.id, p.name)));
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.unsubs.forEach((u) => u());
    this.bridge?.dispose();
  }

  firstUpdated() {
    const frame = this.renderRoot.querySelector("iframe")!;
    this.bridge = new SkinBridge(frame, SKIN_ORIGIN, {
      init: () => ({ library: store.entries, state: store.state, providers: store.providerInfo(this.providerNames) }),
      setState: (partial) => store.setState(partial),
      hasEntry: (id) => !!store.entry(id),
      toast: (text) => toasts().show(text),
      action: (kind, id, provider) => this.runAction(kind, id, provider),
    });
    // The listener is in place before the skin loads, so its hello is never missed.
    frame.src = `${SKIN_ORIGIN}/index.html`;
  }

  /** Reloads the skin page; the shell keeps its state, so the selection survives. */
  reloadSkin() {
    const frame = this.renderRoot.querySelector("iframe");
    if (frame) frame.src = `${SKIN_ORIGIN}/index.html`;
  }

  async runAction(kind: ActionKind, id: string, provider?: string) {
    const title = store.entry(id)?.title ?? id;
    try {
      const r = await api.runAction(id, kind, provider);
      toasts().show(`${ACTION_VERB[kind]} ${r.title} via ${r.providerName}`);
    } catch (e) {
      toasts().show(`Couldn't ${kind === "openStore" ? "open the store page for" : kind} ${title}: ${e}`, true);
      throw e;
    }
  }

  private async browse(n: (typeof store.notices)[number]) {
    const error = await browseForLocation(n.provider, n.key, n.label);
    this.noticeErrors = { ...this.noticeErrors, [n.id]: error ?? "" };
  }

  private async disable(n: (typeof store.notices)[number]) {
    await api.setPluginEnabled("provider", n.provider, false);
  }

  render() {
    return html`
      ${this.notices.length
        ? html`<div class="notices">
            ${this.notices.map(
              (n) => html`<div class="notice" role="alert">
                <span class="msg">${n.message}.</span>
                ${this.noticeErrors[n.id] ? html`<span class="err">${this.noticeErrors[n.id]}</span>` : nothing}
                <span class="spacer"></span>
                <button class="primary" @click=${() => this.browse(n)}>Browse…</button>
                <button @click=${() => api.dismissNotice(n.id)}>Skip for now</button>
                <button @click=${() => this.disable(n)}>Disable ${n.providerName}</button>
              </div>`,
            )}
          </div>`
        : nothing}
      <iframe sandbox="allow-scripts allow-same-origin" title="Library"></iframe>
    `;
  }

  static styles = [
    tokens,
    controls,
    css`
      :host {
        display: flex;
        flex-direction: column;
        min-height: 0;
        flex: 1;
      }
      iframe {
        flex: 1;
        width: 100%;
        border: 0;
        background: var(--v-bg);
      }
      .notices {
        display: flex;
        flex-direction: column;
        gap: 1px;
      }
      .notice {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 16px;
        background: color-mix(in srgb, var(--v-warning) 14%, var(--v-surface));
        font-size: 14px;
      }
      .err {
        color: var(--v-danger);
      }
      .spacer {
        flex: 1;
      }
    `,
  ];
}

customElements.define("vellum-library-view", LibraryView);
