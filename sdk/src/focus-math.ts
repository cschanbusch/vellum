// Geometry for spatial navigation: given the focused rectangle and the candidates, which one
// does a direction lead to? Pure, so it is unit-tested without layout.

export type Direction = "up" | "down" | "left" | "right";

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const EPS = 1;

/** Distance along the direction (edge to edge) and across it (0 when the boxes overlap), or null if `to` isn't that way. */
function distances(from: Box, to: Box, dir: Direction): [number, number] | null {
  const horizontal = dir === "left" || dir === "right";
  const sign = dir === "right" || dir === "down" ? 1 : -1;
  const [fLo, fHi, tLo, tHi] = horizontal ? [from.left, from.right, to.left, to.right] : [from.top, from.bottom, to.top, to.bottom];
  // `to` must lie further that way: its centre beyond ours, and its far edge beyond our far edge.
  const fc = (fLo + fHi) / 2;
  const tc = (tLo + tHi) / 2;
  if (sign * (tc - fc) <= EPS) return null;
  if (sign > 0 ? tHi <= fHi + EPS : tLo >= fLo - EPS) return null;
  const primary = Math.max(0, sign > 0 ? tLo - fHi : fLo - tHi);
  const [aLo, aHi, bLo, bHi] = horizontal ? [from.top, from.bottom, to.top, to.bottom] : [from.left, from.right, to.left, to.right];
  const overlap = Math.min(aHi, bHi) - Math.max(aLo, bLo);
  const across = overlap > 0 ? 0 : Math.abs((aLo + aHi) / 2 - (bLo + bHi) / 2);
  return [primary, across];
}

/** Index of the best candidate in `dir`, or -1. Boxes off to the side cost twice their offset. */
export function pickNext(from: Box, candidates: readonly Box[], dir: Direction): number {
  let best = -1;
  let bestScore = Infinity;
  candidates.forEach((c, i) => {
    if (c.right - c.left <= 0 || c.bottom - c.top <= 0) return;
    const d = distances(from, c, dir);
    if (!d) return;
    const score = d[0] + 2 * d[1];
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}
