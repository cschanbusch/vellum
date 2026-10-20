// The per-game context menu's items, shared by the app and the skin dev harness.

import type { Entry } from "../../../sdk/src/types";
import type { MenuAction } from "../overlays";
import type { SkinHostController } from "./controller";

export interface MenuHooks {
  editTags(entry: Entry): void;
  changeArt(entry: Entry): void;
}

export function entryMenu(host: SkinHostController, e: Entry, hooks: MenuHooks): MenuAction[] {
  const pref = e.sources.find((s) => s.provider === e.preferredSource) ?? e.sources[0];
  const can = (cap: string) => !!pref?.capabilities.includes(cap);
  const quiet = (p: Promise<unknown>) => void p.catch(() => {});
  const items: MenuAction[] = [
    { label: "Play", hint: pref ? `via ${pref.providerName}` : undefined, disabled: !can("launch"), run: () => quiet(host.runAction("launch", e.id)) },
  ];
  for (const s of e.sources) {
    if (s !== pref && s.capabilities.includes("launch")) {
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
  const store: MenuAction[] = [];
  if (can("install")) store.push({ label: "Install", run: () => quiet(host.runAction("install", e.id)) });
  if (can("uninstall")) store.push({ label: "Uninstall…", run: () => quiet(host.runAction("uninstall", e.id)) });
  if (can("openStore")) store.push({ label: "Open store page", run: () => quiet(host.runAction("openStore", e.id)) });
  if (pref?.installDir) store.push({ label: "Open install folder", run: () => quiet(host.backend.openInstallFolder(e.id)) });
  if (store.length) store[0].separated = true;
  return [...items, ...store];
}
