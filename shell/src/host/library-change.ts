import type { Entry } from "../../../sdk/src/types";

export type LibraryChange =
  | { kind: "none" }
  /** The same games in the same order; only these differ. */
  | { kind: "entries"; changed: Entry[] }
  /** Games were added, removed or reordered. */
  | { kind: "library" };

/** What a reload changed, so a skin hears about nothing more than that. */
export function libraryChange(before: Entry[], after: Entry[]): LibraryChange {
  if (before.length !== after.length || before.some((e, i) => e.id !== after[i].id)) return { kind: "library" };
  const changed = after.filter((e, i) => JSON.stringify(e) !== JSON.stringify(before[i]));
  return changed.length ? { kind: "entries", changed } : { kind: "none" };
}
