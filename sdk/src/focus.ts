// Spatial focus over elements marked `data-vellum-focus`, used by keyboard and controller alike.
//
// Plain elements (buttons, inputs) are focused directly. Collections (grid, list, shelf) are
// *containers*: the container element holds DOM focus and moves its own selection, and only
// hands off to the geometric search when a move would leave it.

import { pickNext, type Box, type Direction } from "./focus-math";

export interface NavContainer extends HTMLElement {
  /** Moves the selection inside; false when the move would leave the container. */
  vellumNav(dir: Direction | "pageUp" | "pageDown"): boolean;
  /** Viewport box of the selected item, used as the starting point for leaving. */
  vellumFocusBox(): Box | null;
  /** Focus arrives from `from` (a box outside), moving in `dir`; pick the nearest item. */
  vellumEnter(from: Box | null, dir: Direction | null): void;
  /** confirm on the container: act on the selected item. */
  vellumConfirm?(): void;
}

export const isContainer = (el: Element | null): el is NavContainer =>
  !!el && typeof (el as Partial<NavContainer>).vellumNav === "function";

const toBox = (r: DOMRect): Box => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });

/** The focused element, looking into shadow roots. */
export function deepActive(): HTMLElement | null {
  let a: Element | null = document.activeElement;
  while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
  return a instanceof HTMLElement && a !== document.body ? a : null;
}

function parentOf(el: Element): Element | null {
  if (el.parentElement) return el.parentElement;
  const root = el.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

function containerOf(el: Element | null): NavContainer | null {
  for (let e = el; e; e = parentOf(e)) if (isContainer(e)) return e;
  return null;
}

function contains(outer: Element, inner: Element): boolean {
  for (let e: Element | null = inner; e; e = parentOf(e)) if (e === outer) return true;
  return false;
}

/** Every focus target in the document and in open shadow roots, on screen and not disabled. */
export function focusables(root: Document | ShadowRoot = document, out: HTMLElement[] = []): HTMLElement[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  for (let n = walker.nextNode() as Element | null; n; n = walker.nextNode() as Element | null) {
    if (n.hasAttribute("data-vellum-focus") && n instanceof HTMLElement && !(n as HTMLButtonElement).disabled && !n.closest("[inert]")) {
      out.push(n);
    }
    if (n.shadowRoot) focusables(n.shadowRoot, out);
  }
  return out;
}

function onScreen(b: Box): boolean {
  return b.right - b.left > 0 && b.bottom - b.top > 0 && b.bottom > 0 && b.right > 0 && b.top < innerHeight && b.left < innerWidth;
}

function focusEl(el: HTMLElement, from: Box | null, dir: Direction | null) {
  el.focus({ preventScroll: true });
  if (isContainer(el)) el.vellumEnter(from, dir);
  else el.scrollIntoView({ block: "nearest", inline: "nearest" });
}

export const focus = {
  current: deepActive,

  /** Moves focus one step. Returns false when there is nothing that way. */
  move(dir: Direction): boolean {
    const active = deepActive();
    if (!active) return focus.focusDefault();
    const container = containerOf(active);
    if (container?.vellumNav(dir)) return true;
    const from = container?.vellumFocusBox() ?? toBox(active.getBoundingClientRect());
    const self = container ?? active;
    const candidates = focusables().filter((el) => el !== self && !contains(el, self) && !contains(self, el));
    const boxes = candidates.map((el) => toBox(el.getBoundingClientRect()));
    const i = pickNext(
      from,
      boxes.map((b) => (onScreen(b) ? b : { left: 0, top: 0, right: 0, bottom: 0 })),
      dir,
    );
    if (i < 0) return false;
    focusEl(candidates[i], from, dir);
    return true;
  },

  /** Page up/down inside the focused collection. */
  page(dir: "pageUp" | "pageDown"): boolean {
    return containerOf(deepActive())?.vellumNav(dir) ?? false;
  },

  /** Acts on the focused element: a container's selected item, or a click. */
  activate(): boolean {
    const active = deepActive();
    if (!active) return false;
    const c = containerOf(active);
    if (c?.vellumConfirm) {
      c.vellumConfirm();
      return true;
    }
    active.click();
    return true;
  },

  /**
   * Focuses the element marked `data-vellum-focus-default` (or the first focus target inside
   * it, e.g. a kit component's button), else the first target on screen.
   */
  focusDefault(): boolean {
    const all = focusables().filter((el) => onScreen(toBox(el.getBoundingClientRect())));
    const marked = all.find((e) => {
      for (let p: Element | null = e; p; p = parentOf(p)) if (p.hasAttribute("data-vellum-focus-default")) return true;
      return false;
    });
    const el = marked ?? all[0];
    if (!el) return false;
    focusEl(el, null, null);
    return true;
  },

  /** Focuses a specific element (a container receives focus on its selection). */
  to(el: HTMLElement) {
    focusEl(el, null, null);
  },
};
