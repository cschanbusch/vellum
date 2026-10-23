// The HUB's AWESOME Sink: a backlog roulette. Feeding it (the bay, or S) prints a coupon naming a
// game to play. Accept jumps the HUB to that game's Milestone, where Submit launches it as usual.
// Re-sink feeds the named game into the Sink for points and prints another: a sunk game stays out
// of the shuffle until a coupon is accepted.
//
// The pick is weighted, gently: never played ×3, installed ×1.5, last played over a year ago
// ×1.5, everything else ×1. Points and the coupon number are kept between sessions (skin
// storage); the sunk games are not.

import { churn, clunk, printer } from "./hub-sound.js";

const PROCESS_MS = 900; // the Sink churning before a coupon prints
const PRINT_MS = 700;

const LINES = {
  idle: ["Installed and idle. Depreciating as we speak.", "Ready on the factory floor. Untouched.", "Fully installed. Fully ignored. FICSIT has noticed."],
  never: ["Acquired, never commissioned.", "Inventory shows zero shifts logged.", "Purchased with enthusiasm. Unopened with consistency."],
  neglected: ["Last shift {ago}. The machinery misses you.", "Dormant since {ago}. Maintenance recommends a visit."],
  any: ["Selected for quality assurance.", "Chosen by the AWESOME algorithm. Do not question the algorithm.", "A sound investment of leisure. Probably.", "Productivity models predict a satisfactory shift."],
};

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const pickOne = (list) => list[Math.floor(Math.random() * list.length)];
const installed = (e) => e.sources.some((s) => s.installDir);
const played = (e) => (e.playtimeMinutes ?? 0) > 0 || !!(e.lastPlayed || e.lastLaunched);
const idleDays = (e) => {
  const t = Date.parse(e.lastPlayed || e.lastLaunched || "");
  return Number.isFinite(t) ? (Date.now() - t) / 86_400_000 : null;
};

/** The pick's weight for one game. */
export function weight(e) {
  let w = 1;
  if (!played(e)) w *= 3;
  if (installed(e)) w *= 1.5;
  const d = idleDays(e);
  if (d != null && d > 365) w *= 1.5;
  return w;
}

/** Points for sinking a game: heavier assets are worth more. */
function points(e) {
  const gb = (e.sizeBytes ?? 0) / 1024 ** 3;
  return Math.round(40 + Math.min(gb, 150) * 6 + Math.random() * 25);
}

// Sunk games, out of the shuffle until a coupon is accepted. Kept across view switches.
const sunk = new Set();

/**
 * The Sink for one mounted HUB. `pool()` gives the games to pick from, `tierOf(e)` and
 * `ago(iso)` describe them, and `accept(id)` shows a game's Milestone.
 */
export function createSink(api, { pool, tierOf, tierName, ago, accept }) {
  let open = false;
  let busy = false;
  let current = null;
  let choice = 0; // 0 Accept, 1 Re-sink
  let timers = [];
  const store = (k, v) => {
    try {
      api.skin.storage.set(`sink.${k}`, v);
    } catch {
      // storage unavailable: points last for this session
    }
  };
  const load = (k, d) => {
    try {
      return api.skin.storage.get(`sink.${k}`, d) ?? d;
    } catch {
      return d;
    }
  };
  let total = Number(load("points", 0)) || 0;
  let coupon = Number(load("coupon", 0)) || 0;

  // ---- the slip over the Milestone panel ----
  const slip = el("div", "fx-sink");
  slip.hidden = true;
  const machine = el("div", "fx-sink-machine");
  const head = el("div", "fx-sink-head");
  const close = el("button", "fx-sink-close", "✕");
  close.type = "button";
  close.tabIndex = -1;
  close.title = "Close (Esc)";
  close.addEventListener("click", () => hide());
  head.append(el("span", "fx-sink-title", "AWESOME Sink"), close);
  const vortex = el("div", "fx-sink-vortex");
  vortex.append(el("i"), el("i"), el("b"));
  const counter = el("div", "fx-sink-counter");
  const status = el("div", "fx-sink-status");
  const gauge = el("div", "fx-sink-gauge");
  gauge.append(el("span", "fx-sink-gauge-k", "Points"), counter, status);
  const slot = el("div", "fx-sink-slot");
  const buttons = el("div", "fx-sink-buttons");
  const acceptBtn = el("button", "fx-sink-btn is-accept", "Accept assignment");
  const resinkBtn = el("button", "fx-sink-btn is-resink", "Re-sink");
  for (const [b, i] of [
    [acceptBtn, 0],
    [resinkBtn, 1],
  ]) {
    b.type = "button";
    b.tabIndex = -1;
    b.addEventListener("click", () => {
      choice = i;
      confirm();
    });
  }
  buttons.append(acceptBtn, resinkBtn);
  const hint = el("div", "fx-sink-hint", "Enter accepts · S re-sinks · Esc closes");
  machine.append(head, vortex, gauge, slot, buttons, hint);
  slip.append(machine);

  function later(fn, ms) {
    timers.push(setTimeout(fn, ms));
  }

  function paintCounter(n = total) {
    counter.textContent = Math.round(n).toLocaleString().padStart(7, "0");
  }

  function paintChoice() {
    acceptBtn.classList.toggle("is-at", choice === 0);
    resinkBtn.classList.toggle("is-at", choice === 1);
    acceptBtn.disabled = resinkBtn.disabled = busy || !current;
  }

  /** Roll the counter from `from` to `to` while the Sink churns. */
  function roll(from, to, ms) {
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / ms);
      paintCounter(from + (to - from) * (1 - (1 - k) ** 3));
      if (k < 1 && open) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function pick() {
    let games = pool().filter((e) => e.kind === "game" && !sunk.has(e.id));
    let flushed = false;
    if (!games.length) {
      // Everything has been sunk: flush the Sink and start over.
      sunk.clear();
      games = pool().filter((e) => e.kind === "game");
      flushed = true;
    }
    if (!games.length) return { e: null, flushed };
    const ws = games.map(weight);
    let r = Math.random() * ws.reduce((a, b) => a + b, 0);
    for (let i = 0; i < games.length; i++) {
      r -= ws[i];
      if (r <= 0) return { e: games[i], flushed };
    }
    return { e: games.at(-1), flushed };
  }

  function reason(e) {
    const d = idleDays(e);
    if (!played(e)) return pickOne(installed(e) ? LINES.idle : LINES.never);
    if (d != null && d > 365 && Math.random() < 0.7) return pickOne(LINES.neglected).replace("{ago}", ago(e.lastPlayed || e.lastLaunched).toLowerCase());
    return pickOne(LINES.any);
  }

  function printCoupon(flushed) {
    const e = current;
    slot.replaceChildren();
    if (!e) {
      slot.append(el("div", "fx-sink-coupon is-empty", "No assets in range. Adjust your filters, Pioneer."));
      return;
    }
    coupon += 1;
    store("coupon", coupon);
    const c = el("div", "fx-sink-coupon");
    const t = tierOf(e);
    c.append(
      el("div", "fx-sink-coupon-head", `✂ FICSIT coupon #${String(coupon).padStart(4, "0")}`),
      el("div", "fx-sink-coupon-redeem", "Redeem for: 1 shift"),
      el("div", "fx-sink-coupon-title", e.title),
      el("div", "fx-sink-coupon-tier", `Tier ${t} · ${tierName(t)}`),
      el("div", "fx-sink-coupon-why", `“${reason(e)}”`),
    );
    if (flushed) c.append(el("div", "fx-sink-coupon-note", "Sink flushed: every asset was sunk, so the shuffle starts over."));
    slot.append(c);
    printer(PRINT_MS / 1000);
  }

  /** Churn, then print a coupon. `fed` is the game being sunk, if any. */
  function run(fed) {
    busy = true;
    paintChoice();
    slip.classList.add("is-processing");
    slot.querySelector(".fx-sink-coupon")?.classList.add("is-gone");
    const gain = fed ? points(fed) : 0;
    status.textContent = fed ? `+${gain.toLocaleString()} // ${fed.title}` : "Processing…";
    churn(PROCESS_MS / 1000);
    roll(total, total + gain, PROCESS_MS);
    total += gain;
    store("points", total);
    later(() => {
      slip.classList.remove("is-processing");
      const { e, flushed } = pick();
      current = e;
      printCoupon(flushed);
      status.textContent = `${sunk.size.toLocaleString()} sunk this shuffle`;
      later(() => {
        busy = false;
        choice = 0;
        paintChoice();
      }, PRINT_MS);
    }, PROCESS_MS);
  }

  function show() {
    if (open) return;
    open = true;
    slip.hidden = false;
    void slip.offsetWidth;
    slip.classList.add("is-open");
    paintCounter();
    clunk(0);
    run(null);
  }

  function hide() {
    if (!open) return;
    timers.forEach(clearTimeout);
    timers = [];
    open = false;
    busy = false;
    current = null;
    slip.classList.remove("is-open", "is-processing");
    slip.hidden = true;
    slot.replaceChildren();
  }

  function resink() {
    if (busy || !current) return;
    sunk.add(current.id);
    clunk(2);
    run(current);
  }

  function confirm() {
    if (busy || !current) return;
    if (choice === 1) return resink();
    const id = current.id;
    sunk.clear(); // the shuffle is over
    hide();
    accept(id);
  }

  return {
    slip,
    get open() {
      return open;
    },
    get points() {
      return total;
    },
    /** S, or the bay: feed the Sink (open it, or re-sink the coupon on show). */
    feed() {
      if (open) resink();
      else show();
    },
    confirm,
    hide,
    nav(dir) {
      if ((dir === "left" || dir === "right") && !busy && current) {
        choice = dir === "left" ? 0 : 1;
        paintChoice();
      }
    },
    destroy() {
      hide();
    },
  };
}
