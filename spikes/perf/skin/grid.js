// Virtualized cover grid: a fixed pool of cells is repositioned as the user scrolls, so DOM
// size depends on the viewport, not on the 3,000 entries. Then a scripted scroll benchmark.
const N = 3000, ART_COUNT = 120, OVERSCAN_ROWS = 2;
const mode = new URLSearchParams(location.search).get("mode") ?? "native";
const scroller = document.getElementById("scroller");
const spacer = document.getElementById("spacer");
const hud = document.getElementById("hud");

const css = getComputedStyle(document.documentElement);
const coverW = parseFloat(css.getPropertyValue("--v-cover-width"));
const gap = parseFloat(css.getPropertyValue("--v-gap"));
const rowH = coverW * 1.5 + 22 + gap;

const entries = Array.from({ length: N }, (_, i) => ({ title: `Game ${i + 1}`, art: i % ART_COUNT }));
const variant = (() => {
  const need = coverW * devicePixelRatio;
  return [320, 640].find((w) => w >= need) ?? "full";
})();
const artUrl = (n) => `art/${variant}/${String(n).padStart(3, "0")}.jpg`;

let cols = 1, pool = [], loads = 0;

function layout() {
  const width = scroller.clientWidth - gap;
  cols = Math.max(1, Math.floor(width / (coverW + gap)));
  spacer.style.height = `${Math.ceil(N / cols) * rowH}px`;
  const rows = Math.ceil(scroller.clientHeight / rowH) + OVERSCAN_ROWS * 2 + 1;
  while (pool.length < rows * cols) {
    const el = document.createElement("div");
    el.className = "cell";
    const img = document.createElement("img");
    img.decoding = "async";
    img.addEventListener("load", () => loads++);
    const span = document.createElement("span");
    el.append(img, span);
    spacer.append(el);
    pool.push({ el, img, span, idx: -1 });
  }
  render();
}

function render() {
  const firstRow = Math.max(0, Math.floor(scroller.scrollTop / rowH) - OVERSCAN_ROWS);
  const left0 = gap;
  for (let i = 0; i < pool.length; i++) {
    const cell = pool[i];
    const idx = firstRow * cols + i;
    if (idx >= N) { cell.el.style.display = "none"; continue; }
    if (cell.idx === idx) continue;
    cell.idx = idx;
    const row = Math.floor(idx / cols), col = idx % cols;
    cell.el.style.display = "";
    cell.el.style.transform = `translate(${left0 + col * (coverW + gap)}px, ${gap + row * rowH}px)`;
    cell.img.src = artUrl(entries[idx].art);
    cell.span.textContent = entries[idx].title;
  }
}

let scheduled = false;
scroller.addEventListener("scroll", () => {
  if (!scheduled) { scheduled = true; requestAnimationFrame(() => { scheduled = false; render(); }); }
}, { passive: true });
addEventListener("resize", layout);

// ---- benchmark ----
let longTasks = 0;
try { new PerformanceObserver((l) => (longTasks += l.getEntries().length)).observe({ type: "longtask" }); } catch {}

function stats(name, deltas, longBefore) {
  const s = [...deltas].sort((a, b) => a - b);
  const pct = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  const median = pct(0.5);
  return {
    phase: name,
    frames: s.length,
    avgFps: +(1000 / (s.reduce((a, b) => a + b, 0) / s.length)).toFixed(1),
    p50ms: +median.toFixed(2), p95ms: +pct(0.95).toFixed(2), p99ms: +pct(0.99).toFixed(2),
    maxMs: +s[s.length - 1].toFixed(1),
    framesOver1_5xMedian: s.filter((d) => d > median * 1.5).length,
    framesOver33ms: s.filter((d) => d > 33.4).length,
    longTasks: longTasks - longBefore,
  };
}

function runPhase(name, ms, step) {
  return new Promise((resolve) => {
    const deltas = [], longBefore = longTasks;
    let start = null, last = null;
    function frame(t) {
      if (start === null) start = last = t;
      else { deltas.push(t - last); last = t; }
      step(t - start, t);
      if (t - start < ms) requestAnimationFrame(frame);
      else resolve(stats(name, deltas, longBefore));
    }
    requestAnimationFrame(frame);
  });
}

const scrollAtSpeed = (pxPerSec) => {
  let prev = 0;
  return (elapsed) => {
    scroller.scrollTop += (pxPerSec * (elapsed - prev)) / 1000;
    prev = elapsed;
    if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) scroller.scrollTop = 0;
  };
};

async function bench() {
  layout();
  await runPhase("idle", 1500, () => {});
  const phases = [
    await runPhase("slow scroll 1200 px/s", 4000, scrollAtSpeed(1200)),
    await runPhase("fast scroll 6000 px/s", 4000, scrollAtSpeed(6000)),
    await runPhase("page jumps every 150 ms", 3000, (() => {
      let next = 0;
      return (elapsed) => { if (elapsed >= next) { scroller.scrollTop += scroller.clientHeight; next += 150; } };
    })()),
  ];
  const report = {
    mode, entries: N, devicePixelRatio,
    viewportCss: `${innerWidth}x${innerHeight}`,
    viewportPhysical: `${Math.round(innerWidth * devicePixelRatio)}x${Math.round(innerHeight * devicePixelRatio)}`,
    cols, pooledCells: pool.length, domNodes: document.getElementsByTagName("*").length,
    imageVariant: variant, imageLoads: loads, phases,
  };
  hud.textContent = phases.map((p) => `${p.phase}: ${p.avgFps} fps p95 ${p.p95ms}ms`).join(" | ");
  parent.postMessage({ type: "perf-report", report }, "*");
}

addEventListener("load", () => setTimeout(bench, 300));
