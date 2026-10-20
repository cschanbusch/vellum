// Typed wrappers over the backend commands in src-tauri/src/commands.rs.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

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
};
