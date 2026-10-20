// Shell-owned state: the library, UI state and provider statuses. Skins get copies through
// the bridge; only the shell writes.
import { api, type Notice, type ProviderStatus } from "./api";
import { DEFAULT_STATE, type Entry, type ProviderInfo, type UiState } from "../../sdk/src/types";

type Listener = () => void;

class Store {
  entries: Entry[] = [];
  state: UiState = { ...DEFAULT_STATE };
  statuses: ProviderStatus[] = [];
  notices: Notice[] = [];
  private listeners = { library: new Set<Listener>(), state: new Set<Listener>(), providers: new Set<Listener>() };

  on(kind: keyof Store["listeners"], cb: Listener): () => void {
    this.listeners[kind].add(cb);
    return () => this.listeners[kind].delete(cb);
  }

  private emit(kind: keyof Store["listeners"]) {
    this.listeners[kind].forEach((cb) => cb());
  }

  async start() {
    await Promise.all([this.loadLibrary(), this.loadProviders()]);
    api.onLibraryChanged(() => this.loadLibrary());
    api.onProvidersChanged(() => this.loadProviders());
  }

  async loadLibrary() {
    this.entries = await api.libraryEntries();
    if (this.state.selectedId && !this.entries.some((e) => e.id === this.state.selectedId)) {
      this.setState({ selectedId: null });
    }
    this.emit("library");
  }

  async loadProviders() {
    [this.statuses, this.notices] = await Promise.all([api.providerStatuses(), api.notices()]);
    this.emit("providers");
  }

  setState(partial: Partial<UiState>) {
    this.state = { ...this.state, ...partial };
    this.emit("state");
  }

  providerInfo(names: Map<string, string>): ProviderInfo[] {
    return this.statuses.map((s) => ({
      id: s.id,
      name: names.get(s.id) ?? s.id,
      state: s.state,
      message: s.message,
      games: s.games,
    }));
  }

  entry(id: string): Entry | undefined {
    return this.entries.find((e) => e.id === id);
  }
}

export const store = new Store();
