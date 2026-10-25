// The SDK runtime: the read cache, calls to the shell, change events and the public `vellum`
// object. Kit components and views import `vellum` from here.
//
// Reads are synchronous from the cache. Writes go to the shell, which owns all state, and
// come back as change events. `state.set` is applied locally first so selection feels instant;
// the shell's echo then replaces it.

import { artUrl, styleFor, type ArtStyle } from "./art";
import { focus } from "./focus";
import { allowLaunch, type BeforeLaunch } from "./hooks";
import { input, type NavEvent } from "./input";
import {
  CALL_METHODS,
  PROTOCOL_VERSION,
  THEME_TOKENS,
  type CallMethod,
  type InitData,
  type ShellCommand,
  type ShellMessage,
  type WindowInfo,
  type AudioPrefs,
} from "./protocol";
import { facets, groupEntries, query as runQuery, type Group } from "./query";
import {
  DEFAULT_STATE,
  type ArtKind,
  type Entry,
  type GroupKey,
  type ProviderInfo,
  type ShelfPrefs,
  type SkinInfo,
  type UiState,
  type ViewInfo,
  type MenuItem,
} from "./types";

type Listener<T> = (value: T) => void;

export class Emitter<T> {
  private listeners = new Set<Listener<T>>();
  on(cb: Listener<T>): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }
  emit(value: T) {
    for (const cb of [...this.listeners]) {
      try {
        cb(value);
      } catch (e) {
        console.error("[vellum] listener failed", e);
      }
    }
  }
}

/** What a view module exports (the view contract). */
export interface ViewImpl {
  mount(el: HTMLElement, v: Vellum): void | Promise<void>;
  unmount?(): void;
  onState?(state: UiState): void;
}

// ---- cache ----------------------------------------------------------------------------------

let library: Entry[] = [];
let byId = new Map<string, Entry>();
let libraryVersion = 0;
let state: UiState = { ...DEFAULT_STATE };
let providers: ProviderInfo[] = [];
let views: ViewInfo[] = [];
let skin: SkinInfo = { id: "", name: "", options: [], values: {}, dev: false };
let shelves: ShelfPrefs = { order: {}, collapsed: [] };
let windowInfo: WindowInfo = { maximized: false, frameless: false };
let audio: AudioPrefs = { music: 0.7 };
let previousView: string | null = null;
/** state.set calls the shell hasn't answered yet, in order. */
const unconfirmed = new Map<object, Partial<UiState>>();

const libraryChanged = new Emitter<Entry[]>();
const stateChanged = new Emitter<UiState>();
const providersChanged = new Emitter<ProviderInfo[]>();
const viewsChanged = new Emitter<ViewInfo[]>();
const optionsChanged = new Emitter<Record<string, unknown>>();
const shelvesChanged = new Emitter<ShelfPrefs>();
const windowChanged = new Emitter<WindowInfo>();
const audioChanged = new Emitter<AudioPrefs>();

let resolveReady!: () => void;
const readyPromise = new Promise<void>((r) => (resolveReady = r));

function setLibrary(entries: Entry[]) {
  library = entries;
  byId = new Map(entries.map((e) => [e.id, e]));
  libraryVersion++;
}

function patchEntries(changed: Entry[]) {
  for (const e of changed) {
    const i = library.findIndex((x) => x.id === e.id);
    if (i >= 0) library[i] = e;
  }
  setLibrary([...library]);
}

function setState(next: UiState) {
  if (next.view !== state.view) previousView = state.view;
  const couchChanged = next.couch !== state.couch;
  state = next;
  if (couchChanged) applyCouch();
  stateChanged.emit(state);
}

function applyCouch() {
  if (state.couch) document.documentElement.setAttribute("data-couch", "");
  else document.documentElement.removeAttribute("data-couch");
}

// ---- options --------------------------------------------------------------------------------

const fontFaces = new Map<string, FontFace>();

/** Hooks run before launches (vellum.actions.onBeforeLaunch). */
const beforeLaunch = new Set<BeforeLaunch>();

/** Sets each option's CSS variable on :root; fonts and images get usable values. */
function applyOptions() {
  const root = document.documentElement.style;
  for (const opt of skin.options) {
    if (!opt.cssVar) continue;
    const value = skin.values[opt.id] ?? opt.default;
    let css: string;
    if (opt.type === "toggle") css = value ? "1" : "0";
    else if (opt.type === "image") css = value ? `url("${assetUrl(String(value))}")` : "none";
    else if (opt.type === "font") css = fontFamily(opt.id, String(value ?? ""));
    else css = `${value}${opt.unit ?? ""}`;
    root.setProperty(opt.cssVar, css);
  }
  // Toggles and selects are also exposed as attributes for CSS selectors: data-opt-hero-blur
  // (present when on), data-opt-art-style="sketch" (the chosen value).
  for (const opt of skin.options) {
    if (opt.type !== "toggle" && opt.type !== "select") continue;
    const attr = `data-opt-${opt.id.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
    const value = skin.values[opt.id] ?? opt.default;
    if (opt.type === "select") document.documentElement.setAttribute(attr, String(value ?? ""));
    else if (value) document.documentElement.setAttribute(attr, "");
    else document.documentElement.removeAttribute(attr);
  }
  reportTheme();
}

/** "builtin" (or empty) is the bundled UI font; anything else is a font file in the skin. */
function fontFamily(optionId: string, file: string): string {
  if (!file || file === "builtin") return `"Inter", system-ui, sans-serif`;
  const family = `vellum-${optionId}-${file.replace(/[^a-z0-9]/gi, "-")}`;
  if (!fontFaces.has(family)) {
    const face = new FontFace(family, `url("${assetUrl(file)}")`);
    fontFaces.set(family, face);
    document.fonts.add(face);
    face.load().catch((e) => console.warn(`[vellum] font ${file} failed to load`, e));
  }
  return `"${family}", "Inter", system-ui, sans-serif`;
}

let themeTimer = 0;
/** Tells the shell the skin's resolved colors so settings match the skin. */
function reportTheme() {
  clearTimeout(themeTimer);
  themeTimer = window.setTimeout(() => {
    const cs = getComputedStyle(document.documentElement);
    const tokens: Record<string, string> = {};
    for (const t of THEME_TOKENS) {
      const v = cs.getPropertyValue(t).trim();
      if (v) tokens[t] = v;
    }
    call("ui.theme", { tokens }).catch(() => {});
  }, 50);
}

// ---- messaging ------------------------------------------------------------------------------

let nextCallId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function post(body: object) {
  // The shell's origin differs per platform; the shell validates our origin, not vice versa.
  window.parent.postMessage({ v: PROTOCOL_VERSION, ...body }, "*");
}

export function call<T = unknown>(method: CallMethod, args: unknown = {}): Promise<T> {
  if (!(CALL_METHODS as readonly string[]).includes(method)) return Promise.reject(new Error(`unknown method ${method}`));
  const id = nextCallId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    post({ type: "call", id, method, args });
  });
}

function receiveInit(d: InitData) {
  setLibrary(d.library);
  providers = d.providers;
  views = d.views;
  skin = d.skin;
  shelves = d.shelves;
  windowInfo = d.window;
  if (d.audio) audio = d.audio;
  applyOptions();
  setState(d.state);
  applyCouch();
  resolveReady();
  libraryChanged.emit(library);
  providersChanged.emit(providers);
  viewsChanged.emit(views);
}

window.addEventListener("message", (event: MessageEvent) => {
  // Only the hosting shell may talk to the SDK.
  if (event.source !== window.parent) return;
  const msg = event.data as ShellMessage;
  if (!msg || msg.v !== PROTOCOL_VERSION) return;
  if (msg.type === "init") return receiveInit(msg);
  if (msg.type === "result") {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.value);
    else p.reject(new Error(msg.error));
    return;
  }
  if (msg.type !== "event") return;
  switch (msg.name) {
    case "library":
      setLibrary(msg.data);
      libraryChanged.emit(library);
      break;
    case "entries":
      patchEntries(msg.data);
      libraryChanged.emit(library);
      break;
    case "state":
      // Changes the shell hasn't confirmed yet stay on top of what it sends, so an echo of an
      // older change can't briefly undo a newer one (e.g. a click quickly followed by Ctrl+1).
      setState(Object.assign({}, msg.data, ...unconfirmed.values()));
      break;
    case "providers":
      providers = msg.data;
      providersChanged.emit(providers);
      break;
    case "views":
      views = msg.data;
      viewsChanged.emit(views);
      break;
    case "skin":
      skin = msg.data;
      applyOptions();
      optionsChanged.emit(skin.values);
      break;
    case "shelves":
      shelves = msg.data;
      shelvesChanged.emit(shelves);
      break;
    case "window":
      windowInfo = msg.data;
      windowChanged.emit(windowInfo);
      break;
    case "audio":
      audio = msg.data;
      audioChanged.emit(audio);
      break;
    case "nav":
      input.dispatch(msg.data.name, "shell");
      break;
    case "devCss":
      reloadStylesheet(msg.data.path);
      break;
  }
});

/** Developer mode: swap a changed stylesheet in place, without reloading the page. */
function reloadStylesheet(path: string) {
  const want = "/" + path.replace(/^\/+/, "");
  for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
    const url = new URL(link.href);
    if (url.origin !== location.origin || url.pathname !== want) continue;
    url.searchParams.set("t", String(Date.now()));
    link.href = url.href;
  }
  reportTheme();
}

// ---- derived reads --------------------------------------------------------------------------

let queryCache: { version: number; key: string; result: Entry[] } | null = null;

function currentQuery(): Entry[] {
  const key = JSON.stringify([state.query, state.filters, state.sort]);
  if (queryCache && queryCache.version === libraryVersion && queryCache.key === key) return queryCache.result;
  const result = runQuery(library, state);
  queryCache = { version: libraryVersion, key, result };
  return result;
}

const assetUrl = (path: string) => new URL(path.replace(/^\/+/, ""), `${location.origin}/`).pathname;

const registered = new Map<string, ViewImpl>();

function availableViews(): ViewInfo[] {
  return views;
}

function switchView(id: string) {
  if (!views.some((v) => v.id === id)) return Promise.reject(new Error(`no view ${id}`));
  return vellum.state.set({ view: id });
}

function cycleView(delta: number) {
  const list = availableViews();
  if (!list.length) return;
  const i = list.findIndex((v) => v.id === state.view);
  const next = list[(i + delta + list.length) % list.length];
  void switchView(next.id);
}

// ---- public API -----------------------------------------------------------------------------

export const vellum = {
  /** Resolves once library, state, views and skin options have arrived from the shell. */
  ready: () => readyPromise,

  library: {
    /** Every entry, including hidden ones and non-games. */
    all: (): Entry[] => library,
    /** Entries after the current search, filters and sort. */
    query: (): Entry[] => currentQuery(),
    get: (id: string): Entry | undefined => byId.get(id),
    /** The current query split into shelves by `groupBy` (or the state's groupBy). */
    groups: (by?: GroupKey): Group[] => {
      const key = by ?? state.groupBy;
      return key ? groupEntries(currentQuery(), key, shelves) : [{ key: "all", label: "All games", entries: currentQuery(), orderable: false }];
    },
    /** Every user tag and store category, for filter menus. */
    facets: () => facets(library),
    on: (event: "change", cb: Listener<Entry[]>) => (event === "change" ? libraryChanged.on(cb) : () => {}),
  },

  state: {
    get: (): UiState => state,
    set: (partial: Partial<Omit<UiState, "couch">>): Promise<void> => {
      setState({ ...state, ...partial });
      const token = {};
      unconfirmed.set(token, partial);
      return call<void>("state.set", partial).finally(() => unconfirmed.delete(token));
    },
    on: (event: "change", cb: Listener<UiState>) => (event === "change" ? stateChanged.on(cb) : () => {}),
  },

  actions: {
    /** Launches through the preferred store, or `provider`. Hooks from `onBeforeLaunch` run
     *  first; if one calls it off, this resolves without launching. */
    launch: async (id: string, provider?: string): Promise<void> => {
      if (!(await allowLaunch(beforeLaunch, id, provider))) return;
      return call<void>("actions.launch", { id, provider });
    },
    /** Runs `hook` before every launch this skin starts; return false to call it off. */
    onBeforeLaunch: (hook: BeforeLaunch): (() => void) => {
      beforeLaunch.add(hook);
      return () => void beforeLaunch.delete(hook);
    },
    install: (id: string) => call<void>("actions.install", { id }),
    uninstall: (id: string) => call<void>("actions.uninstall", { id }),
    openStore: (id: string) => call<void>("actions.openStore", { id }),
    toggleFavorite: (id: string) => call<void>("actions.toggleFavorite", { id }),
    setHidden: (id: string, hidden: boolean) => call<void>("actions.setHidden", { id, hidden }),
    setTags: (id: string, tags: string[]) => call<void>("actions.setTags", { id, tags }),
    changeArt: (id: string, kind: ArtKind) => call<void>("actions.changeArt", { id, kind }),
    /** Spotlight on this entry; Back returns to the previous view. */
    showDetails: (id: string) => {
      if (!byId.has(id)) return Promise.reject(new Error(`no entry ${id}`));
      return vellum.state.set({ selectedId: id, ...(state.view !== "spotlight" ? { view: "spotlight" } : {}) });
    },
    openSettings: (page?: string) => call<void>("actions.openSettings", page ? { page } : {}),
    /** A random entry from the current query, or null when it is empty. */
    randomEntry: (): Entry | null => {
      const list = currentQuery();
      return list.length ? list[Math.floor(Math.random() * list.length)] : null;
    },
  },

  art: {
    /**
     * `width`: CSS pixels, an element to size from, or "full". Omitted: the kind's usual size.
     * `style`: "sketch" or "watercolor" to redraw the art; omitted, the skin's tokens
     * (`--v-art-style`, `--v-icon-style`) decide; null for the art as it is.
     */
    url: (id: string, kind: ArtKind, width?: number | Element | "full", style?: ArtStyle | null): string => {
      const e = byId.get(id);
      return e ? artUrl(e, kind, width, style) : "";
    },
    /** The art style the skin's tokens ask for, for a kind (read on `el`). */
    styleFor,
  },

  views: {
    /** Views offered right now, in the user's order (couch-capable only in couch mode). */
    list: (): ViewInfo[] => availableViews(),
    current: (): ViewInfo | undefined => views.find((v) => v.id === state.view),
    switch: switchView,
    /** Returns to the view shown before the current one. */
    back: () => (previousView && previousView !== state.view ? switchView(previousView) : Promise.resolve()),
    previous: () => previousView,
    /** Supplies a view's implementation from skin code (wins over the manifest's `entry`). */
    register: (id: string, impl: ViewImpl) => {
      registered.set(id, impl);
      viewsChanged.emit(views);
    },
    registered: (id: string) => registered.get(id),
    on: (event: "change", cb: Listener<ViewInfo[]>) => (event === "change" ? viewsChanged.on(cb) : () => {}),
  },

  input: {
    on: (event: "nav", cb: (e: NavEvent) => void) => (event === "nav" ? input.on(cb) : () => {}),
    /** Sends a nav event as if the user had pressed the key or button. */
    dispatch: (name: NavEvent["name"]) => input.dispatch(name, "api"),
    focus,
  },

  skin: {
    get id() {
      return skin.id;
    },
    get options(): Record<string, unknown> {
      return skin.values;
    },
    definitions: () => skin.options,
    dev: () => skin.dev,
    on: (event: "options", cb: Listener<Record<string, unknown>>) => (event === "options" ? optionsChanged.on(cb) : () => {}),
    /** Absolute URL path for a file in the skin folder. */
    assetUrl,
    /**
     * localStorage namespaced by skin id. Every skin is served from the same origin, so use
     * this rather than localStorage directly. Values are JSON. For conveniences only (it lives
     * in this WebView profile); anything that matters belongs in Vellum's state or options.
     */
    storage: {
      get<T = unknown>(key: string, fallback?: T): T | undefined {
        try {
          const raw = localStorage.getItem(`vellum:${skin.id}:${key}`);
          return raw === null ? fallback : (JSON.parse(raw) as T);
        } catch {
          return fallback;
        }
      },
      set(key: string, value: unknown) {
        try {
          localStorage.setItem(`vellum:${skin.id}:${key}`, JSON.stringify(value));
        } catch {
          // Storage full or unavailable: conveniences only.
        }
      },
      remove(key: string) {
        try {
          localStorage.removeItem(`vellum:${skin.id}:${key}`);
        } catch {
          // ignore
        }
      },
    },
  },

  shelves: {
    prefs: (): ShelfPrefs => shelves,
    setOrder: (by: GroupKey, labels: string[]) => call<void>("shelves.set", { order: { ...shelves.order, [by]: labels } }),
    setCollapsed: (key: string, collapsed: boolean) =>
      call<void>("shelves.set", {
        collapsed: collapsed ? [...new Set([...shelves.collapsed, key])] : shelves.collapsed.filter((k) => k !== key),
      }),
    on: (event: "change", cb: Listener<ShelfPrefs>) => (event === "change" ? shelvesChanged.on(cb) : () => {}),
  },

  window: {
    minimize: () => call<void>("window.minimize"),
    toggleMaximize: () => call<void>("window.toggleMaximize"),
    close: () => call<void>("window.close"),
    isMaximized: () => windowInfo.maximized,
    isFrameless: () => windowInfo.frameless,
    on: (event: "change", cb: Listener<WindowInfo>) => (event === "change" ? windowChanged.on(cb) : () => {}),
  },

  ui: {
    toast: (text: string) => call<void>("ui.toast", { text }),
    /**
     * Opens the shell's context menu for an entry at viewport coordinates. `items` (up to 6) are the
     * skin's own actions, shown first; resolves with the chosen item's id, or null for anything else.
     */
    contextMenu: (id: string, x: number, y: number, items?: MenuItem[]) =>
      call<string | null | undefined>("ui.contextMenu", { id, x: Math.round(x), y: Math.round(y), ...(items?.length ? { items } : {}) }).then((r) => r ?? null),
    /** `contextMenu` takes skin items (Vellum 0.4 and later); check before relying on them. */
    menuItems: true as const,
  },

  providers: {
    list: (): ProviderInfo[] => providers,
    on: (event: "change", cb: Listener<ProviderInfo[]>) => (event === "change" ? providersChanged.on(cb) : () => {}),
  },

  /** Internal plumbing for the kit; not part of the documented API. */
  _internal: {
    cycleView,
    shellCommand: (command: ShellCommand) => call<void>("shell.command", { command }),
    audio: () => audio,
    onAudio: (cb: Listener<AudioPrefs>) => audioChanged.on(cb),
    windowInfo: () => windowInfo,
  },
};

export type Vellum = typeof vellum;

// ---- developer aids -------------------------------------------------------------------------

function reportError(message: string, stack?: string) {
  call("dev.error", { message: message.slice(0, 2000), stack: (stack ?? "").slice(0, 8000) }).catch(() => {});
}
window.addEventListener("error", (e) => reportError(e.message || String(e.error), e.error?.stack));
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  reportError(r instanceof Error ? r.message : String(r), r instanceof Error ? r.stack : undefined);
});

// Any element with data-vellum-drag moves the window (frameless skins); double-click maximizes.
function onDragRegion(e: MouseEvent): boolean {
  const path = e.composedPath() as Element[];
  for (const el of path) {
    if (!(el instanceof Element)) continue;
    if (el.matches("button, input, select, textarea, a, [data-vellum-focus], [data-vellum-no-drag]")) return false;
    if (el.hasAttribute("data-vellum-drag")) return true;
  }
  return false;
}
window.addEventListener("mousedown", (e) => {
  if (e.button === 0 && e.detail === 1 && onDragRegion(e)) void call("window.startDrag");
});
window.addEventListener("dblclick", (e) => {
  if (onDragRegion(e)) void call("window.toggleMaximize");
});

export function hello() {
  post({ type: "hello" });
}
