// FICSIT's HUB view: the library as the HUB terminal's milestone screen, after Satisfactory's
// HUB. Fan-made; no game assets.
//
// Games are sorted into Tiers by lifetime hours (the store's playtime): Tier 0 has never been
// played, Tier 8 has 100 hours or more. The rail on the left lists the Tiers; the panel on the
// right shows one game of the current Tier as a Milestone: its schematic (hero art and logo),
// the cost plate (lifetime hours, last shift, supplier, manufacturer, footprint) and the unlocks
// plate (genres, labels and tags). The Space Elevator across the top counts the games that have
// been played against the current phase's target.
//
// Up/Down change Tier and Left/Right step through its Milestones (one focus container), and the
// rail and pager take clicks. Launching is a submission: hold Enter, Space or the Submit bay
// (or a controller's confirm button) for the "Submit hold time" option, and the Cost lines are delivered one by one; when the last arrives the Milestone is stamped
// complete, blast doors close over the panel and the game launches. They open again when the
// player comes back. A double-click submits at once. The "Submit ceremony" option shortens this
// to the stamp, or turns it off.
//
// The AWESOME Sink bay (or S) is a backlog roulette that prints a coupon naming a game; see
// hub-sink.js.

import { createSink } from "./hub-sink.js";
import { belt, chime, clunk, deny, doors, thud, unlatch } from "./hub-sound.js";

let api = null;
let root = null;
let rail = null;
let console_ = null; // the focus container: rail and milestone panel
let elevator = null;
let panel = null;
let empty = null;
let unsubs = [];
let key = "";

let tiers = []; // { n, name, entries }
let tier = 0; // index into tiers
let at = new Map(); // tier index -> milestone index
let tierOf = new Map(); // entry id -> tier index
let lastSel = null;

// Submitting. `hold` is null at rest.
let hold = null; // { down, until, since, progress, delivered, last, raf, held }
let beltSound = null; // the conveyor, running while Submit is held
let sealing = false; // stamped: input waits until the doors open again
let dirty = false; // a render waits for the doors
let doorsEl = null;
let sink = null; // the AWESOME Sink (hub-sink.js)
let timers = [];
let returnWatch = null;

const PAD_HOLD_MS = 380; // a controller button holds this long past its last repeat
const TAP_MS = 450; // a shorter hold is a tap: remind the player to hold
const APPROVALS = [
  "Productivity leave approved. Clock-in recorded.",
  "Pioneer dispatched. FICSIT wishes you an efficient shift.",
  "Leisure requisition stamped in triplicate.",
  "Milestone filed. Your supervisor has been notified.",
];

const TIERS = [
  { n: 0, name: "Onboarding", note: "Never launched" },
  { n: 1, name: "Inspected", note: "Under 1 hour" },
  { n: 2, name: "Commissioned", note: "1–5 hours" },
  { n: 3, name: "Operational", note: "5–15 hours" },
  { n: 4, name: "Productive", note: "15–30 hours" },
  { n: 5, name: "Optimized", note: "30–50 hours" },
  { n: 6, name: "Automated", note: "50–75 hours" },
  { n: 7, name: "Megafactory", note: "75–100 hours" },
  { n: 8, name: "Lifer", note: "100 hours or more" },
];
// Upper bounds in hours for Tiers 1–7; Tier 8 is everything above.
const BOUNDS = [1, 5, 15, 30, 50, 75, 100];
// Space Elevator targets: games played to complete each phase.
const PHASES = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

// ---- helpers --------------------------------------------------------------------------------

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** The Tier a game belongs in, by the store's lifetime playtime. */
function tierFor(e) {
  const h = (e.playtimeMinutes ?? 0) / 60;
  if (h <= 0) return e.lastPlayed || e.lastLaunched ? 1 : 0;
  const i = BOUNDS.findIndex((b) => h < b);
  return i < 0 ? 8 : i + 1;
}

function hours(e) {
  const m = e.playtimeMinutes ?? 0;
  if (m <= 0) return e.lastPlayed || e.lastLaunched ? "Unmetered" : "None logged";
  const h = m / 60;
  return `${h < 10 ? h.toFixed(1) : Math.round(h).toLocaleString()} h`;
}

function ago(iso) {
  if (!iso) return "No record";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "No record";
  const d = Math.floor((Date.now() - t) / 86_400_000);
  if (d <= 0) return "Today";
  if (d === 1) return "Yesterday";
  if (d < 60) return `${d} days ago`;
  if (d < 730) return `${Math.round(d / 30.4)} months ago`;
  return `${Math.round(d / 365.25)} years ago`;
}

function bytes(n) {
  if (!n) return "Unmeasured";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

function current() {
  const t = tiers[tier];
  return t?.entries[at.get(tier) ?? 0] ?? null;
}

// ---- building -------------------------------------------------------------------------------

function sort() {
  const entries = api.library.query();
  tiers = TIERS.map((t) => ({ ...t, entries: [] }));
  tierOf = new Map();
  for (const e of entries) {
    const i = tierFor(e);
    tiers[i].entries.push(e);
    tierOf.set(e.id, i);
  }
  for (const [i, n] of at) if (n >= tiers[i].entries.length) at.set(i, Math.max(0, tiers[i].entries.length - 1));
  return entries.length;
}

function renderElevator() {
  const played = tiers.reduce((n, t) => n + (t.n > 0 ? t.entries.length : 0), 0);
  const total = tiers.reduce((n, t) => n + t.entries.length, 0);
  const p = PHASES.findIndex((x) => played < x);
  const done = p < 0;
  const target = done ? PHASES.at(-1) : PHASES[p];
  const pct = total ? Math.round((played / total) * 100) : 0;
  elevator.replaceChildren(
    el("div", "fx-hub-elev-title", `Space Elevator // Project Assembly ${done ? "complete" : `phase ${p + 1}`}`),
    (() => {
      const bar = el("div", "fx-hub-elev-bar");
      const fill = el("i");
      fill.style.width = `${Math.min(100, (played / target) * 100)}%`;
      bar.append(fill);
      return bar;
    })(),
    el("div", "fx-hub-elev-count", `${played.toLocaleString()} / ${target.toLocaleString()} assets operational`),
    el(
      "div",
      "fx-hub-elev-note",
      done
        ? "All phases delivered. FICSIT has no further requests at this time."
        : `${pct}% of the library has seen a shift. ${(target - played).toLocaleString()} more to complete this phase. FICSIT is patient. FICSIT is also counting.`,
    ),
  );
}

function renderRail() {
  rail.replaceChildren(
    el("div", "fx-hub-rail-title", "HUB ▸ Milestones"),
    ...tiers.map((t, i) => {
      const b = el("button", "fx-hub-tier");
      b.type = "button";
      b.tabIndex = -1;
      b.dataset.tier = String(i);
      b.disabled = t.entries.length === 0;
      if (i === tier) b.setAttribute("aria-current", "true");
      b.append(el("span", "fx-hub-tier-n", `Tier ${t.n}`), el("span", "fx-hub-tier-name", t.name), el("span", "fx-hub-tier-count", t.entries.length.toLocaleString()));
      b.title = t.note;
      b.addEventListener("click", () => {
        setTier(i);
        console_.focus({ preventScroll: true });
      });
      return b;
    }),
  );
}

function plate(cls, title, rows) {
  const p = el("section", `fx-hub-plate ${cls}`);
  p.append(el("h3", "fx-hub-plate-title", title));
  const body = el("div", "fx-hub-plate-body");
  body.append(...rows);
  p.append(body);
  return p;
}

function costRow(label, value) {
  const r = el("div", "fx-hub-cost");
  r.append(el("span", "fx-hub-cost-k", label), el("b", "fx-hub-cost-v", value));
  return r;
}

function renderPanel() {
  const t = tiers[tier];
  const e = current();
  if (!t || !e) {
    panel.replaceChildren();
    return;
  }
  const i = at.get(tier) ?? 0;

  const head = el("div", "fx-hub-head");
  head.append(el("span", "fx-hub-head-tier", `Tier ${t.n} ▸ ${t.name}`), el("span", "fx-hub-head-note", t.note));

  const schematic = el("div", "fx-hub-schematic");
  schematic.dataset.id = e.id;
  const art = el("div", "fx-hub-schematic-art");
  art.style.backgroundImage = `url("${api.art.url(e.id, "hero", 1280)}")`;
  const logo = document.createElement("vellum-logo");
  logo.entry = e;
  const label = el("div", "fx-hub-schematic-label", "Milestone schematic");
  schematic.append(art, el("div", "fx-hub-schematic-grid"), logo, label);
  schematic.addEventListener("dblclick", () => submitNow());
  schematic.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    api.ui.contextMenu(e.id, ev.clientX, ev.clientY);
  });

  const sources = [...new Set(e.sources.map((s) => s.providerName))].join(", ") || "Unknown";
  const cost = plate("is-cost", "Cost", [
    costRow("Lifetime hours", hours(e)),
    costRow("Last shift", ago(e.lastPlayed || e.lastLaunched)),
    costRow("Supplier", sources),
    costRow("Manufacturer", e.metadata.developer || e.metadata.publisher || "Unlisted"),
    costRow("Footprint", bytes(e.sizeBytes)),
  ]);

  const unlockList = [...(e.metadata.genres ?? []), ...e.labels, ...e.tags];
  const unlocks = plate(
    "is-unlocks",
    "Unlocks",
    unlockList.length ? unlockList.slice(0, 8).map((u) => el("span", "fx-hub-unlock", u)) : [el("span", "fx-hub-unlock is-none", "No unlocks on file")],
  );

  const pager = el("div", "fx-hub-pager");
  const prev = el("button", "fx-hub-page", "◂ Prev");
  const next = el("button", "fx-hub-page", "Next ▸");
  for (const [b, d] of [
    [prev, -1],
    [next, 1],
  ]) {
    b.type = "button";
    b.tabIndex = -1;
    b.addEventListener("click", () => {
      step(d);
      console_.focus({ preventScroll: true });
    });
  }
  prev.disabled = i === 0;
  next.disabled = i >= t.entries.length - 1;
  pager.append(prev, el("span", "fx-hub-page-at", `${i + 1} / ${t.entries.length}`), next);

  // The Submit bay launches; the AWESOME Sink bay opens the Sink.
  const bays = el("div", "fx-hub-bays");
  const submit = el("div", "fx-hub-bay is-submit");
  submit.append(
    el("i", "fx-hub-submit-fill"),
    el("span", "fx-hub-bay-title", "Submit"),
    el("span", "fx-hub-bay-note", mode() === "off" ? "Enter or Space launches" : "Hold Enter or Space"),
  );
  submit.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    submit.setPointerCapture(ev.pointerId);
    console_.focus({ preventScroll: true });
    press();
  });
  for (const type of ["pointerup", "pointercancel"]) submit.addEventListener(type, () => release());
  submit.addEventListener("dblclick", () => submitNow());
  const sinkBay = el("div", "fx-hub-bay is-sink");
  sinkBay.append(el("span", "fx-hub-bay-title", "AWESOME Sink"), el("span", "fx-hub-bay-note", "Press S to feed"));
  sinkBay.addEventListener("click", () => {
    console_.focus({ preventScroll: true });
    feedSink();
  });
  bays.append(submit, sinkBay);

  const plates = el("div", "fx-hub-plates");
  plates.append(cost, unlocks);
  panel.replaceChildren(head, schematic, plates, pager, bays);
}

function render() {
  if (!root) return;
  if (sealing) {
    dirty = true;
    return;
  }
  const n = sort();
  root.hidden = n === 0;
  empty.hidden = n > 0;
  if (!n) return;
  // Stay on the selected game if there is one; else keep the Tier, or find one with games.
  const sel = api.state.get().selectedId;
  if (sel && tierOf.has(sel)) follow(sel, false);
  else if (!tiers[tier]?.entries.length) tier = Math.max(0, tiers.findIndex((t) => t.entries.length));
  renderElevator();
  renderRail();
  renderPanel();
}

// ---- moving ---------------------------------------------------------------------------------

function select() {
  const e = current();
  if (!e) return;
  lastSel = e.id;
  if (api.state.get().selectedId !== e.id) api.state.set({ selectedId: e.id });
}

function setTier(i) {
  if (!tiers[i]?.entries.length) return;
  tier = i;
  renderRail();
  renderPanel();
  select();
}

/** Move to the next Tier with games in direction d; false at the end. */
function stepTier(d) {
  for (let i = tier + d; i >= 0 && i < tiers.length; i += d) {
    if (tiers[i].entries.length) {
      setTier(i);
      return true;
    }
  }
  return false;
}

function step(d) {
  const t = tiers[tier];
  const i = (at.get(tier) ?? 0) + d;
  if (!t || i < 0 || i >= t.entries.length) return false;
  at.set(tier, i);
  renderPanel();
  select();
  return true;
}

/** Show the given game: its Tier, at its place. */
function follow(id, draw = true) {
  if (sealing) return;
  const i = tierOf.get(id);
  if (i == null) return;
  tier = i;
  at.set(i, tiers[i].entries.findIndex((e) => e.id === id));
  lastSel = id;
  if (draw) {
    renderRail();
    renderPanel();
  }
}

function nav(dir) {
  if (sink?.open) {
    sink.nav(dir);
    return true;
  }
  if (sealing || hold) return true;
  if (dir === "up") return stepTier(-1);
  if (dir === "down") return stepTier(1);
  if (dir === "left") return step(-1);
  if (dir === "right") return step(1);
  return false;
}

function onNav(e) {
  if (!root || !console_.contains(document.activeElement)) return;
  if (e.name === "back" && sink?.open) {
    e.preventDefault();
    sink.hide();
    return;
  }
  if (e.name === "pageUp" || e.name === "pageDown") {
    e.preventDefault();
    const i = at.get(tier) ?? 0;
    const to = Math.max(0, Math.min(tiers[tier].entries.length - 1, i + (e.name === "pageUp" ? -10 : 10)));
    step(to - i);
  }
}

function focusBox() {
  const r = (panel.querySelector(".fx-hub-schematic") ?? console_).getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

// ---- submitting -----------------------------------------------------------------------------

function mode() {
  const m = api.skin.options.ceremony ?? "full";
  return m === "full" && matchMedia("(prefers-reduced-motion: reduce)").matches ? "quick" : m;
}

function later(fn, ms) {
  timers.push(setTimeout(fn, ms));
}

/** A full hold, from the "Submit hold time" option (seconds). */
function holdMs() {
  const s = Number(api.skin.options.holdTime);
  return (Number.isFinite(s) && s > 0 ? Math.min(3, Math.max(0.3, s)) : 0.8) * 1000;
}

function stopBelt() {
  beltSound?.stop();
  beltSound = null;
}

function launch(e) {
  return api.actions.launch(e.id).catch(() => {});
}

function startHold(now) {
  if (!hold) hold = { down: false, until: 0, since: now, progress: 0, delivered: 0, last: now, raf: 0, held: false };
  else if (!hold.held) hold.since = now;
}

function feedSink() {
  if (sealing || hold) return;
  sink.feed();
}

/** Enter, Space or the Submit bay went down. */
function press() {
  if (sealing || sink.open || !current()) return;
  if (mode() === "off") return void launch(current());
  startHold(performance.now());
  hold.down = true;
  loop();
}

/** A controller confirm: held buttons repeat, so each one extends the hold a little. */
function pulse() {
  if (sink.open) return sink.confirm();
  if (sealing || !current()) return;
  if (mode() === "off") return void launch(current());
  const now = performance.now();
  startHold(now);
  hold.until = now + PAD_HOLD_MS;
  loop();
}

function release() {
  if (hold) hold.down = false;
}

/** A hold that barely started was a tap: say how it works. */
function hint() {
  const bay = panel.querySelector(".fx-hub-bay.is-submit");
  if (!bay) return;
  deny();
  bay.classList.remove("is-hint");
  void bay.offsetWidth; // restart the flash
  bay.classList.add("is-hint");
}

function loop() {
  if (!hold || hold.raf) return;
  hold.last = performance.now();
  hold.held = true;
  const frame = (now) => {
    if (!hold || sealing || !root) return;
    const dt = Math.min(now - hold.last, 100);
    hold.last = now;
    const held = hold.down || now < hold.until;
    if (hold.held && !held && now - hold.since < TAP_MS) hint();
    hold.held = held;
    const ms = holdMs();
    hold.progress = Math.max(0, Math.min(1, hold.progress + (held ? dt / ms : -dt / (ms * 0.6))));
    // The belt runs while held, once it's clearly a hold and not a tap.
    if (held && !beltSound && hold.progress > 0.06) beltSound = belt();
    if (!held) stopBelt();
    beltSound?.set(hold.progress);
    paintHold();
    if (hold.progress >= 1) {
      hold.raf = 0;
      seal();
      return;
    }
    if (!held && hold.progress <= 0) {
      hold = null;
      paintHold(0);
      return;
    }
    hold.raf = requestAnimationFrame(frame);
  };
  hold.raf = requestAnimationFrame(frame);
}

/** The fill bar, and the Cost lines delivered so far (each one clunks onto the belt). */
function paintHold(progress = hold?.progress ?? 0) {
  const fill = panel.querySelector(".fx-hub-submit-fill");
  if (fill) fill.style.width = `${progress * 100}%`;
  panel.querySelector(".fx-hub-bay.is-submit")?.classList.toggle("is-holding", progress > 0);
  const rows = [...panel.querySelectorAll(".fx-hub-cost")];
  const n = Math.min(rows.length, Math.floor(progress * rows.length + 1e-6));
  rows.forEach((r, i) => r.classList.toggle("is-delivered", i < n));
  if (hold) {
    for (let i = hold.delivered; i < n; i++) clunk(i);
    hold.delivered = n;
  }
}

/** Double-click: the whole ceremony at once, held or not. */
function submitNow() {
  if (sealing || sink.open || !current()) return;
  if (mode() === "off") return void launch(current());
  if (hold?.raf) cancelAnimationFrame(hold.raf);
  hold = null;
  seal();
}

/** Stamp the Milestone, close the doors (full ceremony) and launch. */
function seal() {
  const e = current();
  if (!e) return;
  sealing = true;
  stopBelt();
  hold = null;
  paintHold(1);
  const full = mode() === "full";
  const stamp = el("div", "fx-hub-stamp");
  stamp.append(el("b", null, tiers[tier].n === 0 ? "First shift" : "Milestone complete"), el("span", null, `FICSIT // ${new Date().toLocaleDateString()}`));
  panel.querySelector(".fx-hub-schematic")?.append(stamp);
  thud();
  chime();
  if (!full) {
    later(() => void launch(e), 450);
    later(reset, 1600);
    return;
  }
  console_.classList.add("is-shaking");
  later(() => console_?.classList.remove("is-shaking"), 400);
  later(() => {
    doorsEl.hidden = false;
    void doorsEl.offsetWidth; // shown open first, so the close animates
    doorsEl.classList.add("is-closed");
    doors(0.52);
    dispatchEvent(new CustomEvent("fx:dispatch", { detail: { title: e.title, line: APPROVALS[Math.floor(Math.random() * APPROVALS.length)] } }));
  }, 420);
  later(() => {
    void launch(e);
    awaitReturn();
  }, 1040);
}

/** The doors open when the player comes back: the window loses focus to the game and regains it. */
function awaitReturn() {
  let away = false;
  const onBlur = () => (away = true);
  const onBack = () => {
    if (away && document.visibilityState === "visible" && document.hasFocus()) reopen();
  };
  addEventListener("blur", onBlur);
  addEventListener("focus", onBack);
  document.addEventListener("visibilitychange", onBack);
  returnWatch = () => {
    removeEventListener("blur", onBlur);
    removeEventListener("focus", onBack);
    document.removeEventListener("visibilitychange", onBack);
  };
  // The game never took the window (slow to start, or it failed): open up again anyway.
  later(() => {
    if (!away) reopen();
  }, 6000);
}

function reopen() {
  returnWatch?.();
  returnWatch = null;
  if (!doorsEl) return;
  doorsEl.classList.remove("is-closed");
  unlatch(0.5);
  dispatchEvent(new CustomEvent("fx:return"));
  later(() => {
    if (doorsEl) doorsEl.hidden = true;
    reset();
  }, 560);
}

function reset() {
  timers.forEach(clearTimeout);
  timers = [];
  sealing = false;
  stopBelt();
  hold = null;
  if (!root) return;
  if (dirty) {
    dirty = false;
    render();
  } else {
    panel.querySelector(".fx-hub-stamp")?.remove();
    paintHold(0);
  }
}

function onKey(e) {
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.key === "s" || e.key === "S") {
    e.preventDefault();
    if (e.type === "keydown" && !e.repeat) feedSink();
    return;
  }
  if (e.key !== "Enter" && e.key !== " ") return;
  e.preventDefault(); // keeps the SDK's Enter from launching at once
  if (e.type === "keyup") release();
  else if (e.repeat) return;
  else if (sink.open) sink.confirm();
  else press();
}

// ---- view -----------------------------------------------------------------------------------

export default {
  mount(el_, vellum) {
    api = vellum;
    root = el("div", "fx-hub");
    elevator = el("header", "fx-hub-elev");
    console_ = el("div", "fx-hub-console");
    console_.tabIndex = 0;
    console_.setAttribute("data-vellum-focus", "");
    console_.setAttribute("data-vellum-focus-default", "");
    console_.setAttribute("aria-label", "HUB milestones");
    console_.vellumNav = nav;
    console_.vellumFocusBox = focusBox;
    console_.vellumEnter = () => select();
    console_.vellumConfirm = () => pulse(); // controller A and the harness; keys go through onKey
    console_.addEventListener("keydown", onKey);
    console_.addEventListener("keyup", onKey);
    console_.addEventListener("blur", release);
    rail = el("nav", "fx-hub-rail");
    rail.setAttribute("aria-label", "Tiers");
    panel = el("div", "fx-hub-panel");
    doorsEl = el("div", "fx-hub-doors");
    doorsEl.hidden = true;
    doorsEl.append(el("div", "fx-hub-door is-left"), el("div", "fx-hub-door is-right"), el("div", "fx-hub-doors-sign", "Pioneer dispatched"));
    sink = createSink(vellum, {
      pool: () => vellum.library.query(),
      tierOf: (e) => TIERS[tierFor(e)].n,
      tierName: (n) => TIERS[n].name,
      ago,
      accept: (id) => {
        follow(id);
        select();
        console_?.focus({ preventScroll: true });
      },
    });
    console_.append(rail, panel, sink.slip, doorsEl);
    root.append(elevator, console_);
    empty = document.createElement("vellum-empty");
    el_.append(root, empty);

    const s = vellum.state.get();
    key = JSON.stringify([s.query, s.filters, s.sort]);
    render();
    unsubs = [vellum.library.on("change", render), vellum.input.on("nav", onNav), vellum.skin.on("options", render)];
  },

  onState(s) {
    if (!root) return;
    const k = JSON.stringify([s.query, s.filters, s.sort]);
    if (k !== key) {
      key = k;
      render();
      return;
    }
    // Selected elsewhere (search, another view, the harness): show it.
    if (s.selectedId && s.selectedId !== lastSel && tierOf.has(s.selectedId)) follow(s.selectedId);
  },

  unmount() {
    unsubs.forEach((u) => u());
    unsubs = [];
    if (hold?.raf) cancelAnimationFrame(hold.raf);
    returnWatch?.();
    returnWatch = null;
    if (sealing) dispatchEvent(new CustomEvent("fx:return"));
    sink?.destroy();
    sink = null;
    root = rail = console_ = elevator = panel = empty = doorsEl = null;
    reset();
  },
};
