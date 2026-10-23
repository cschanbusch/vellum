// One stream of `nav` events from keyboard, controller (forwarded by the shell) and code.
// Listeners run first; if none calls preventDefault(), the default behaviour runs
// (spatial focus, launch, back, …; see defaults.ts).

import type { NavName } from "./protocol";

export interface NavEvent {
  name: NavName;
  source: "keyboard" | "shell" | "api";
  /** True for keyboard auto-repeat. */
  repeat: boolean;
  defaultPrevented: boolean;
  preventDefault(): void;
}

type NavListener = (e: NavEvent) => void;

/** A hotkey that isn't a nav event: view switching and shell commands. */
export type Hotkey =
  | { kind: "view"; key: string }
  | { kind: "command"; command: "refresh" | "toggleCouch" | "devtools" };

const listeners = new Set<NavListener>();
let defaultHandler: (e: NavEvent) => void = () => {};
let hotkeyHandler: (h: Hotkey) => void = () => {};

function isEditable(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && !["checkbox", "radio", "range", "button", "color"].includes(t.type));
}

/** The real target, looking through shadow roots. */
function deepTarget(e: Event): EventTarget | null {
  return e.composedPath()[0] ?? e.target;
}

/** Keyboard → nav name. Keys that matter inside text fields are left to the field. */
export function navForKey(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">, editable: boolean): NavName | null {
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key === "Tab") return e.shiftKey ? "prevView" : "nextView";
  if (ctrl && !e.shiftKey && e.key.toLowerCase() === "f") return "search";
  if (ctrl && !e.shiftKey && e.key.toLowerCase() === "d") return "favorite";
  if (ctrl && !e.shiftKey && e.key.toLowerCase() === "i") return "details";
  if (ctrl && e.key === ",") return "settings";
  if (ctrl || e.altKey) return null;
  switch (e.key) {
    case "ArrowUp":
      return "up";
    case "ArrowDown":
      return "down";
    case "ArrowLeft":
      return editable ? null : "left";
    case "ArrowRight":
      return editable ? null : "right";
    case "Enter":
      return "confirm";
    case "Escape":
      return "back";
    case "Backspace":
      return editable ? null : "back";
    case "PageUp":
      return "pageUp";
    case "PageDown":
      return "pageDown";
    case "ContextMenu":
      return "menu";
    case "F10":
      return e.shiftKey ? "menu" : null;
  }
  return null;
}

export function hotkeyForKey(e: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">): Hotkey | null {
  const ctrl = e.ctrlKey || e.metaKey;
  if (e.key === "F11") return { kind: "command", command: "toggleCouch" };
  if (ctrl && e.shiftKey && e.key.toLowerCase() === "i") return { kind: "command", command: "devtools" };
  if (ctrl && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "r") return { kind: "command", command: "refresh" };
  if (ctrl && !e.altKey && /^Digit[1-9]$/.test(e.code)) return { kind: "view", key: `Ctrl+${e.code.slice(5)}` };
  return null;
}

export const input = {
  on(cb: NavListener): () => void {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },

  dispatch(name: NavName, source: NavEvent["source"], repeat = false): NavEvent {
    const ev: NavEvent = {
      name,
      source,
      repeat,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    for (const cb of [...listeners]) {
      try {
        cb(ev);
      } catch (err) {
        console.error("[vellum] nav listener failed", err);
      }
    }
    if (!ev.defaultPrevented) defaultHandler(ev);
    return ev;
  },

  setDefault(fn: (e: NavEvent) => void) {
    defaultHandler = fn;
  },

  setHotkeyHandler(fn: (h: Hotkey) => void) {
    hotkeyHandler = fn;
  },
};

window.addEventListener("keydown", (e) => {
  if (e.defaultPrevented || e.isComposing) return;
  const editable = isEditable(deepTarget(e));
  const hot = hotkeyForKey(e);
  if (hot) {
    e.preventDefault();
    hotkeyHandler(hot);
    return;
  }
  const name = navForKey(e, editable);
  if (name) {
    // Enter inside a text field belongs to the field unless it's the search box.
    if (editable && name === "confirm" && !(deepTarget(e) as HTMLElement).closest?.("[data-vellum-search]")) return;
    e.preventDefault();
    input.dispatch(name, "keyboard", e.repeat);
    return;
  }
});
