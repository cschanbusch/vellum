// What each nav event does when no listener prevents it, and the view/command hotkeys.

import { vellum } from "./core";
import { deepActive, focus } from "./focus";
import { input, type NavEvent } from "./input";

/** The open popover around the focused element, if any. */
function openPopover(): HTMLElement | null {
  for (let e: Element | null = deepActive(); e; ) {
    if (e instanceof HTMLElement && e.matches(":popover-open")) return e;
    const root = e.getRootNode();
    e = e.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
  }
  return null;
}

/** Where a menu for the selected entry should appear: beside the focused element. */
function menuPoint(): { x: number; y: number } {
  const el = deepActive();
  const r = el?.getBoundingClientRect();
  return r ? { x: r.left + Math.min(24, r.width / 2), y: r.top + Math.min(24, r.height / 2) } : { x: innerWidth / 2, y: innerHeight / 2 };
}

function selectedId(): string | null {
  return vellum.state.get().selectedId;
}

export function defaultNav(e: NavEvent) {
  switch (e.name) {
    case "up":
    case "down":
    case "left":
    case "right":
      focus.move(e.name);
      return;
    case "pageUp":
    case "pageDown":
      focus.page(e.name);
      return;
    case "confirm": {
      const active = deepActive();
      // Enter in the search box moves on to the results.
      if (active?.hasAttribute("data-vellum-search")) focus.move("down") || focus.focusDefault();
      else if (!focus.activate()) focus.focusDefault();
      return;
    }
    case "back": {
      const pop = openPopover();
      if (pop) {
        pop.hidePopover();
        focus.focusDefault();
        return;
      }
      const active = deepActive();
      if (active?.hasAttribute("data-vellum-search")) {
        if ((active as HTMLInputElement).value) {
          (active as HTMLInputElement).value = "";
          void vellum.state.set({ query: "" });
        } else focus.focusDefault();
        return;
      }
      if (vellum.state.get().view === "spotlight" && vellum.views.previous()) void vellum.views.back();
      return;
    }
    case "menu": {
      const id = selectedId();
      if (id) {
        const p = menuPoint();
        void vellum.ui.contextMenu(id, p.x, p.y);
      }
      return;
    }
    case "details": {
      const id = selectedId();
      if (id) void vellum.actions.showDetails(id);
      return;
    }
    case "favorite": {
      const id = selectedId();
      if (id) void vellum.actions.toggleFavorite(id);
      return;
    }
    case "prevView":
    case "nextView":
      vellum._internal.cycleView(e.name === "nextView" ? 1 : -1);
      return;
    case "search":
      document.dispatchEvent(new CustomEvent("vellum-search-focus", { detail: {} }));
      return;
    case "settings":
      void vellum.actions.openSettings();
      return;
  }
}

export function installDefaults() {
  input.setDefault(defaultNav);
  input.setHotkeyHandler((h) => {
    if (h.kind === "view") {
      const v = vellum.views.list().find((x) => x.hotkey === h.key);
      if (v) void vellum.views.switch(v.id);
    } else {
      void vellum._internal.shellCommand(h.command);
    }
  });
}
