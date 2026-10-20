// The postMessage protocol between a sandboxed skin (or module) page and the shell.
// Every message carries `v: 1`. The shell validates origin, source and shape of each one.

import type { Entry, ProviderInfo, UiState } from "./types";

export const PROTOCOL_VERSION = 1;

/** Skin → shell */
export type SkinMessage =
  | { v: 1; type: "hello" }
  | { v: 1; type: "call"; id: number; method: CallMethod; args: unknown };

/** Shell → skin */
export type ShellMessage =
  | { v: 1; type: "init"; library: Entry[]; state: UiState; providers: ProviderInfo[] }
  | { v: 1; type: "event"; name: "library"; data: Entry[] }
  | { v: 1; type: "event"; name: "state"; data: UiState }
  | { v: 1; type: "event"; name: "providers"; data: ProviderInfo[] }
  | { v: 1; type: "result"; id: number; ok: true; value: unknown }
  | { v: 1; type: "result"; id: number; ok: false; error: string };

/** Calls a skin may make. Reads are served from the SDK's cache and never cross the bridge. */
export const CALL_METHODS = [
  "state.set",
  "actions.launch",
  "actions.install",
  "actions.uninstall",
  "actions.openStore",
  "ui.toast",
] as const;

export type CallMethod = (typeof CALL_METHODS)[number];
