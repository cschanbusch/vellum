// Aero: bubbles that drift up behind the library, and the sky option.
import vellum from "/__vellum/sdk.js";

const layer = document.querySelector(".aero-bubbles");

/** Deterministic pseudo-random numbers, so the bubbles look the same on every load. */
function rng(seed) {
  let a = seed;
  return () => {
    a = (a * 1664525 + 1013904223) >>> 0;
    return a / 4294967296;
  };
}

function makeBubbles() {
  const r = rng(7);
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 22; i++) {
    const b = document.createElement("span");
    const size = 14 + r() * 70;
    b.style.cssText = `--size:${size}px; --x:${r() * 100}%; --dur:${16 + r() * 22}s; --delay:${-r() * 30}s; --drift:${(r() - 0.5) * 120}px`;
    frag.append(b);
  }
  layer.replaceChildren(frag);
}

function applySky() {
  document.documentElement.dataset.sky = String(vellum.skin.options.sky ?? "day");
}

makeBubbles();
await vellum.ready();
applySky();
vellum.skin.on("options", applySky);
