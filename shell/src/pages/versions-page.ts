// Settings → Versions: the installed versions of Vellum and the releases on GitHub. Download a
// release (optionally with the extras), switch to it (Vellum restarts into it), and remove or
// download again the versions you don't want. See src-tauri/src/versions.rs.
import { LitElement, css, html, nothing } from "lit";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { api, type InstalledVersion, type Release, type VersionProgress, type VersionsView } from "../api";
import { toasts } from "../toasts";
import { controls, tokens } from "../theme";
import { pageStyles } from "./page-styles";

const PRERELEASES_KEY = "vellum.versions.prereleases";
const EXTRAS_KEY = "vellum.versions.extras";

function load(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}
function save(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    // Not remembered; the default applies next time.
  }
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB`;
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "");

/** Newer-than for "x.y.z[-pre]" strings. */
function newer(a: string, b: string): boolean {
  const parse = (s: string) => {
    const [core, pre] = s.split("-", 2);
    return { n: core.split(".").map((x) => Number(x) || 0), pre: pre ?? null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.n[i] ?? 0) !== (y.n[i] ?? 0)) return (x.n[i] ?? 0) > (y.n[i] ?? 0);
  if (x.pre === y.pre) return false;
  return x.pre === null || (y.pre !== null && x.pre > y.pre);
}

export class VersionsPage extends LitElement {
  static properties = {
    view: { state: true },
    loading: { state: true },
    busy: { state: true },
    progress: { state: true },
    confirming: { state: true },
    prereleases: { state: true },
    extras: { state: true },
  };
  declare view: VersionsView | null;
  declare loading: boolean;
  /** Tag being installed, or version being removed / switched to. */
  declare busy: string | null;
  declare progress: VersionProgress | null;
  /** "remove:<v>" or "switch:<v>" awaiting a second click. */
  declare confirming: string | null;
  declare prereleases: boolean;
  declare extras: boolean;
  private unlisten?: Promise<UnlistenFn>;
  /** Releases are fetched once per session when the page first opens. */
  private static fetched = false;

  constructor() {
    super();
    this.view = null;
    this.loading = false;
    this.busy = null;
    this.progress = null;
    this.confirming = null;
    this.prereleases = load(PRERELEASES_KEY, false);
    this.extras = load(EXTRAS_KEY, true);
  }

  connectedCallback() {
    super.connectedCallback();
    this.unlisten = api.onVersionProgress((p) => (this.progress = p));
    void this.refresh(!VersionsPage.fetched);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    void this.unlisten?.then((u) => u());
  }

  private async refresh(fetch: boolean) {
    this.loading = fetch;
    try {
      this.view = await api.versionsInfo(fetch);
      if (fetch && !this.view.releasesError) VersionsPage.fetched = true;
    } catch (e) {
      toasts().show(String(e), true);
    } finally {
      this.loading = false;
    }
  }

  private async install(r: Release) {
    this.busy = r.tag;
    this.progress = null;
    try {
      await api.versionInstall(r.tag, this.extras && !!r.extras);
      toasts().show(`Vellum ${r.version} is installed. Switch to it from Installed versions.`);
    } catch (e) {
      toasts().show(String(e), true);
    } finally {
      this.busy = null;
      this.progress = null;
      await this.refresh(false);
    }
  }

  /** Two clicks: the first arms the button, the second does it. */
  private confirm(key: string, run: () => Promise<void>) {
    if (this.confirming !== key) {
      this.confirming = key;
      return;
    }
    this.confirming = null;
    void run();
  }

  private async removeVersion(v: InstalledVersion) {
    this.busy = v.version;
    try {
      await api.versionRemove(v.version);
      toasts().show(`Removed Vellum ${v.version}.`);
    } catch (e) {
      toasts().show(String(e), true);
    } finally {
      this.busy = null;
      await this.refresh(false);
    }
  }

  private async activate(v: InstalledVersion) {
    this.busy = v.version;
    try {
      await api.versionActivate(v.version); // Vellum restarts into it
    } catch (e) {
      toasts().show(String(e), true);
      this.busy = null;
    }
  }

  private renderInstalled(view: VersionsView) {
    const active = view.active?.active ?? view.running;
    const releaseFor = (v: string) => view.releases?.find((r) => r.version === v && !r.unavailable);
    return html`<section>
      <h2>Installed versions</h2>
      ${view.installed.length === 0 ? html`<p class="muted small">None yet.</p>` : nothing}
      ${view.installed.map((v) => {
        const running = v.version === view.running;
        const starts = v.version === active;
        const rel = releaseFor(v.version);
        const busy = this.busy === v.version || this.busy === rel?.tag;
        return html`<div class="row version">
          <div class="label">
            <strong>${v.version}</strong>
            ${running ? html`<span class="pill">Running</span>` : nothing}
            ${starts && !running ? html`<span class="pill accent">Starts next</span>` : nothing}
            ${starts && running ? html`<span class="pill accent">Starts with Vellum</span>` : nothing}
            <div class="muted small">
              ${mb(v.sizeBytes)}${v.extras ? " · with extras" : " · core only"}${v.installedAt ? ` · installed ${day(v.installedAt)}` : ""}
            </div>
          </div>
          ${!starts
            ? html`<button class="primary" ?disabled=${!!this.busy} @click=${() => this.confirm(`switch:${v.version}`, () => this.activate(v))}>
                ${this.confirming === `switch:${v.version}` ? "Restart into it" : "Switch to"}
              </button>`
            : nothing}
          ${rel && !running
            ? html`<button ?disabled=${!!this.busy} @click=${() => this.install(rel)}>${busy ? "Downloading…" : "Download again"}</button>`
            : nothing}
          ${!running && !starts
            ? html`<button class="danger" ?disabled=${!!this.busy} @click=${() => this.confirm(`remove:${v.version}`, () => this.removeVersion(v))}>
                ${this.confirming === `remove:${v.version}` ? "Click again to remove" : "Remove"}
              </button>`
            : nothing}
        </div>`;
      })}
      <div class="row">
        <span class="label muted small">Your settings, library and plugins are shared by every version. Vellum backs up its data before switching.</span>
        <button @click=${() => api.openVersionsFolder().catch((e) => toasts().show(String(e), true))}>Open versions folder</button>
      </div>
    </section>`;
  }

  private renderRelease(view: VersionsView, r: Release) {
    const installed = view.installed.some((v) => v.version === r.version) || r.version === view.running;
    const mine = this.busy === r.tag;
    const p = mine ? this.progress : null;
    const pct = p && p.phase === "download" && p.total ? Math.round((p.done / p.total) * 100) : null;
    return html`<div class="row release">
      <div class="label">
        <strong>${r.name}</strong>
        ${r.prerelease ? html`<span class="pill warn">Pre-release</span>` : nothing}
        ${installed ? html`<span class="pill">Installed</span>` : nothing}
        <div class="muted small">
          ${r.version}${r.publishedAt ? ` · ${day(r.publishedAt)}` : ""}${r.core ? ` · ${mb(r.core.size)}` : ""}${r.extras && this.extras
            ? ` + ${mb(r.extras.size)} extras`
            : ""}
        </div>
        ${r.unavailable ? html`<div class="muted small">${r.unavailable}</div>` : nothing}
        ${mine && p
          ? html`<div class="progress" role="progressbar" aria-valuenow=${pct ?? 0}>
              <i style="width:${p.phase === "download" ? (pct ?? 0) : 100}%"></i>
              <span>${p.phase === "download" ? `Downloading ${p.file} · ${pct ?? 0}%` : p.phase === "extract" ? `Unpacking ${p.file}…` : "Done"}</span>
            </div>`
          : nothing}
        ${r.notes.trim()
          ? html`<details>
              <summary class="small">Release notes</summary>
              <pre class="notes">${r.notes.trim()}</pre>
            </details>`
          : nothing}
      </div>
      ${!installed && !r.unavailable && view.managed
        ? html`<button class="primary" ?disabled=${!!this.busy} @click=${() => this.install(r)}>${mine ? "Downloading…" : "Download"}</button>`
        : nothing}
      <button @click=${() => api.openReleasePage(r.url).catch((e) => toasts().show(String(e), true))}>On GitHub</button>
    </div>`;
  }

  render() {
    const view = this.view;
    if (!view) return html`<h1>Versions</h1><p class="muted">Loading…</p>`;
    const releases = (view.releases ?? []).filter((r) => this.prereleases || !r.prerelease);
    const newest = releases.find((r) => !r.unavailable);
    const update = newest && newer(newest.version, view.running) && !view.installed.some((v) => v.version === newest.version) ? newest : null;
    const rolledBack = view.active?.rolledBackFrom;
    return html`
      <h1>Versions</h1>
      <section>
        <div class="row">
          <div class="label">
            <strong>Vellum ${view.running}</strong>
            <div class="muted small">Releases come from <code>github.com/${view.repo}</code>. Nothing downloads unless you ask.</div>
          </div>
          <button ?disabled=${this.loading} @click=${() => this.refresh(true)}>${this.loading ? "Checking…" : "Check for updates"}</button>
        </div>
        ${update ? html`<p class="update">Vellum ${update.version} is available.</p>` : nothing}
        ${rolledBack
          ? html`<p class="error small">Vellum ${rolledBack} didn't start, so Vellum went back to ${view.active?.active}. You can try it again, or remove it.</p>`
          : nothing}
        ${!view.managed
          ? html`<p class="muted small">
              This copy of Vellum isn't a managed install (it's a development build, or an older download), so it can list releases but not
              install them. Download a release from GitHub to get version management.
            </p>`
          : nothing}
      </section>
      ${view.managed ? this.renderInstalled(view) : nothing}
      <section>
        <h2>Releases</h2>
        <div class="row">
          <label for="pre" class="small">Show pre-releases</label>
          <input id="pre" type="checkbox" .checked=${this.prereleases} @change=${(e: Event) => {
            this.prereleases = (e.target as HTMLInputElement).checked;
            save(PRERELEASES_KEY, this.prereleases);
          }} />
        </div>
        <div class="row">
          <label for="extras" class="small">Download the extras too (the other skins and the modules)</label>
          <input id="extras" type="checkbox" .checked=${this.extras} @change=${(e: Event) => {
            this.extras = (e.target as HTMLInputElement).checked;
            save(EXTRAS_KEY, this.extras);
          }} />
        </div>
        ${view.releasesError ? html`<p class="error small">${view.releasesError}</p>` : nothing}
        ${!view.releases && !view.releasesError ? html`<p class="muted small">${this.loading ? "Checking GitHub…" : "Not checked yet."}</p>` : nothing}
        ${view.releases && releases.length === 0 ? html`<p class="muted small">No releases yet.</p>` : nothing}
        ${releases.map((r) => this.renderRelease(view, r))}
      </section>
    `;
  }

  static styles = [
    tokens,
    controls,
    pageStyles,
    css`
      .pill {
        display: inline-block;
        margin-left: 6px;
        padding: 1px 8px;
        border-radius: 999px;
        font-size: 12px;
        background: var(--v-surface-raised);
        color: var(--v-text-muted);
        vertical-align: 1px;
      }
      .pill.accent {
        background: color-mix(in srgb, var(--v-accent) 25%, transparent);
        color: var(--v-text);
      }
      .pill.warn {
        background: color-mix(in srgb, #e0a020 25%, transparent);
        color: var(--v-text);
      }
      .update {
        margin: 4px 0 0;
        font-weight: 600;
        color: var(--v-accent);
      }
      .release,
      .version {
        align-items: flex-start;
      }
      .progress {
        position: relative;
        margin-top: 6px;
        height: 20px;
        border-radius: 4px;
        overflow: hidden;
        background: var(--v-surface-raised);
        font-size: 12px;
      }
      .progress i {
        position: absolute;
        inset: 0 auto 0 0;
        background: color-mix(in srgb, var(--v-accent) 45%, transparent);
        transition: width 120ms linear;
      }
      .progress span {
        position: relative;
        padding: 0 8px;
        line-height: 20px;
      }
      details {
        margin-top: 6px;
      }
      summary {
        cursor: pointer;
        color: var(--v-text-muted);
      }
      .notes {
        margin: 6px 0 0;
        padding: 8px 10px;
        max-height: 220px;
        overflow: auto;
        white-space: pre-wrap;
        font: 13px/1.45 inherit;
        background: var(--v-surface-raised);
        border-radius: var(--v-radius);
      }
      button.danger {
        color: var(--v-danger);
      }
    `,
  ];
}

customElements.define("vellum-versions-page", VersionsPage);
