// Typed wrappers over the backend commands in src-tauri/src/commands.rs.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { Entry } from "../../sdk/src/types";
import type { SkinRecord, UiSettings, WindowState } from "./host/backend";

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
  icon: string | null;
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
  onSkinChanged: (cb: () => void): Promise<UnlistenFn> => listen("vellum://skin-changed", cb),
  onSkinFileChanged: (cb: (path: string) => void): Promise<UnlistenFn> =>
    listen<{ path: string }>("vellum://skin-file-changed", (e) => cb(e.payload.path)),

  setFavorite: (entryId: string, favorite: boolean) => invoke<Entry>("set_favorite", { entryId, favorite }),
  setHidden: (entryId: string, hidden: boolean) => invoke<Entry>("set_hidden", { entryId, hidden }),
  setTags: (entryId: string, tags: string[]) => invoke<Entry>("set_tags", { entryId, tags }),
  openInstallFolder: (entryId: string) => invoke<void>("open_install_folder", { entryId }),

  skinInfo: () => invoke<SkinRecord | null>("skin_info"),
  setSkinOption: (skin: string, key: string, value: unknown) => invoke<void>("set_skin_option", { skin, key, value }),
  resetSkinOptions: (skin: string) => invoke<void>("reset_skin_options", { skin }),
  useFallbackSkin: (reason: string) => invoke<void>("use_fallback_skin", { reason }),
  uiSettings: () => invoke<UiSettings>("ui_settings"),
  updateUiSettings: (patch: Partial<UiSettings>) => invoke<UiSettings>("update_ui_settings", { patch }),
  windowAction: (action: string) => invoke<WindowState>("window_action", { action }),
  openDevtools: () => invoke<void>("open_devtools"),
  openLogsFolder: () => invoke<void>("open_logs_folder"),
  runDiagnostics: () => invoke<string>("run_diagnostics"),
  skinPreview: (id: string) => invoke<string | null>("skin_preview", { id }),
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
