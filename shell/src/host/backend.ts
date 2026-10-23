// What the skin host needs from "the rest of Vellum". The app implements it over Tauri
// commands (tauri-backend.ts); the skin dev harness implements it with the mock library, so
// both run the same controller and bridge.

import type { Entry, ProviderInfo } from "../../../sdk/src/types";

export interface UiSettings {
  startView: string;
  last: { view?: string; selectedId?: string | null; sort?: string; groupBy?: string | null; filters?: Record<string, unknown> };
  views: { order?: string[]; hidden?: string[] };
  shelves: { order?: Record<string, string[]>; collapsed?: string[] };
  skinsSeen: string[];
  devMode: boolean;
  /** Music volume for skins' vellum.music, 0-1 (absent before 0.2.3). */
  musicVolume?: number;
  /** Plugin ids whose start-up recommendation was answered "Don't ask again". */
  dismissedRecommendations?: string[];
}

/** The active skin as the backend reports it. */
export interface SkinRecord {
  id: string;
  name: string;
  /** The manifest's `skin` section. */
  section: Record<string, unknown>;
  values: Record<string, unknown>;
  fallbackFrom: string | null;
  /** Changes when the skin's files are replaced (an update, or a fresh download); the skin
   *  page reloads then. Absent from the harness's mock backend. */
  revision?: string;
  dev: boolean;
}

export type ActionKind = "launch" | "install" | "uninstall" | "openStore";

export interface WindowState {
  maximized: boolean;
  fullscreen: boolean;
}

export interface Backend {
  entries(): Promise<Entry[]>;
  providers(): Promise<ProviderInfo[]>;
  skin(): Promise<SkinRecord | null>;
  uiSettings(): Promise<UiSettings>;
  updateUi(patch: Partial<UiSettings>): Promise<UiSettings>;

  runAction(id: string, kind: ActionKind, provider?: string): Promise<{ title: string; providerName: string }>;
  setFavorite(id: string, favorite: boolean): Promise<Entry>;
  setHidden(id: string, hidden: boolean): Promise<Entry>;
  setTags(id: string, tags: string[]): Promise<Entry>;
  openInstallFolder(id: string): Promise<void>;

  window(action: "minimize" | "toggleMaximize" | "close" | "startDrag" | "toggleFullscreen" | "info"): Promise<WindowState>;
  refresh(): Promise<void>;
  openDevtools(): Promise<void>;

  onLibraryChanged(cb: () => void): void;
  onProvidersChanged(cb: () => void): void;
  /** Skin identity or option values changed. */
  onSkinChanged(cb: () => void): void;
  /** Developer mode: a file in the active skin changed (path relative to the skin folder). */
  onSkinFileChanged(cb: (path: string) => void): void;
  onWindowChanged(cb: () => void): void;
  /** The OS window gained or lost focus. Absent in the harness, which watches the page instead. */
  onFocusChanged?(cb: (focused: boolean) => void): void;
}
