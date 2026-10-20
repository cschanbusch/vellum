// Typed wrappers over the backend commands in src-tauri/src/commands.rs.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { Entry } from "../../sdk/src/types";

export type PluginKind = "provider" | "skin" | "module";

export interface AppInfo {
  name: string;
  version: string;
  apiVersion: number;
  dataDir: string;
  portable: boolean;
  pluginsDir: string;
  devPluginsDir: string | null;
}

export interface PluginView {
  id: string;
  kind: PluginKind;
  name: string;
  version: string | null;
  author: string | null;
  description: string | null;
  folder: string;
  enabled: boolean;
  status: "ok" | "warning" | "error";
  errors: string[];
  warnings: string[];
  section: Record<string, unknown> | null;
}

export interface LocationCandidate {
  source: "saved" | "registry" | "default" | "user";
  path: string;
  ok: boolean;
  reason: string | null;
}

export interface LocationResolution {
  key: string;
  label: string;
  required: boolean;
  path: string | null;
  candidates: LocationCandidate[];
}

export interface ProviderStatus {
  id: string;
  state: "idle" | "scanning" | "ready" | "inactive" | "error";
  message: string | null;
  games: number;
  scannedAt: string | null;
  durationMs: number | null;
  locations: LocationResolution[];
}

export interface Notice {
  id: string;
  provider: string;
  providerName: string;
  key: string;
  label: string;
  message: string;
}

export type ActionKind = "launch" | "install" | "uninstall" | "openStore";

export interface ActionResult {
  title: string;
  providerName: string;
}

export const api = {
  appInfo: () => invoke<AppInfo>("app_info"),
  listPlugins: () => invoke<PluginView[]>("list_plugins"),
  setPluginEnabled: (kind: PluginKind, id: string, enabled: boolean) =>
    invoke<void>("set_plugin_enabled", { kind, id, enabled }),
  activateSkin: (id: string) => invoke<void>("activate_skin", { id }),
  reloadPlugins: () => invoke<void>("reload_plugins"),
  openPluginsFolder: () => invoke<void>("open_plugins_folder"),
  openDataFolder: () => invoke<void>("open_data_folder"),
  onPluginsChanged: (cb: () => void): Promise<UnlistenFn> => listen("vellum://plugins-changed", cb),

  libraryEntries: () => invoke<Entry[]>("library_entries"),
  providerStatuses: () => invoke<ProviderStatus[]>("provider_statuses"),
  notices: () => invoke<Notice[]>("notices"),
  dismissNotice: (id: string) => invoke<void>("dismiss_notice", { id }),
  setLocation: (provider: string, key: string, path: string) => invoke<void>("set_location", { provider, key, path }),
  refreshLibrary: () => invoke<void>("refresh_library"),
  runAction: (entryId: string, action: ActionKind, provider?: string) =>
    invoke<ActionResult>("run_action", { entryId, action, provider }),
  onLibraryChanged: (cb: () => void): Promise<UnlistenFn> => listen("vellum://library-changed", cb),
  onProvidersChanged: (cb: () => void): Promise<UnlistenFn> => listen("vellum://providers-changed", cb),

  /** Folder picker; resolves to null when cancelled. */
  pickFolder: async (title: string): Promise<string | null> => {
    const picked = await open({ directory: true, multiple: false, title });
    return typeof picked === "string" ? picked : null;
  },
};

/** Browse for a provider location until the user picks a valid folder or cancels.
 *  Returns null on success, or the validation message for the last folder tried. */
export async function browseForLocation(provider: string, key: string, label: string): Promise<string | null> {
  const path = await api.pickFolder(`Choose the ${label}`);
  if (!path) return null;
  try {
    await api.setLocation(provider, key, path);
    return null;
  } catch (e) {
    return String(e);
  }
}
