// The skin host's backend inside the app: Tauri commands and events.
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ProviderInfo } from "../../../sdk/src/types";
import { api, type PluginView } from "../api";
import type { Backend } from "./backend";

/** Builds the providers list skins see (name, icon URL, status). */
async function providerInfos(skinOrigin: string): Promise<ProviderInfo[]> {
  const [statuses, plugins] = await Promise.all([api.providerStatuses(), api.listPlugins()]);
  const byId = new Map<string, PluginView>(plugins.map((p) => [p.id, p]));
  return statuses.map((s) => {
    const p = byId.get(s.id);
    return {
      id: s.id,
      name: p?.name ?? s.id,
      icon: p?.icon ? `${skinOrigin}/__vellum/provider-icon/${s.id}` : null,
      state: s.state,
      message: s.message,
      games: s.games,
    };
  });
}

export function tauriBackend(skinOrigin: string): Backend {
  return {
    entries: () => api.libraryEntries(),
    providers: () => providerInfos(skinOrigin),
    skin: () => api.skinInfo(),
    uiSettings: () => api.uiSettings(),
    updateUi: (patch) => api.updateUiSettings(patch),
    runAction: (id, kind, provider) => api.runAction(id, kind, provider),
    setFavorite: (id, v) => api.setFavorite(id, v),
    setHidden: (id, v) => api.setHidden(id, v),
    setTags: (id, tags) => api.setTags(id, tags),
    openInstallFolder: (id) => api.openInstallFolder(id),
    window: (action) => api.windowAction(action),
    refresh: () => api.refreshLibrary(),
    openDevtools: () => api.openDevtools(),
    onLibraryChanged: (cb) => void api.onLibraryChanged(cb),
    onProvidersChanged: (cb) => void api.onProvidersChanged(cb),
    onSkinChanged: (cb) => void api.onSkinChanged(cb),
    onSkinFileChanged: (cb) => void api.onSkinFileChanged(cb),
    onWindowChanged: (cb) => void getCurrentWindow().onResized(() => cb()),
    onFocusChanged: (cb) => void getCurrentWindow().onFocusChanged(({ payload }) => cb(payload)),
  };
}
