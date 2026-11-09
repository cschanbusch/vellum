// The per-game context menu's items, shared by the app and the skin dev harness.

import type { Entry, MenuItem } from "../../../sdk/src/types";
import type { MenuAction } from "../overlays";
import type { SkinHostController } from "./controller";

export interface MenuHooks {
  editTags(entry: Entry): void;
  changeArt(entry: Entry): void;
  /** Edit a hand-added game. Absent where there is no such dialog (the dev harness). */
  editCustomGame?(sourceId: string): void;
  /** Stores…: how this entry plays and which copies it holds. Absent in the dev harness too. */
  stores?(entry: Entry): void;
  /** Launch options… for one copy, when its provider declares per-game settings. */
  launchOptions?(entry: Entry, provider: string): void;
}

/**
 * Puts a skin's own items (from `vellum.ui.contextMenu`) above the game menu and opens it with
 * `open`. Resolves with the chosen skin item's id, or null when the menu closed any other way.
 */
export function withSkinItems(
  items: MenuAction[],
  skinItems: MenuItem[] | undefined,
  open: (items: MenuAction[], onClose: () => void) => void,
  onClose: () => void,
): Promise<string | null> {
  return new Promise((resolve) => {
    let picked: string | null = null;
    const own: MenuAction[] = (skinItems ?? []).map((i) => ({ label: i.label, disabled: i.disabled, run: () => (picked = i.id) }));
    if (own.length && items.length) items[0].separated = true;
    // The menu closes before it runs the chosen item, so settle once that has had its turn.
    open([...own, ...items], () => {
      onClose();
      queueMicrotask(() => resolve(picked));
    });
  });
}

export function entryMenu(host: SkinHostController, e: Entry, hooks: MenuHooks): MenuAction[] {
  const pref = e.sources.find((s) => s.provider === e.preferredSource) ?? e.sources[0];
  const can = (cap: string) => !!pref?.capabilities.includes(cap);
  const quiet = (p: Promise<unknown>) => void p.catch(() => {});
  const items: MenuAction[] = [
    { label: "Play", hint: e.askSource ? "choose a store" : pref ? `via ${pref.providerName}` : undefined, disabled: !can("launch"), run: () => quiet(host.play(e)) },
  ];
  for (const s of e.sources) {
    if ((s !== pref || e.askSource) && s.capabilities.includes("launch")) {
      items.push({ label: `Play via ${s.providerName}`, run: () => quiet(host.runAction("launch", e.id, s.provider)) });
    }
  }
  items.push(
    { label: "Show details", hint: "Ctrl+I", run: () => host.setState({ view: "spotlight", selectedId: e.id }) },
    { label: e.favorite ? "Remove from favorites" : "Add to favorites", hint: "Ctrl+D", separated: true, run: () => quiet(host.toggleFavorite(e.id)) },
    { label: "Edit tags…", run: () => hooks.editTags(e) },
    { label: e.hidden ? "Unhide" : "Hide", run: () => quiet(host.setHidden(e.id, !e.hidden)) },
    { label: "Change art…", run: () => hooks.changeArt(e) },
  );
  if (hooks.stores) items.push({ label: "Stores…", run: () => hooks.stores!(e) });
  const tunable = e.sources.filter((s) => s.capabilities.includes("launchOptions"));
  if (hooks.launchOptions) {
    for (const s of tunable) {
      const label = tunable.length > 1 ? `Launch options (${s.providerName})…` : "Launch options…";
      items.push({ label, run: () => hooks.launchOptions!(e, s.provider) });
    }
  }
  const store: MenuAction[] = [];
  if (can("install")) store.push({ label: "Install", run: () => quiet(host.runAction("install", e.id)) });
  if (can("uninstall")) store.push({ label: "Uninstall…", run: () => quiet(host.runAction("uninstall", e.id)) });
  if (can("openStore")) store.push({ label: "Open store page", run: () => quiet(host.runAction("openStore", e.id)) });
  if (pref?.installDir) store.push({ label: "Open install folder", run: () => quiet(host.backend.openInstallFolder(e.id)) });
  const custom = e.sources.find((s) => s.provider === "custom");
  if (custom && hooks.editCustomGame) {
    const sourceId = custom.gameId.slice("custom:".length);
    store.push({ label: "Edit custom game…", run: () => hooks.editCustomGame!(sourceId) });
  }
  if (store.length) store[0].separated = true;
  return [...items, ...store];
}
