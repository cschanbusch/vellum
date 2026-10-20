// Data shapes shared by the SDK, the shell and skins. Mirrors src-tauri/src/library/entry.rs.

export type ArtKind = "cover" | "hero" | "logo" | "header" | "icon";
export const ART_KINDS: readonly ArtKind[] = ["cover", "hero", "logo", "header", "icon"];
export type ArtStatus = "local" | "remote" | "placeholder";
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
  /** The store's labels, such as "Demo", "Playtest" or "Soundtrack"; shown as badges. */
  labels: string[];
  tags: string[];
  favorite: boolean;
  hidden: boolean;
  /** ISO time of the last launch dispatched by Vellum; not a measure of play. */
  lastLaunched: string | null;
  addedAt: string;
  sizeBytes?: number;
  metadata: { developer?: string; publisher?: string; releaseDate?: string; genres?: string[]; description?: string };
  /** Art URLs on the skin's own origin, at full size. Use `vellum.art.url` for sized variants. */
  art: Record<ArtKind, string>;
  artStatus: Record<ArtKind, ArtStatus>;
  notes?: string;
}

/** Library filters. Every field is optional; an absent field doesn't filter. */
export interface Filters {
  /** Only entries with a source from one of these providers. */
  providers?: string[];
  /** Entry kinds to show. Absent = games only. */
  kinds?: EntryKind[];
  favorites?: boolean;
  /** Entries carrying every one of these user tags. */
  tags?: string[];
  /** Store categories as `"<provider>/<name>"`; an entry matches if it has any of them. */
  categories?: string[];
  /** Include hidden entries. */
  showHidden?: boolean;
}

export const SORT_KEYS = ["title", "lastLaunched", "added", "size", "releaseDate", "provider"] as const;
export type SortKey = (typeof SORT_KEYS)[number];
/** A sort key, optionally prefixed with "-" to reverse its natural direction. */
export type Sort = SortKey | `-${SortKey}`;

export const GROUP_KEYS = ["category", "tag", "provider", "favorites", "recent", "letter"] as const;
export type GroupKey = (typeof GROUP_KEYS)[number];

export interface UiState {
  view: string;
  selectedId: string | null;
  query: string;
  filters: Filters;
  sort: Sort;
  groupBy: GroupKey | null;
  couch: boolean;
}

export interface ProviderInfo {
  id: string;
  name: string;
  /** URL of the provider's icon on the skin origin, or null. */
  icon: string | null;
  state: "idle" | "scanning" | "ready" | "inactive" | "error";
  message: string | null;
  games: number;
}

export type ViewPlacement = "first" | "last" | { before: string } | { after: string };

/** A view as the shell lists it, in the user's order. */
export interface ViewInfo {
  id: string;
  name: string;
  builtin: boolean;
  couch: boolean;
  /** Module path inside the skin, for skin views and overrides of built-ins. */
  entry?: string;
  /** Extra stylesheet inside the skin applied while this view is shown. */
  style?: string;
  icon?: string;
  /** e.g. "Ctrl+2"; absent when no key is bound. */
  hotkey?: string;
}

export type SkinOptionType = "color" | "range" | "select" | "toggle" | "font" | "image";

export interface SkinOption {
  id: string;
  label: string;
  type: SkinOptionType;
  default: unknown;
  cssVar?: string;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  /** For select, font and image: the values offered. */
  choices?: { value: string; label: string }[];
}

export interface SkinInfo {
  id: string;
  name: string;
  options: SkinOption[];
  values: Record<string, unknown>;
  /** Whether developer mode is on (error overlay, live reload). */
  dev: boolean;
}

export interface ShelfPrefs {
  /** Per group key, the user's shelf order (group labels). */
  order: Partial<Record<GroupKey, string[]>>;
  /** Collapsed shelves as `"<groupKey>/<label>"`. */
  collapsed: string[];
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
