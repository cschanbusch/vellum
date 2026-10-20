// Data shapes shared by the SDK, the shell and skins. Mirrors src-tauri/src/library/entry.rs.

export type ArtKind = "cover" | "hero" | "logo" | "header" | "icon";
export type EntryKind = "game" | "tool" | "dlc" | "other";

export interface Source {
  provider: string;
  providerName: string;
  /** `<provider>:<sourceId>` */
  gameId: string;
  capabilities: string[];
  installDir?: string;
}

export interface Entry {
  id: string;
  title: string;
  sortTitle: string;
  kind: EntryKind;
  sources: Source[];
  preferredSource: string;
  categories: { provider: string; name: string }[];
  tags: string[];
  favorite: boolean;
  hidden: boolean;
  /** ISO time of the last launch dispatched by Vellum; not a measure of play. */
  lastLaunched: string | null;
  addedAt: string;
  sizeBytes?: number;
  metadata: { developer?: string; publisher?: string; releaseDate?: string; genres?: string[]; description?: string };
  art: Record<ArtKind, string>;
  artStatus: Record<ArtKind, "local" | "remote" | "placeholder">;
  notes?: string;
}

export interface UiState {
  view: string;
  selectedId: string | null;
  query: string;
  filters: Record<string, unknown>;
  sort: string;
  groupBy: string | null;
  couch: boolean;
}

export interface ProviderInfo {
  id: string;
  name: string;
  state: "idle" | "scanning" | "ready" | "inactive" | "error";
  message: string | null;
  games: number;
}

export const DEFAULT_STATE: UiState = {
  view: "list",
  selectedId: null,
  query: "",
  filters: {},
  sort: "title",
  groupBy: null,
  couch: false,
};
