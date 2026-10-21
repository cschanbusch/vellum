// Frontier Catalogue: the page-turn engine.
//
// A leaf is one sheet of paper hinged at the spine, with a page printed on each face. To make
// it bend, it is cut into vertical strips, each hinged to the one before it: every strip turns a
// little further than its neighbour nearer the spine, so the paper curves as it lifts. Each strip
// shows the matching slice of a copy of its pages, and the slices line up into whole pages.
//
// Forward (dir 1) the leaf lies over the right page and turns right to left. Its front is that
// page and its back is the next spread's left page. Backward (dir -1) is the mirror image.

const RAD = Math.PI / 180;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** Each strip's angle from flat, in degrees: 0 lies on its own side, 180 on the other. The
 *  strips nearer the fore-edge lead, so the leaf curls most in the middle of a turn. */
export function angles(t, n, bend) {
  const phi = 180 * t;
  const b = bend * Math.sin(Math.PI * t);
  const out = new Array(n);
  for (let k = 0; k < n; k++) out[k] = clamp(phi + b * (n === 1 ? 0 : k / (n - 1) - 0.4), 0, 180);
  return out;
}

/** Where the fore-edge appears, as a fraction of the page width out from the spine: 1 is the
 *  leaf lying flat where it started, -1 lying flat on the other side. */
export function edge(t, n, bend) {
  return angles(t, n, bend).reduce((x, a) => x + Math.cos(a * RAD), 0) / n;
}

/** The progress at which the fore-edge appears at `x` (the same fraction as `edge`). */
export function progressAt(x, n, bend) {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (edge(mid, n, bend) > x) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function slice(page, offset, width, height) {
  const box = document.createElement("div");
  box.className = "fr-cat-slice";
  if (page) {
    page.style.cssText += `;inset:auto;left:${offset}px;top:0;width:${width}px;height:${height}px`;
    box.append(page);
  }
  // Two overlays shade the slice: an even tone, and a ramp that deepens across it. Both change
  // only their opacity, so a turn never repaints the page itself.
  const shade = document.createElement("div");
  shade.className = "fr-cat-shade";
  const ramp = document.createElement("div");
  ramp.className = "fr-cat-ramp";
  box.append(shade, ramp);
  return { box, shade, ramp };
}

/**
 * Builds a leaf in `layer` (a positioned layer over the whole book, with perspective).
 *   dir      1 forward, -1 backward
 *   front    () => Element: a fresh copy of the page on the face that starts up
 *   back     () => Element: a fresh copy of the page on the other face
 *   width, height  page size in px
 *   strips   how many strips (1 = a rigid board, as for the cover)
 *   bend     how far the leaf curls, in degrees
 */
export function createLeaf(layer, { dir, front, back, width, height, strips = 8, bend = 62, className = "" }) {
  const el = document.createElement("div");
  el.className = `fr-cat-leaf ${dir > 0 ? "is-fwd" : "is-bwd"} ${className}`;
  el.style.width = `${width}px`;
  el.style.height = `${height}px`;
  el.inert = true;
  const s = width / strips;
  const parts = [];
  let parent = el;
  for (let k = 0; k < strips; k++) {
    const strip = document.createElement("div");
    strip.className = "fr-cat-strip";
    strip.style.width = `${s}px`;
    strip.style.height = `${height}px`;
    if (k > 0) strip.style[dir > 0 ? "left" : "right"] = `${s}px`;
    // Forward, strip k covers [k·s, (k+1)·s] of the right page and lands on [w-(k+1)·s, w-k·s]
    // of the left page; backward is the mirror image.
    const near = -k * s;
    const far = -(width - (k + 1) * s);
    const f = slice(front?.(), dir > 0 ? near : far, width, height);
    const b = slice(back?.(), dir > 0 ? far : near, width, height);
    f.box.classList.add("is-front");
    b.box.classList.add("is-back");
    strip.append(f.box, b.box);
    parent.append(strip);
    parts.push({ strip, front: f, back: b });
    parent = strip;
  }

  const leaf = {
    el,
    t: 0,
    dir,
    strips,
    bend,
    set(t) {
      leaf.t = t;
      const a = angles(t, strips, bend);
      let prev = 0;
      // Light falls from above: a face is brightest lying flat and darkens as it stands on edge.
      // Each strip's shade runs between the angles at its two edges, so the paper reads as one
      // smooth curve rather than flat facets.
      const front = (x) => (1 - Math.cos(x * RAD)) * 0.42;
      const back = (x) => (1 + Math.cos(x * RAD)) * 0.42;
      for (let k = 0; k < strips; k++) {
        const p = parts[k];
        p.strip.style.transform = `rotateY(${-dir * (a[k] - prev)}deg)`;
        prev = a[k];
        const near = k ? (a[k - 1] + a[k]) / 2 : a[0];
        const far = k < strips - 1 ? (a[k] + a[k + 1]) / 2 : a[k];
        // The front darkens towards the fore-edge, the back towards the spine. The back face is
        // mirrored, so the same ramp direction (set in CSS) serves both.
        p.front.shade.style.opacity = front(near).toFixed(3);
        p.front.ramp.style.opacity = (front(far) - front(near)).toFixed(3);
        p.back.shade.style.opacity = back(far).toFixed(3);
        p.back.ramp.style.opacity = (back(near) - back(far)).toFixed(3);
      }
      return leaf;
    },
    /** Moves to progress `to` over `ms`, eased. Resolves when done or when the leaf is removed. */
    animate(to, ms, onFrame) {
      const from = leaf.t;
      const start = performance.now();
      return new Promise((resolve) => {
        const step = (now) => {
          if (!el.isConnected) return resolve();
          const u = ms > 0 ? clamp((now - start) / ms, 0, 1) : 1;
          leaf.set(from + (to - from) * ease(u));
          onFrame?.(leaf);
          if (u < 1) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      });
    },
    remove() {
      el.remove();
    },
  };
  layer.append(el);
  return leaf.set(0);
}
