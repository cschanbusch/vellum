// Provider statuses and location notices, for the notice bar and the Plugins page.
// The library and UI state live in the skin host controller (host/controller.ts).
import { api, type Notice, type ProviderStatus } from "./api";

type Listener = () => void;

class Store {
  statuses: ProviderStatus[] = [];
  notices: Notice[] = [];
  private listeners = new Set<Listener>();

  on(_kind: "providers", cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async start() {
    await this.loadProviders();
    api.onProvidersChanged(() => this.loadProviders());
  }

  async loadProviders() {
    [this.statuses, this.notices] = await Promise.all([api.providerStatuses(), api.notices()]);
    this.listeners.forEach((cb) => cb());
  }
}

export const store = new Store();
