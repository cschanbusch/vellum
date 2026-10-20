import { LitElement, css, html, nothing } from "lit";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { api, browseForLocation, type LocationResolution, type PluginKind, type PluginView } from "../api";
import { providerPermissions } from "../permissions";
import { store } from "../store";
import { controls, tokens } from "../theme";

const TABS: { kind: PluginKind; label: string }[] = [
  { kind: "provider", label: "Providers" },
  { kind: "skin", label: "Skins" },
  { kind: "module", label: "Modules" },
];

export class PluginsPage extends LitElement {
  static properties = {
    tab: { state: true },
    plugins: { state: true },
    error: { state: true },
  };
  declare tab: PluginKind;
  declare plugins: PluginView[];
  declare error: string | null;
  private unlisten?: Promise<UnlistenFn>;

  constructor() {
    super();
    this.tab = "provider";
    this.plugins = [];
    this.error = null;
  }

  private unsubStore?: () => void;

  connectedCallback() {
    super.connectedCallback();
    this.refresh();
    this.unlisten = api.onPluginsChanged(() => this.refresh());
    this.unsubStore = store.on("providers", () => this.requestUpdate());
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.unlisten?.then((f) => f());
    this.unsubStore?.();
  }

  private async relocate(provider: string, loc: LocationResolution) {
    this.error = await browseForLocation(provider, loc.key, loc.label);
  }

  private renderProviderStatus(p: PluginView) {
    const s = store.statuses.find((x) => x.id === p.id);
    if (!p.enabled || !s) return nothing;
    const text =
      s.state === "scanning"
        ? "Scanning…"
        : s.state === "ready"
          ? `${s.games} game${s.games === 1 ? "" : "s"} · scanned in ${s.durationMs ?? 0} ms${s.message ? ` · ${s.message}` : ""}`
          : s.state === "inactive"
            ? `Inactive: ${s.message}`
            : s.state === "error"
              ? `Error: ${s.message}`
              : "Waiting";
    return html`
      <div class="pstatus ${s.state}">${text}</div>
      ${s.locations.map(
        (l) => html`<div class="loc small">
          <span><span class="muted">${l.label}:</span> ${l.path ?? "not found"}</span>
          <button @click=${() => this.relocate(p.id, l)}>Re-locate…</button>
        </div>`,
      )}
    `;
  }

  private async refresh() {
    try {
      this.plugins = await api.listPlugins();
    } catch (e) {
      this.error = String(e);
    }
  }

  private async run(action: Promise<unknown>) {
    try {
      this.error = null;
      await action;
    } catch (e) {
      this.error = String(e);
    }
  }

  render() {
    const shown = this.plugins.filter((p) => p.kind === this.tab);
    return html`
      <div class="head">
        <h1>Plugins</h1>
        <span class="spacer"></span>
        <button disabled title="Arrives in Phase 6">Install plugin…</button>
        <button @click=${() => this.run(api.reloadPlugins())}>Reload plugins</button>
        <button @click=${() => this.run(api.openPluginsFolder())}>Open plugins folder</button>
      </div>
      <div class="tabs" role="tablist">
        ${TABS.map((t) => {
          const n = this.plugins.filter((p) => p.kind === t.kind).length;
          return html`<button
            role="tab"
            aria-selected=${t.kind === this.tab}
            class=${t.kind === this.tab ? "active" : ""}
            @click=${() => (this.tab = t.kind)}
          >
            ${t.label} <span class="count">${n}</span>
          </button>`;
        })}
      </div>
      ${this.error ? html`<p class="error-banner">${this.error}</p>` : nothing}
      ${shown.length === 0 ? html`<p class="muted">No plugins of this type were found.</p>` : nothing}
      <ul>
        ${shown.map((p) => this.renderPlugin(p))}
      </ul>
    `;
  }

  private renderPlugin(p: PluginView) {
    const broken = p.status === "error";
    const perms = p.kind === "provider" ? providerPermissions(p.section) : [];
    return html`
      <li class=${broken ? "broken" : ""}>
        <div class="row">
          <div class="avatar" aria-hidden="true">${p.name.slice(0, 1).toUpperCase()}</div>
          <div class="title">
            <div>
              <strong>${p.name}</strong>
              ${p.version ? html`<span class="muted">v${p.version}</span>` : nothing}
              <span class="badge ${p.enabled || p.status !== "ok" ? p.status : "off"}"
                >${broken ? "Error" : p.status === "warning" ? "Warning" : p.enabled ? "Active" : "Off"}</span
              >
            </div>
            <div class="muted small">
              ${p.description ?? ""}${p.author ? html` · by ${p.author}` : nothing}
            </div>
          </div>
          <div class="actions">${this.renderToggle(p, broken)}</div>
        </div>
        ${p.kind === "provider" ? html`<div class="provider-runtime">${this.renderProviderStatus(p)}</div>` : nothing}
        ${p.errors.length
          ? html`<ul class="issues error">
              ${p.errors.map((e) => html`<li>${e}</li>`)}
            </ul>`
          : nothing}
        ${p.warnings.length
          ? html`<ul class="issues warning">
              ${p.warnings.map((w) => html`<li>${w}</li>`)}
            </ul>`
          : nothing}
        ${perms.length
          ? html`<details>
              <summary>Permissions (${perms.length})</summary>
              <ul class="perms">
                ${perms.map((x) => html`<li>${x.text}</li>`)}
              </ul>
            </details>`
          : nothing}
        <div class="muted small folder">${p.id} · ${p.folder}</div>
      </li>
    `;
  }

  private renderToggle(p: PluginView, broken: boolean) {
    if (p.kind === "skin") {
      return p.enabled
        ? html`<span class="muted">Current skin</span>`
        : html`<button class="primary" ?disabled=${broken} @click=${() => this.run(api.activateSkin(p.id))}>
            Activate
          </button>`;
    }
    return html`<label class="switch">
      <input
        type="checkbox"
        .checked=${p.enabled}
        ?disabled=${broken}
        @change=${(e: Event) => this.run(api.setPluginEnabled(p.kind, p.id, (e.target as HTMLInputElement).checked))}
      />
      <span>${p.enabled ? "Enabled" : "Disabled"}</span>
    </label>`;
  }

  static styles = [
    tokens,
    controls,
    css`
      .head {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 12px;
      }
      h1 {
        font-size: 22px;
        font-weight: 600;
        margin: 0;
      }
      .spacer {
        flex: 1;
      }
      .tabs {
        display: flex;
        gap: 4px;
        border-bottom: 1px solid #222838;
        margin-bottom: 14px;
      }
      .tabs button {
        background: transparent;
        border: 0;
        border-bottom: 2px solid transparent;
        border-radius: 0;
      }
      .tabs button.active {
        color: var(--v-accent);
        border-bottom-color: var(--v-accent);
      }
      .count {
        color: var(--v-text-muted);
        font-size: 12px;
      }
      ul {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      li {
        background: var(--v-surface);
        border-radius: var(--v-radius);
        padding: 12px 14px;
        margin-bottom: 10px;
        border: 1px solid transparent;
      }
      li.broken {
        border-color: color-mix(in srgb, var(--v-danger) 45%, transparent);
      }
      .row {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .avatar {
        width: 36px;
        height: 36px;
        border-radius: 8px;
        display: grid;
        place-items: center;
        background: var(--v-surface-raised);
        color: var(--v-accent);
        font-weight: 700;
      }
      .title {
        flex: 1;
        min-width: 0;
      }
      .badge {
        font-size: 11px;
        padding: 1px 7px;
        border-radius: 99px;
        margin-left: 6px;
        background: var(--v-surface-raised);
        color: var(--v-ok);
      }
      .badge.error {
        color: var(--v-danger);
      }
      .badge.warning {
        color: var(--v-warning);
      }
      .badge.off {
        color: var(--v-text-muted);
      }
      .muted {
        color: var(--v-text-muted);
      }
      .small {
        font-size: 12px;
      }
      .folder {
        margin-top: 6px;
        word-break: break-all;
      }
      .issues {
        margin: 8px 0 0 48px;
      }
      .issues li {
        background: none;
        padding: 0 0 2px;
        margin: 0;
        font-size: 13px;
      }
      .issues.error li::before {
        content: "✕ ";
        color: var(--v-danger);
      }
      .issues.warning li::before {
        content: "! ";
        color: var(--v-warning);
      }
      details {
        margin: 8px 0 0 48px;
        font-size: 13px;
      }
      summary {
        cursor: pointer;
        color: var(--v-text-muted);
      }
      .perms li {
        background: none;
        padding: 2px 0;
        margin: 0;
      }
      .switch {
        display: flex;
        align-items: center;
        gap: 6px;
        cursor: pointer;
      }
      .switch input {
        width: 18px;
        height: 18px;
        accent-color: var(--v-accent);
      }
      .provider-runtime {
        margin: 6px 0 0 48px;
      }
      .pstatus {
        font-size: 13px;
        color: var(--v-ok);
      }
      .pstatus.inactive,
      .pstatus.scanning {
        color: var(--v-warning);
      }
      .pstatus.error {
        color: var(--v-danger);
      }
      .loc {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-top: 4px;
        word-break: break-all;
      }
      .loc button {
        padding: 2px 10px;
        font-size: 12px;
        flex: none;
      }
      .error-banner {
        background: color-mix(in srgb, var(--v-danger) 15%, transparent);
        color: var(--v-danger);
        padding: 8px 12px;
        border-radius: var(--v-radius);
      }
    `,
  ];
}

customElements.define("vellum-plugins-page", PluginsPage);
