// The postMessage protocol between a sandboxed skin (or module) page and the shell.
// Every message carries `v: 1`. The shell validates origin, source and shape of each one.

import type { Entry, ProviderInfo, ShelfPrefs, SkinInfo, UiState, ViewInfo } from "./types";

export const PROTOCOL_VERSION = 1;

export const NAV_EVENTS = [
  "up",
  "down",
  "left",
  "right",
  "confirm",
  "back",
  "menu",
  "details",
  "prevView",
  "nextView",
  "pageUp",
  "pageDown",
  "favorite",
  "search",
  "settings",
] as const;
export type NavName = (typeof NAV_EVENTS)[number];

export interface WindowInfo {
  maximized: boolean;
  frameless: boolean;
}

export interface InitData {
  library: Entry[];
  state: UiState;
  providers: ProviderInfo[];
  views: ViewInfo[];
  skin: SkinInfo;
  shelves: ShelfPrefs;
  window: WindowInfo;
}

/** Skin → shell */
export type SkinMessage =
  | { v: 1; type: "hello" }
  | { v: 1; type: "call"; id: number; method: CallMethod; args: unknown };

export type ShellEvent =
  | { name: "library"; data: Entry[] }
  /** Changed entries only (favorite, tags, …); entries not listed are unchanged. */
  | { name: "entries"; data: Entry[] }
  | { name: "state"; data: UiState }
  | { name: "providers"; data: ProviderInfo[] }
  | { name: "views"; data: ViewInfo[] }
  | { name: "skin"; data: SkinInfo }
  | { name: "shelves"; data: ShelfPrefs }
  | { name: "window"; data: WindowInfo }
  /** Input the shell forwards (controller, harness panel). */
  | { name: "nav"; data: { name: NavName } }
  /** Developer mode: a stylesheet in the skin changed. */
  | { name: "devCss"; data: { path: string } };

/** Shell → skin */
export type ShellMessage =
  | ({ v: 1; type: "init" } & InitData)
  | ({ v: 1; type: "event" } & ShellEvent)
  | { v: 1; type: "result"; id: number; ok: true; value: unknown }
  | { v: 1; type: "result"; id: number; ok: false; error: string };

/** Calls a skin may make. Reads are served from the SDK's cache and never cross the bridge. */
export const CALL_METHODS = [
  "state.set",
  "actions.launch",
  "actions.install",
  "actions.uninstall",
  "actions.openStore",
  "actions.toggleFavorite",
  "actions.setHidden",
  "actions.setTags",
  "actions.changeArt",
  "actions.openSettings",
  "ui.toast",
  "ui.contextMenu",
  "ui.theme",
  "window.minimize",
  "window.toggleMaximize",
  "window.close",
  "window.startDrag",
  "shell.command",
  "shelves.set",
  "dev.error",
] as const;

export type CallMethod = (typeof CALL_METHODS)[number];

/** Commands a skin can forward to the shell (from hotkeys pressed inside the skin). */
export const SHELL_COMMANDS = ["refresh", "toggleCouch", "devtools"] as const;
export type ShellCommand = (typeof SHELL_COMMANDS)[number];

/** Tokens the SDK reports so the shell can draw settings in the skin's colors. */
export const THEME_TOKENS = [
  "--v-bg",
  "--v-surface",
  "--v-surface-raised",
  "--v-text",
  "--v-text-muted",
  "--v-accent",
  "--v-accent-text",
  "--v-focus-ring",
  "--v-radius",
  "--v-font-body",
] as const;
