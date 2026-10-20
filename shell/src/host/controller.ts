// The skin host: owns the UI state every view shares, answers the skin's bridge calls, and
// keeps the skin up to date. It knows nothing about Tauri (see backend.ts), so the skin dev
// harness runs exactly this code against the mock library.

import type { CallMethod, InitData, NavName, ShellEvent } from "../../../sdk/src/protocol";
import {
  DEFAULT_STATE,
  type ArtKind,
  type Entry,
  type Filters,
  type GroupKey,
  type ProviderInfo,
  type ShelfPrefs,
  type SkinInfo,
  type SkinOption,
  type Sort,
  type UiState,
  type ViewInfo,
} from "../../../sdk/src/types";
import { availableViews, orderViews, type OrderedView, type SkinViewSection } from "../../../sdk/src/view-order";
import { SkinBridge } from "../bridge";
import type { ActionKind, Backend, SkinRecord, UiSettings, WindowState } from "./backend";

/** What the host page draws on the controller's behalf. */
export interface HostUi {
  toast(text: string, error?: boolean): void;
  /** `x`/`y` are in the skin's viewport; the host adds the frame's offset. */
  contextMenu(entry: Entry, x: number, y: number): void;
  openSettings(page?: string): void;
  changeArt(entry: Entry, kind: ArtKind): void;
  theme(tokens: Record<string, string>): void;
  devError(message: string, stack: string): void;
  /** The skin page never said hello: it is broken. */
  skinFailed(reason: string): void;
}

type Topic = "state" | "library" | "views" | "skin" | "providers" | "window";

const ACTION_VERB: Record<ActionKind, string> = {
  launch: "Launching",
  install: "Installing",
  uninstall: "Uninstalling",
  openStore: "Opening the store page for",
};

const HELLO_TIMEOUT_MS = 6000;

export class SkinHostController {
  entries: Entry[] = [];
  providers: ProviderInfo[] = [];
  state: UiState = { ...DEFAULT_STATE };
  skin: SkinRecord | null = null;
  ui: UiSettings = { startView: "last", last: {}, views: {}, shelves: {}, skinsSeen: [], devMode: false };
  views: OrderedView[] = [];
  window: WindowState = { maximized: false, fullscreen: false };
  private byId = new Map<string, Entry>();
  private bridge: SkinBridge | null = null;
  private frame: HTMLIFrameElement | null = null;
  private origin = "";
  private listeners = new Map<Topic, Set<() => void>>();
  private persistTimer = 0;
  private helloTimer = 0;
  private started = false;

  constructor(
    readonly backend: Backend,
    private hostUi: HostUi,
  ) {}

  on(topic: Topic, cb: () => void): () => void {
    let set = this.listeners.get(topic);
    if (!set) this.listeners.set(topic, (set = new Set()));
    set.add(cb);
    return () => set!.delete(cb);
  }

  private emit(topic: Topic) {
    this.listeners.get(topic)?.forEach((cb) => cb());
  }

  private push(ev: ShellEvent) {
    this.bridge?.push(ev);
  }

  // ---- startup -----------------------------------------------------------------------------

  async start() {
    const [entries, providers, skin, ui, win] = await Promise.all([
      this.backend.entries(),
      this.backend.providers(),
      this.backend.skin(),
      this.backend.uiSettings(),
      this.backend.window("info").catch(() => this.window),
    ]);
    this.setEntries(entries);
    this.providers = providers;
    this.ui = ui;
    this.skin = skin;
    this.window = win;
    this.views = this.computeViews();
    const last = ui.last ?? {};
    this.state = {
      ...DEFAULT_STATE,
      view: ui.startView === "last" ? (last.view ?? DEFAULT_STATE.view) : ui.startView,
      selectedId: last.selectedId && this.byId.has(last.selectedId) ? last.selectedId : null,
      sort: (last.sort as Sort) ?? DEFAULT_STATE.sort,
      groupBy: (last.groupBy as GroupKey | null) ?? null,
      filters: (last.filters as Filters) ?? {},
    };
    this.applyDefaultViewOnce();
    this.state.view = this.validView(this.state.view);
    this.started = true;

    this.backend.onLibraryChanged(() => void this.reloadLibrary());
    this.backend.onProvidersChanged(() => void this.reloadProviders());
    this.backend.onSkinChanged(() => void this.reloadSkin());
    this.backend.onSkinFileChanged((path) => this.skinFileChanged(path));
    this.backend.onWindowChanged(() => void this.backend.window("info").then((w) => this.setWindow(w)));
  }

  /** The first time a skin is active, its `defaultView` is selected once. */
  private applyDefaultViewOnce() {
    const s = this.skin;
    if (!s || this.ui.skinsSeen.includes(s.id)) return;
    const dv = s.section.defaultView;
    if (typeof dv === "string" && this.available().some((v) => v.id === dv)) this.state.view = dv;
    this.ui = { ...this.ui, skinsSeen: [...this.ui.skinsSeen, s.id] };
    void this.backend.updateUi({ skinsSeen: this.ui.skinsSeen });
  }

  private setEntries(entries: Entry[]) {
    this.entries = entries;
    this.byId = new Map(entries.map((e) => [e.id, e]));
  }

  entry(id: string): Entry | undefined {
    return this.byId.get(id);
  }

  // ---- skin frame ----------------------------------------------------------------------------

  /** Connects a skin iframe; the bridge listens before the page loads, so hello isn't missed. */
  attach(frame: HTMLIFrameElement, origin: string, url: string) {
    this.detach();
    this.frame = frame;
    this.origin = origin;
    this.bridge = new SkinBridge(frame, origin, {
      hasEntry: (id) => this.byId.has(id),
      hasView: (id) => this.available().some((v) => v.id === id),
      init: () => this.init(),
      call: (m, a) => this.call(m, a),
    });
    frame.src = url;
    this.armHelloTimer();
  }

  detach() {
    this.bridge?.dispose();
    this.bridge = null;
    clearTimeout(this.helloTimer);
  }

  /** Reloads the skin page; state lives here, so the selection and view survive. */
  reloadSkinPage() {
    if (!this.frame) return;
    const url = new URL(this.frame.src);
    url.searchParams.set("r", String(Date.now()));
    this.frame.src = url.href;
    this.armHelloTimer();
  }

  private armHelloTimer() {
    clearTimeout(this.helloTimer);
    this.helloTimer = window.setTimeout(() => this.hostUi.skinFailed("The skin page didn't load the SDK."), HELLO_TIMEOUT_MS);
  }

  private init(): InitData {
    clearTimeout(this.helloTimer);
    return {
      library: this.entries,
      state: this.state,
      providers: this.providers,
      views: this.viewInfos(),
      skin: this.skinInfo(),
      shelves: this.shelves(),
      window: { maximized: this.window.maximized, frameless: this.frameless() },
    };
  }

  // ---- derived -------------------------------------------------------------------------------

  private computeViews(): OrderedView[] {
    return orderViews((this.skin?.section ?? {}) as SkinViewSection, this.ui.views ?? {});
  }

  available(): OrderedView[] {
    return availableViews(this.views, this.state.couch);
  }

  private viewInfos(): ViewInfo[] {
    return this.available().map(({ hidden: _h, ...v }) => v);
  }

  private validView(id: string): string {
    const list = this.available();
    return list.some((v) => v.id === id) ? id : (list[0]?.id ?? "list");
  }

  options(): SkinOption[] {
    return (Array.isArray(this.skin?.section.options) ? this.skin!.section.options : []) as SkinOption[];
  }

  /** Option values with manifest defaults filled in. */
  optionValues(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const o of this.options()) out[o.id] = this.skin?.values[o.id] ?? o.default;
    return out;
  }

  private skinInfo(): SkinInfo {
    return {
      id: this.skin?.id ?? "",
      name: this.skin?.name ?? "",
      options: this.options(),
      values: this.optionValues(),
      dev: this.skin?.dev ?? false,
    };
  }

  shelves(): ShelfPrefs {
    return { order: this.ui.shelves?.order ?? {}, collapsed: this.ui.shelves?.collapsed ?? [] };
  }

  frameless(): boolean {
    const w = this.skin?.section.window as { frameless?: boolean } | undefined;
    return w?.frameless === true;
  }

  // ---- state ---------------------------------------------------------------------------------

  setState(partial: Partial<UiState>) {
    const next = { ...this.state, ...partial };
    if (partial.view !== undefined || partial.couch !== undefined) next.view = this.validView(next.view);
    this.state = next;
    this.push({ name: "state", data: this.state });
    this.emit("state");
    this.persist();
  }

  private persist() {
    clearTimeout(this.persistTimer);
    this.persistTimer = window.setTimeout(() => {
      const { view, selectedId, sort, groupBy, filters } = this.state;
      void this.backend.updateUi({ last: { view, selectedId, sort, groupBy, filters: filters as Record<string, unknown> } });
    }, 600);
  }

  switchView(id: string) {
    if (this.available().some((v) => v.id === id)) this.setState({ view: id });
  }

  cycleView(delta: number) {
    const list = this.available();
    const i = list.findIndex((v) => v.id === this.state.view);
    if (list.length) this.setState({ view: list[(i + delta + list.length) % list.length].id });
  }

  /** Switches by hotkey ("Ctrl+2"); true if a view has that key. */
  switchByHotkey(key: string): boolean {
    const v = this.available().find((x) => x.hotkey === key);
    if (v) this.switchView(v.id);
    return !!v;
  }

  async toggleCouch() {
    const couch = !this.state.couch;
    this.state = { ...this.state, couch };
    this.push({ name: "views", data: this.viewInfos() });
    this.setState({ couch });
    this.emit("views");
    try {
      const w = await this.backend.window("toggleFullscreen");
      if (w.fullscreen !== couch) await this.backend.window("toggleFullscreen");
    } catch {
      // The harness has no window to make fullscreen.
    }
  }

  /** Sends a nav event to the skin (controller input, harness panel). */
  nav(name: NavName) {
    this.push({ name: "nav", data: { name } });
  }

  // ---- reloads -------------------------------------------------------------------------------

  async reloadLibrary() {
    this.setEntries(await this.backend.entries());
    this.push({ name: "library", data: this.entries });
    if (this.state.selectedId && !this.byId.has(this.state.selectedId)) this.setState({ selectedId: null });
    this.emit("library");
  }

  async reloadProviders() {
    this.providers = await this.backend.providers();
    this.push({ name: "providers", data: this.providers });
    this.emit("providers");
  }

  async reloadUi() {
    this.ui = await this.backend.uiSettings();
    this.refreshViews();
    this.push({ name: "shelves", data: this.shelves() });
  }

  /** The skin was switched, or its options changed. */
  async reloadSkin() {
    const before = this.skin;
    this.skin = await this.backend.skin();
    const switched = before?.id !== this.skin?.id;
    if (switched) {
      this.applyDefaultViewOnce();
      this.refreshViews();
      this.emit("skin");
      if (this.frame) this.reloadSkinPage();
      return;
    }
    this.push({ name: "skin", data: this.skinInfo() });
    this.refreshViews(); // a changed manifest may add views
    if (before?.dev !== this.skin?.dev) this.reloadSkinPage();
    this.emit("skin");
  }

  /** User view order or visibility changed. */
  refreshViews() {
    this.views = this.computeViews();
    this.push({ name: "views", data: this.viewInfos() });
    const view = this.validView(this.state.view);
    if (view !== this.state.view) this.setState({ view });
    this.emit("views");
  }

  async updateViewPrefs(prefs: UiSettings["views"]) {
    this.ui = await this.backend.updateUi({ views: prefs });
    this.refreshViews();
  }

  private setWindow(w: WindowState) {
    this.window = w;
    this.push({ name: "window", data: { maximized: w.maximized, frameless: this.frameless() } });
    this.emit("window");
  }

  private skinFileChanged(path: string) {
    if (path.toLowerCase().endsWith(".css")) this.push({ name: "devCss", data: { path } });
    else if (path !== "plugin.json") this.reloadSkinPage();
    else void this.reloadSkin();
  }

  // ---- per-game changes ----------------------------------------------------------------------

  private patch(e: Entry) {
    const i = this.entries.findIndex((x) => x.id === e.id);
    if (i >= 0) this.entries[i] = e;
    this.byId.set(e.id, e);
    this.push({ name: "entries", data: [e] });
    this.emit("library");
  }

  async toggleFavorite(id: string) {
    const e = this.byId.get(id);
    if (e) this.patch(await this.backend.setFavorite(id, !e.favorite));
  }

  async setHidden(id: string, hidden: boolean) {
    const e = await this.backend.setHidden(id, hidden);
    this.patch(e);
    this.hostUi.toast(hidden ? `${e.title} is hidden. Show hidden games from Filters.` : `${e.title} is no longer hidden.`);
  }

  async setTags(id: string, tags: string[]) {
    this.patch(await this.backend.setTags(id, tags));
  }

  async runAction(kind: ActionKind, id: string, provider?: string) {
    const title = this.byId.get(id)?.title ?? id;
    try {
      const r = await this.backend.runAction(id, kind, provider);
      this.hostUi.toast(`${ACTION_VERB[kind]} ${r.title} via ${r.providerName}`);
    } catch (e) {
      this.hostUi.toast(`Couldn't ${kind === "openStore" ? "open the store page for" : kind} ${title}: ${e}`, true);
      throw e;
    }
  }

  async shelvesSet(patch: Partial<ShelfPrefs>) {
    const shelves = { ...this.shelves(), ...patch } as UiSettings["shelves"];
    this.ui = await this.backend.updateUi({ shelves });
    this.push({ name: "shelves", data: this.shelves() });
  }

  // ---- bridge calls --------------------------------------------------------------------------

  async call(method: CallMethod, a: Record<string, unknown>): Promise<unknown> {
    const id = a.id as string;
    switch (method) {
      case "state.set":
        return this.setState(a as Partial<UiState>);
      case "actions.launch":
        return this.runAction("launch", id, a.provider as string | undefined);
      case "actions.install":
        return this.runAction("install", id);
      case "actions.uninstall":
        return this.runAction("uninstall", id);
      case "actions.openStore":
        return this.runAction("openStore", id);
      case "actions.toggleFavorite":
        return this.toggleFavorite(id);
      case "actions.setHidden":
        return this.setHidden(id, a.hidden as boolean);
      case "actions.setTags":
        return this.setTags(id, a.tags as string[]);
      case "actions.changeArt":
        return this.hostUi.changeArt(this.byId.get(id)!, a.kind as ArtKind);
      case "actions.openSettings":
        return this.hostUi.openSettings(a.page as string | undefined);
      case "ui.toast":
        return this.hostUi.toast(a.text as string);
      case "ui.contextMenu":
        return this.hostUi.contextMenu(this.byId.get(id)!, a.x as number, a.y as number);
      case "ui.theme":
        return this.hostUi.theme(a.tokens as Record<string, string>);
      case "window.minimize":
      case "window.toggleMaximize":
      case "window.close":
      case "window.startDrag":
        return this.setWindow(await this.backend.window(method.slice("window.".length) as "minimize"));
      case "shell.command":
        if (a.command === "refresh") return this.backend.refresh();
        if (a.command === "toggleCouch") return this.toggleCouch();
        if (a.command === "devtools") return this.backend.openDevtools();
        return;
      case "shelves.set":
        return this.shelvesSet(a as Partial<ShelfPrefs>);
      case "dev.error":
        return this.hostUi.devError(a.message as string, (a.stack as string) ?? "");
    }
  }

  get isStarted() {
    return this.started;
  }

  get skinOrigin() {
    return this.origin;
  }
}
