// Which views exist and in what order: the three built-ins, the active skin's views placed by
// their manifest `placement`, then the user's saved order and visibility on top.
// Shared by the shell (which owns the list) and the skin dev harness.

import type { ViewInfo, ViewPlacement } from "./types";

export const BUILTIN_VIEWS: readonly ViewInfo[] = [
  { id: "list", name: "List", builtin: true, couch: false },
  { id: "covers", name: "Covers", builtin: true, couch: true },
  { id: "spotlight", name: "Spotlight", builtin: true, couch: true },
];

/** The `skin` section of a skin manifest, as far as views are concerned. */
export interface SkinViewSection {
  views?: { id: string; name: string; entry: string; placement?: ViewPlacement; couch?: boolean; icon?: string }[];
  styles?: Record<string, string>;
  overrides?: Record<string, string>;
}

export interface ViewPrefs {
  /** The user's full order, saved once they move a view. */
  order?: string[];
  hidden?: string[];
}

export interface OrderedView extends ViewInfo {
  hidden: boolean;
}

/** Places skin views among the built-ins. Views sharing an anchor keep their manifest order. */
export function placeViews(skin: SkinViewSection): ViewInfo[] {
  const out: ViewInfo[] = BUILTIN_VIEWS.map((v) => ({
    ...v,
    ...(skin.overrides?.[v.id] ? { entry: skin.overrides[v.id] } : {}),
    ...(skin.styles?.[v.id] ? { style: skin.styles[v.id] } : {}),
  }));
  const builtinIds = new Set(out.map((v) => v.id));
  let firsts = 0;
  const lastAfter = new Map<string, string>();
  for (const sv of skin.views ?? []) {
    if (builtinIds.has(sv.id) || out.some((v) => v.id === sv.id)) continue; // ids are unique; built-ins can't be replaced here
    const view: ViewInfo = {
      id: sv.id,
      name: sv.name,
      builtin: false,
      couch: sv.couch === true,
      entry: sv.entry,
      ...(sv.icon ? { icon: sv.icon } : {}),
      ...(skin.styles?.[sv.id] ? { style: skin.styles[sv.id] } : {}),
    };
    const p = sv.placement ?? "last";
    const indexOf = (id: string) => out.findIndex((v) => v.id === id);
    let at = out.length;
    if (p === "first") at = firsts++;
    else if (typeof p === "object" && "before" in p && indexOf(p.before) >= 0) at = indexOf(p.before);
    else if (typeof p === "object" && "after" in p && indexOf(p.after) >= 0) {
      at = indexOf(lastAfter.get(p.after) ?? p.after) + 1;
      lastAfter.set(p.after, sv.id);
    }
    out.splice(at, 0, view);
  }
  return out;
}

/** Applies the user's order and visibility, and assigns hotkeys to visible views. */
export function orderViews(skin: SkinViewSection, prefs: ViewPrefs = {}): OrderedView[] {
  const base = placeViews(skin);
  let ordered = base;
  if (prefs.order?.length) {
    const byId = new Map(base.map((v) => [v.id, v]));
    ordered = prefs.order.filter((id) => byId.has(id)).map((id) => byId.get(id)!);
    // Views the user hasn't placed (e.g. from a newly activated skin) go after their nearest
    // preceding neighbour in the default placement; views placed last stay last.
    base.forEach((v, i) => {
      if (ordered.includes(v)) return;
      if (base.slice(i + 1).every((later) => !ordered.includes(later))) {
        ordered.push(v);
        return;
      }
      let at = 0;
      for (let j = i - 1; j >= 0; j--) {
        const k = ordered.indexOf(base[j]);
        if (k >= 0) {
          at = k + 1;
          break;
        }
      }
      ordered.splice(at, 0, v);
    });
  }
  const hidden = new Set(prefs.hidden ?? []);
  let nextSkinKey = 4;
  return ordered.map((v) => {
    const isHidden = hidden.has(v.id);
    const builtinIndex = BUILTIN_VIEWS.findIndex((b) => b.id === v.id);
    let hotkey: string | undefined;
    if (builtinIndex >= 0) hotkey = `Ctrl+${builtinIndex + 1}`;
    else if (!isHidden && nextSkinKey <= 9) hotkey = `Ctrl+${nextSkinKey++}`;
    return { ...v, hidden: isHidden, ...(hotkey ? { hotkey } : {}) };
  });
}

/** The views offered right now: visible ones, and only couch-capable ones in couch mode. */
export function availableViews(views: readonly OrderedView[], couch: boolean): OrderedView[] {
  return views.filter((v) => !v.hidden && (!couch || v.couch));
}
