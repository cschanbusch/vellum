// Art URLs. Every entry's art is served on the skin's own origin at
// /__vellum/art/<entryId>/<kind>?v=<version>; `w` asks for a resized variant.

import type { ArtKind, Entry } from "./types";

/** Widths the backend resizes to; anything wider gets the original ("full"). */
export const ART_WIDTHS = [160, 320, 640, 1280, 1920] as const;
export type ArtWidth = (typeof ART_WIDTHS)[number] | "full";

/** Snaps a pixel width up to the next variant. */
export function snapWidth(px: number): ArtWidth {
  if (!Number.isFinite(px) || px <= 0) return ART_WIDTHS[0];
  return ART_WIDTHS.find((w) => w >= px) ?? "full";
}

export function withWidth(url: string, width: ArtWidth): string {
  return `${url}${url.includes("?") ? "&" : "?"}w=${width}`;
}

/** CSS pixels each kind is usually drawn at, when the caller gives no width. */
function typicalWidth(kind: ArtKind): number {
  const root = getComputedStyle(document.documentElement);
  switch (kind) {
    case "cover":
      return parseFloat(root.getPropertyValue("--v-cover-width")) || 200;
    case "hero":
      return window.innerWidth;
    case "header":
      return 460;
    case "logo":
      return Math.min(640, window.innerWidth / 2);
    case "icon":
      return 48;
  }
}

/**
 * URL for an entry's art. `width` may be CSS pixels, an element to size from, or "full".
 * Omitted, it is sized from the kind's usual size. Widths are multiplied by devicePixelRatio.
 */
export function artUrl(entry: Entry, kind: ArtKind, width?: number | Element | "full"): string {
  const base = entry.art[kind];
  if (width === "full") return withWidth(base, "full");
  const css =
    typeof width === "number"
      ? width
      : width instanceof Element
        ? width.getBoundingClientRect().width || typicalWidth(kind)
        : typicalWidth(kind);
  return withWidth(base, snapWidth(css * (window.devicePixelRatio || 1)));
}
