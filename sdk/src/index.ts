// The skin SDK, served to every skin at /__vellum/sdk.js and exposed as `window.vellum`.
// Reads are synchronous from a local cache; writes go to the shell, which owns all state,
// and come back as change events. Phase 2 surface: ready, library, state, actions,
// providers, ui.toast. Kit components, views, input and art arrive in Phase 3.

import { CALL_METHODS, PROTOCOL_VERSION, type CallMethod, type ShellMessage } from "./protocol";
import { DEFAULT_STATE, type Entry, type ProviderInfo, type UiState } from "./types";

export type { Entry, ProviderInfo, UiState } from "./types";

type Listener<T> = (value: T) => void;

class Emitter<T> {
  private listeners = new Set<Listener<T>>();
  on(cb: Listener<T>): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  emit(value: T) {
    for (const cb of this.listeners) {
      try {
        cb(value);
      } catch (e) {
        console.error("[vellum] listener failed", e);
      }
    }
  }
}

let library: Entry[] = [];
let byId = new Map<string, Entry>();
let state: UiState = { ...DEFAULT_STATE };
let providers: ProviderInfo[] = [];

const libraryChanged = new Emitter<Entry[]>();
const stateChanged = new Emitter<UiState>();
const providersChanged = new Emitter<ProviderInfo[]>();

let resolveReady!: () => void;
const readyPromise = new Promise<void>((r) => (resolveReady = r));

let nextCallId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function setLibrary(entries: Entry[]) {
  library = entries;
  byId = new Map(entries.map((e) => [e.id, e]));
}

window.addEventListener("message", (event: MessageEvent) => {
  // Only the hosting shell may talk to the SDK.
  if (event.source !== window.parent) return;
  const msg = event.data as ShellMessage;
  if (!msg || msg.v !== PROTOCOL_VERSION) return;
  switch (msg.type) {
    case "init":
      setLibrary(msg.library);
      state = msg.state;
      providers = msg.providers;
      resolveReady();
      libraryChanged.emit(library);
      stateChanged.emit(state);
      break;
    case "event":
      if (msg.name === "library") {
        setLibrary(msg.data);
        libraryChanged.emit(library);
      } else if (msg.name === "state") {
        state = msg.data;
        stateChanged.emit(state);
      } else if (msg.name === "providers") {
        providers = msg.data;
        providersChanged.emit(providers);
      }
      break;
    case "result": {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.value);
      else p.reject(new Error(msg.error));
      break;
    }
  }
});

function post(body: object) {
  // The shell's origin differs per platform; the shell validates our origin, not vice versa.
  window.parent.postMessage({ v: PROTOCOL_VERSION, ...body }, "*");
}

function call<T = unknown>(method: CallMethod, args: unknown): Promise<T> {
  if (!(CALL_METHODS as readonly string[]).includes(method)) return Promise.reject(new Error(`unknown method ${method}`));
  const id = nextCallId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    post({ type: "call", id, method, args });
  });
}

/** Games that are not hidden, sorted by title. Search, filters and sorts arrive in Phase 3. */
function visible(): Entry[] {
  return library.filter((e) => e.kind === "game" && !e.hidden);
}

export const vellum = {
  /** Resolves once library, state and providers have arrived from the shell. */
  ready: () => readyPromise,

  library: {
    all: (): Entry[] => library,
    query: (): Entry[] => visible(),
    get: (id: string): Entry | undefined => byId.get(id),
    on: (event: "change", cb: Listener<Entry[]>) => (event === "change" ? libraryChanged.on(cb) : () => {}),
  },

  state: {
    get: (): UiState => state,
    set: (partial: Partial<Pick<UiState, "view" | "selectedId">>) => call<void>("state.set", partial),
    on: (event: "change", cb: Listener<UiState>) => (event === "change" ? stateChanged.on(cb) : () => {}),
  },

  actions: {
    launch: (id: string, provider?: string) => call<void>("actions.launch", { id, provider }),
    install: (id: string) => call<void>("actions.install", { id }),
    uninstall: (id: string) => call<void>("actions.uninstall", { id }),
    openStore: (id: string) => call<void>("actions.openStore", { id }),
  },

  providers: {
    list: (): ProviderInfo[] => providers,
    on: (event: "change", cb: Listener<ProviderInfo[]>) => (event === "change" ? providersChanged.on(cb) : () => {}),
  },

  ui: {
    toast: (text: string) => call<void>("ui.toast", { text }),
  },
};

declare global {
  interface Window {
    vellum: typeof vellum;
  }
}

window.vellum = vellum;
post({ type: "hello" });

export default vellum;
