// Gridline: light cycles racing across the background, turning at right angles and leaving
// trails that fade. Drawn on one canvas; paused when hidden, turned off, or with reduced motion.
import vellum from "/__vellum/sdk.js";

const canvas = document.querySelector(".gl-cycles");
const ctx = canvas.getContext("2d");
const CELL = 48; // the cycles ride a 48px lattice
const SPEED = 260; // px per second
const TRAIL = 900; // px of trail each cycle keeps
const reduced = matchMedia("(prefers-reduced-motion: reduce)");

let width = 0;
let height = 0;
let cycles = [];
let frame = 0;
let last = 0;

function resize() {
  const dpr = Math.min(2, devicePixelRatio || 1);
  width = innerWidth;
  height = innerHeight;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

const DIRS = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

function spawn(i) {
  const horizontal = Math.random() < 0.5;
  const fromStart = Math.random() < 0.5;
  const snap = (v) => Math.round(v / CELL) * CELL;
  const x = horizontal ? (fromStart ? -20 : width + 20) : snap(Math.random() * width);
  const y = horizontal ? snap(Math.random() * height) : fromStart ? -20 : height + 20;
  const dir = horizontal ? (fromStart ? 0 : 2) : fromStart ? 1 : 3;
  return { x, y, dir, trail: [[x, y]], travelled: 0, white: i === 0 };
}

function color() {
  return getComputedStyle(document.documentElement).getPropertyValue("--v-accent").trim() || "#ff2020";
}

function step(c, dist) {
  const [dx, dy] = DIRS[c.dir];
  const before = [c.x, c.y];
  c.x += dx * dist;
  c.y += dy * dist;
  // Turn at lattice points now and then.
  const crossed = dx ? Math.floor(before[0] / CELL) !== Math.floor(c.x / CELL) : Math.floor(before[1] / CELL) !== Math.floor(c.y / CELL);
  if (crossed && Math.random() < 0.18) {
    const px = dx ? Math.round(c.x / CELL) * CELL : c.x;
    const py = dy ? Math.round(c.y / CELL) * CELL : c.y;
    c.x = px;
    c.y = py;
    c.trail.push([px, py]);
    c.dir = (c.dir + (Math.random() < 0.5 ? 1 : 3)) % 4;
  }
  c.travelled += dist;
}

/** Trims a polyline (plus the current head) to its last `len` pixels. */
function tail(points, head, len) {
  const pts = [...points, head];
  const out = [head];
  let left = len;
  for (let i = pts.length - 2; i >= 0 && left > 0; i--) {
    const [ax, ay] = pts[i + 1];
    const [bx, by] = pts[i];
    const seg = Math.hypot(bx - ax, by - ay);
    if (seg >= left) {
      const t = left / seg;
      out.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
      break;
    }
    out.push([bx, by]);
    left -= seg;
  }
  return out;
}

function draw(now) {
  frame = requestAnimationFrame(draw);
  const dt = Math.min(0.05, (now - last) / 1000 || 0);
  last = now;
  ctx.clearRect(0, 0, width, height);
  const neon = color();
  for (let i = 0; i < cycles.length; i++) {
    const c = cycles[i];
    step(c, SPEED * dt);
    const off = c.x < -60 || c.y < -60 || c.x > width + 60 || c.y > height + 60;
    if (off && c.travelled > 200) {
      cycles[i] = spawn(i);
      continue;
    }
    const pts = tail(c.trail, [c.x, c.y], TRAIL);
    if (c.trail.length > 40) c.trail = c.trail.slice(-40);
    const grad = ctx.createLinearGradient(pts[0][0], pts[0][1], pts.at(-1)[0], pts.at(-1)[1]);
    grad.addColorStop(0, c.white ? "#ffffff" : neon);
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.lineJoin = "miter";
    ctx.lineCap = "butt";
    for (const [w, a] of [
      [10, 0.12],
      [4, 0.35],
      [1.6, 1],
    ]) {
      ctx.globalAlpha = a;
      ctx.lineWidth = w;
      ctx.strokeStyle = grad;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (const [x, y] of pts.slice(1)) ctx.lineTo(x, y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = c.white ? "#ffffff" : neon;
    ctx.shadowColor = neon;
    ctx.shadowBlur = 16;
    ctx.fillRect(c.x - 3, c.y - 3, 6, 6);
    ctx.shadowBlur = 0;
  }
}

function running() {
  return vellum.skin.options.cycles !== false && !reduced.matches && document.visibilityState === "visible";
}

function update() {
  cancelAnimationFrame(frame);
  if (!running()) {
    ctx.clearRect(0, 0, width, height);
    return;
  }
  if (!cycles.length) cycles = [0, 1, 2, 3].map(spawn);
  last = performance.now();
  frame = requestAnimationFrame(draw);
}

resize();
addEventListener("resize", resize);
document.addEventListener("visibilitychange", update);
reduced.addEventListener("change", update);
await vellum.ready();
update();
vellum.skin.on("options", update);
