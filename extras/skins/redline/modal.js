// A full-screen overlay that owns the input while it is open: keyboard keys are taken before
// Vellum sees them, and controller buttons arrive as nav events, which are claimed too.
import vellum from "/__vellum/sdk.js";

/** Open overlays, topmost last. Only the topmost gets input. */
const stack = [];

/** Whether an overlay is open. `rl-modal` fires on window whenever that changes. */
export const modalOpen = () => stack.length > 0;
const announce = () => dispatchEvent(new CustomEvent("rl-modal", { detail: { open: stack.length > 0 } }));

const KEYS = { Enter: "confirm", " ": "confirm", Escape: "back", Backspace: "back", s: "alt", S: "alt" };

addEventListener(
  "keydown",
  (e) => {
    const top = stack.at(-1);
    if (!top) return;
    // Everything is swallowed while an overlay is open, so typing doesn't start a search behind it.
    e.preventDefault();
    e.stopImmediatePropagation();
    const name = KEYS[e.key];
    if (name) top[name]?.(e);
  },
  true,
);
addEventListener(
  "keyup",
  (e) => {
    const top = stack.at(-1);
    if (!top) return;
    e.stopImmediatePropagation();
    if (e.key === "Enter" || e.key === " ") top.confirmUp?.(e);
  },
  true,
);
// Controller buttons come from the shell as nav events.
vellum.input.on("nav", (e) => {
  const top = stack.at(-1);
  if (!top) return;
  e.preventDefault();
  if (e.source === "keyboard") return; // handled above
  const name = { confirm: "confirm", back: "back", favorite: "alt" }[e.name];
  if (name) top[name]?.(e);
});

/**
 * Opens `el` (added to <body>) on top of any other overlay and routes input to `actions`:
 * `confirm` (Enter / A), `back` (Esc / B), `alt` (S / X), and `confirmUp` when Enter is
 * released. `actions` is read at each key, so its handlers can change. Returns a close function.
 */
export function modal(el, actions) {
  document.body.append(el);
  const prevFocus = document.activeElement;
  stack.push(actions);
  if (stack.length === 1) announce();
  requestAnimationFrame(() => el.classList.add("is-open"));
  return () => {
    const i = stack.indexOf(actions);
    if (i >= 0) {
      stack.splice(i, 1);
      if (!stack.length) announce();
    }
    el.classList.remove("is-open");
    el.classList.add("is-closing");
    setTimeout(() => el.remove(), 260);
    if (prevFocus instanceof HTMLElement) prevFocus.focus({ preventScroll: true });
  };
}

export function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/**
 * A tachometer dial: ticks 0-8 (x1000 rpm), a red zone from 6.5, and a needle. The needle is a
 * second SVG over the dial, turned with a CSS transform on a layer of its own: moving it inside
 * the dial repainted every tick, number and glow on every frame. `svg` is the element to place.
 */
export function tachometer(cls = "") {
  const ns = "http://www.w3.org/2000/svg";
  const box = document.createElement("div");
  box.className = `rl-tach ${cls}`;
  box.setAttribute("aria-hidden", "true");
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "-110 -110 220 192");
  svg.setAttribute("class", "rl-tach-dial");
  const arc = (from, to, r) => {
    // Angles: 0 rpm at -225deg (bottom left) to 8000 at 45deg.
    const a0 = ((-225 + (from / 8) * 270) * Math.PI) / 180;
    const a1 = ((-225 + (to / 8) * 270) * Math.PI) / 180;
    const p = (a) => `${(Math.cos(a) * r).toFixed(2)} ${(Math.sin(a) * r).toFixed(2)}`;
    return `M ${p(a0)} A ${r} ${r} 0 ${to - from > 4 ? 1 : 0} 1 ${p(a1)}`;
  };
  const path = (d, c) => {
    const e = document.createElementNS(ns, "path");
    e.setAttribute("d", d);
    e.setAttribute("class", c);
    svg.append(e);
    return e;
  };
  path(arc(0, 8, 96), "rl-tach-rim");
  path(arc(6.5, 8, 86), "rl-tach-red");
  const zone = path(arc(0, 0.01, 86), "rl-tach-zone");
  for (let i = 0; i <= 16; i++) {
    const a = ((-225 + (i / 16) * 270) * Math.PI) / 180;
    const major = i % 2 === 0;
    const r0 = major ? 70 : 76;
    const line = document.createElementNS(ns, "line");
    line.setAttribute("x1", (Math.cos(a) * r0).toFixed(2));
    line.setAttribute("y1", (Math.sin(a) * r0).toFixed(2));
    line.setAttribute("x2", (Math.cos(a) * 84).toFixed(2));
    line.setAttribute("y2", (Math.sin(a) * 84).toFixed(2));
    line.setAttribute("class", major ? "rl-tach-major" : "rl-tach-minor");
    svg.append(line);
    if (major) {
      const t = document.createElementNS(ns, "text");
      t.setAttribute("x", (Math.cos(a) * 56).toFixed(2));
      t.setAttribute("y", (Math.sin(a) * 56 + 5).toFixed(2));
      t.setAttribute("class", "rl-tach-num");
      t.textContent = String(i / 2);
      svg.append(t);
    }
  }
  const label = document.createElementNS(ns, "text");
  label.setAttribute("x", "0");
  label.setAttribute("y", "34");
  label.setAttribute("class", "rl-tach-unit");
  label.textContent = "x1000 r/min";
  svg.append(label);
  const needle = document.createElementNS(ns, "svg");
  needle.setAttribute("viewBox", "-110 -110 220 192");
  needle.setAttribute("class", "rl-tach-needle");
  // The shadow is a second, offset shape: a drop-shadow filter would be redrawn as it turns.
  needle.innerHTML = `<path class="rl-tach-shadow" d="M -4 2 L 0 -86 L 4 2 Z"/><path d="M -4 0 L 0 -88 L 4 0 Z"/><circle r="9"/>`;
  box.append(svg, needle);
  /** Points the needle at `rpm` (thousands). */
  const set = (rpm) => (needle.style.transform = `rotate(${(-135 + (Math.max(0, Math.min(8.4, rpm)) / 8) * 270).toFixed(2)}deg)`);
  set(0);
  /** Marks a target band on the dial (thousands of rpm). */
  const band = (from, to) => zone.setAttribute("d", arc(from, to, 86));
  return { svg: box, set, band, zone };
}
