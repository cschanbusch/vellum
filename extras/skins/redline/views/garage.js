// Grand Tour's Garage view: a showroom. The selected game's case (built for it by the case
// builder, ../case-builder) stands on a turntable under studio lights, a spec card gives its model year, manufacturer (developer), body type (genre) and
// condition, and a model-select strip runs along the bottom, one body type at a time (or the
// current grouping).
//
// The strip is a focus container: Left/Right choose the model, Up/Down change body type, Enter
// starts the game, S services it and T test-drives it (the ignition without launching; Shift+T
// with the start's wear). On the case: click opens it; right click holds its front,
// then its back, then lets it turn again. The card's buttons sit outside it, so the focus manager reaches them
// normally.
import { TIERS, caseFor, dropQueued, loadCases, requestWrap, surfaceMaps } from "../case-builder/compose.js";
import { CaseStage, quickWrap } from "../case-builder/renderer.js";
import { condition, describe, failChance, grade, lastWear, serviced } from "../condition.js";
import { modalOpen } from "../modal.js";
import { testIgnition } from "../ignition.js";
import { openService } from "../service.js";

let api = null;
let root = null;
let stage = null;
let card = null;
let makersEl = null;
let strip = null;
let unsubs = [];

let cases = null; // cases.json, once loaded
let cases3d = null; // the WebGL case stage
let stageFailed = false;

let makers = []; // { label, entries }
const thumbs = new Map(); // game id -> its thumbnail in the model strip, reused across redraws
let maker = 0;
let sel = 0;
let key = "";

// ---- helpers --------------------------------------------------------------------------------

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const pad = (n) => String(n).padStart(2, "0");
const year = (e) => Number(e.metadata.releaseDate?.slice(0, 4)) || null;
const stores = (e) => [...new Set(e.sources.map((s) => s.providerName))];

function size(bytes) {
  if (!bytes) return ["—", ""];
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return [gb >= 100 ? Math.round(gb).toString() : gb.toFixed(1), "GB"];
  return [Math.max(1, Math.round(bytes / 1024 ** 2)).toString(), "MB"];
}

/** Genres that describe how a game was made or sold rather than what it is. */
const BROAD = new Set(["Indie", "Casual", "Massively Multiplayer"]);

/** The body type: the first specific genre, else the first genre at all. */
function bodyType(e) {
  const g = e.metadata.genres ?? [];
  return g.find((x) => !BROAD.has(x)) ?? g[0] ?? null;
}

function shortDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** What the last wear cost: a start, or hours of play since the odometer was last read. */
function wearNote(id) {
  const w = lastWear(id);
  if (!w) return null;
  const pct = Math.max(1, Math.round(w.w * 100));
  if (w.kind !== "play") return `Last start took ${pct}% off`;
  const h = w.minutes / 60;
  return `${h >= 10 ? Math.round(h) : h.toFixed(1)} h on the road since the last check: ${pct}% off`;
}

const art = (e, kind, width) => api.art.url(e.id, kind, width, null);

// ---- makers ---------------------------------------------------------------------------------

function buildMakers(entries) {
  if (api.state.get().groupBy) {
    return api.library.groups().filter((g) => g.entries.length).map((g) => ({ label: g.label, entries: g.entries }));
  }
  // By body type when the stores say; otherwise by store.
  const typed = entries.filter(bodyType).length;
  const keyOf = typed >= entries.length / 2 ? (e) => bodyType(e) ?? "Unclassified" : (e) => stores(e)[0] ?? "Other";
  const by = new Map();
  for (const e of entries) {
    const k = keyOf(e);
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(e);
  }
  return [...by.entries()]
    .sort(([a], [b]) => (a === "Unclassified") - (b === "Unclassified") || a.localeCompare(b))
    .map(([label, list]) => ({ label, entries: list }));
}

function rebuild() {
  if (!root) return;
  const entries = api.library.query();
  makers = buildMakers(entries);
  const ids = new Set(entries.map((e) => e.id));
  for (const id of thumbs.keys()) if (!ids.has(id)) thumbs.delete(id);
  if (!locate(api.state.get().selectedId)) {
    maker = Math.min(maker, Math.max(0, makers.length - 1));
    sel = 0;
  }
  renderMakers();
  renderStrip();
  renderModel(true);
}

function locate(id) {
  if (!id) return false;
  for (let m = 0; m < makers.length; m++) {
    const i = makers[m].entries.findIndex((e) => e.id === id);
    if (i >= 0) {
      maker = m;
      sel = i;
      return true;
    }
  }
  return false;
}

const current = () => makers[maker]?.entries[sel] ?? null;

// ---- rendering ------------------------------------------------------------------------------

function renderMakers() {
  makersEl.replaceChildren(
    ...makers.map((m, i) => {
      const b = el("button", "rl-gar-maker");
      b.append(el("span", "rl-gar-maker-no", pad(i + 1)), el("span", null, m.label));
      if (i === maker) b.setAttribute("aria-current", "true");
      b.addEventListener("click", () => goMaker(i, 0));
      return b;
    }),
  );
  makersEl.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest", inline: "center" });
}

/** The model strip. Thumbnails are kept by game across redraws (a library update, a new body
 *  type and back), so their art doesn't reload and flash. */
function renderStrip() {
  const m = makers[maker];
  if (!m) {
    strip.replaceChildren(el("p", "rl-gar-empty", "No models match your search."));
    return;
  }
  strip.replaceChildren(
    ...m.entries.map((e, i) => {
      let t = thumbs.get(e.id);
      if (!t) {
        t = el("div", "rl-gar-thumb");
        t.setAttribute("role", "option");
        const img = el("img");
        img.alt = "";
        img.loading = "lazy";
        img.decoding = "async";
        img.draggable = false;
        t.append(img, el("span", "rl-grime"), el("span", "rl-gar-thumb-no"));
        t.addEventListener("click", () => select(Number(t.dataset.i)));
        t.addEventListener("dblclick", () => api.actions.launch(e.id).catch(() => {}));
        thumbs.set(e.id, t);
      }
      const src = art(e, "cover", 160);
      const img = t.querySelector("img");
      if (img.getAttribute("src") !== src) img.src = src; // only when the art itself changed
      t.dataset.i = String(i);
      t.setAttribute("aria-label", e.title);
      t.classList.toggle("is-selected", i === sel);
      t.querySelector(".rl-grime").style.setProperty("--wear", String(1 - condition(e.id)));
      t.querySelector(".rl-gar-thumb-no").textContent = pad(i + 1);
      return t;
    }),
  );
  reveal(false);
}

function reveal(smooth = true) {
  const t = strip.querySelector(`.rl-gar-thumb[data-i="${sel}"]`);
  if (!t) return;
  const left = t.offsetLeft - (strip.clientWidth - t.offsetWidth) / 2;
  strip.scrollTo({ left, behavior: smooth && !document.documentElement.hasAttribute("data-rl-still") ? "smooth" : "auto" });
}

let modelFor = "";

// ---- the case -------------------------------------------------------------------------------

const caseCtx = () => ({ cases, options: api.skin.options, providers: api.providers.list() });

/** Gives the stage `e`'s case at once (its plain cover) if it has none yet; the composed wrap
 *  replaces it when ready. */
function ensureModel(e) {
  if (cases3d.has(e.id)) return;
  const c = caseFor(e, cases, api.skin.options);
  const wear = 1 - condition(e.id);
  cases3d.preload({ id: e.id, case: c, wrap: quickWrap(c, null), wear, quick: true });
  const img = new Image();
  img.onload = () => {
    if (cases3d?.models.get(e.id)?.quick) cases3d.preload({ id: e.id, case: c, wrap: quickWrap(c, img), wear, quick: true });
  };
  img.src = art(e, "cover", 320);
}

let shownCenter = null; // the game on the centre turntable

/**
 * Puts `e`'s case on the centre turntable and its neighbours on either side. When the old centre
 * game is now a neighbour, that was a step: the cases (and the backdrop) slide; otherwise they
 * crossfade.
 */
function showCase(e) {
  if (!cases3d || !cases) {
    if (stageFailed) showFlat(e);
    return;
  }
  const list = makers[maker]?.entries ?? [];
  const prev = list[sel - 1] ?? null;
  const next = list[sel + 1] ?? null;
  const dir = shownCenter && prev?.id === shownCenter ? 1 : shownCenter && next?.id === shownCenter ? -1 : 0;
  shownCenter = e.id;
  const trio = [prev, e, next].filter(Boolean);
  for (const x of trio) ensureModel(x);
  cases3d.setSlots([prev?.id, e.id, next?.id], dir);
  cases3d.setWear(e.id, 1 - condition(e.id));
  showBackdrop(e, dir);
  load(e, 0);
  for (const n of [prev, next]) if (n) load(n, 1);
  const ids = trio.map((x) => x.id);
  cases3d.keep(ids);
  dropQueued(ids);
}

// ---- ready: tells the flash between views (skin.js) when the Garage is worth showing ----------

let readyAt = 0;

/** Announces "rl-view-ready" once the centre case is up with its finished print, or after a
 *  short wait for a slow print (its plain cover stands in), or at once without WebGL. */
function announceReady() {
  const t0 = performance.now();
  readyAt = t0;
  const check = () => {
    if (readyAt !== t0) return; // unmounted, or mounted again
    const c = cases3d?.center;
    const waited = performance.now() - t0;
    const up = stageFailed || !current() || (c?.real && (!c.model.quick || waited > 900)) || waited > 1500;
    if (up) dispatchEvent(new CustomEvent("rl-view-ready", { detail: { view: "garage" } }));
    else requestAnimationFrame(check);
  };
  requestAnimationFrame(check);
}

// ---- the backdrop: the focused game's hero art behind the turntables -------------------------

const SLIDE = { duration: 450, easing: "cubic-bezier(0.33, 1, 0.68, 1)" };

/** Shows `e`'s hero behind the turntables, sliding in from the side the cases come from. The same
 *  art already showing is left alone. */
function showBackdrop(e, dir) {
  const host = stage?.querySelector(".rl-gar-backdrop");
  if (!host) return;
  const hero = e.artStatus?.hero !== "placeholder";
  const url = art(e, hero ? "hero" : "cover", hero ? 1920 : 640);
  if (host.lastElementChild?.dataset.url === url) return;
  const layer = el("div", `rl-gar-hero${hero ? "" : " is-cover"}`);
  layer.dataset.url = url;
  layer.style.backgroundImage = `url("${url}")`;
  const old = [...host.children];
  host.append(layer);
  const still = document.documentElement.hasAttribute("data-rl-still");
  if (dir && !still) {
    layer.animate([{ transform: `translateX(${dir * 100}%)` }, { transform: "none" }], SLIDE);
    for (const o of old) o.animate([{ transform: "none" }, { transform: `translateX(${-dir * 100}%)` }], { ...SLIDE, fill: "forwards" }).finished.then(() => o.remove(), () => o.remove());
  } else {
    layer.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200 });
    for (const o of old) setTimeout(() => o.remove(), 200);
  }
}

/** The wrap tier for the Garage: medium, or full when the focused case's front panel would
 *  otherwise get fewer than about 1.3 texels per screen pixel. It fills about half the stage's
 *  height and a panel is about 0.75 as wide as tall; full size (1200 px) only pays on large, dense
 *  screens, and costs four times the upload. (Small is for thumbnails: no disc or emboss.) */
function wrapTier() {
  const h = (cases3d?.canvas.clientHeight || innerHeight) * devicePixelRatio;
  return 0.5 * h * 0.75 * 1.3 > TIERS.medium ? "full" : "medium";
}

/** Composes (or fetches from the cache) a case's full wrap and hands it to the stage, if the
 *  Garage still wants it (`anyway`: always, for prewarm()). */
async function load(e, priority, anyway = false) {
  let rec;
  try {
    rec = await requestWrap(e, wrapTier(), caseCtx(), priority);
  } catch {
    return; // dropped (the focus moved on) or failed: the quick wrap stays
  }
  const stageNow = cases3d;
  if (!stageNow) return;
  const list = makers[maker]?.entries ?? [];
  const wanted = anyway || [list[sel - 1], current(), list[sel + 1]].some((x) => x?.id === e.id);
  if (!wanted) return;
  const have = stageNow.models.get(e.id);
  if (have?.key === rec.key) return;
  const opts = { premultiplyAlpha: "none", colorSpaceConversion: "none" };
  const [wrap, disc, emboss] = await Promise.all([
    createImageBitmap(rec.wrap, opts),
    rec.disc ? createImageBitmap(rec.disc, opts) : null,
    rec.emboss ? createImageBitmap(rec.emboss, opts) : null,
  ]);
  if (cases3d !== stageNow) return;
  stageNow.preload({ id: e.id, key: rec.key, case: rec.case, wrap, disc, emboss, wear: 1 - condition(e.id) });
  stage?.querySelector(".rl-gar-floor")?.setAttribute("data-case", current()?.id === e.id ? "ready" : "loading");
}

/** Without WebGL: the cover, standing flat on the floor. */
function showFlat(e) {
  const floor = stage.querySelector(".rl-gar-floor");
  let img = floor.querySelector(".rl-gar-flat");
  if (!img) {
    img = el("img", "rl-gar-flat");
    img.alt = "";
    floor.append(img);
  }
  img.src = art(e, "cover", 640);
}

/** Every case is rebuilt when an option that shapes them changes (forms, rich backs). */
function onOptions() {
  if (!cases3d) return;
  cases3d.pose();
  cases3d.clear();
  shownCenter = null;
  modelFor = "";
  renderModel(true);
}

/** An overlay (ignition, service) covers the turntable: stop drawing until it closes. */
function onModal() {
  cases3d?.pause(modalOpen());
}

function startStage(floor) {
  // The stage outlives the view (and may have been built ahead by prewarm()): the Garage reuses
  // it, cases and all.
  if (cases3d) {
    cases3d.attach(floor); // the view's rebuild() then puts its trio on the turntables
    return;
  }
  createStage(floor);
}

/** Builds the stage, in `floor` or (null) off-page, and loads the catalogue and surface maps. */
function createStage(floor) {
  try {
    cases3d = new CaseStage(floor, {
      still: () => document.documentElement.hasAttribute("data-rl-still"),
      reflect: () => api.skin.options.reflections !== false,
    });
  } catch (err) {
    console.warn("Grand Tour: WebGL unavailable, showing flat covers", err);
    stageFailed = true;
    return;
  }
  const mine = cases3d;
  window.__rlCaseStage = cases3d; // for tests and the case gallery
  const ready = Promise.all([
    loadCases().then((c) => {
      cases = c;
      if (cases3d === mine && root) renderModel(true);
    }),
    surfaceMaps().then((maps) => cases3d === mine && mine.setSurfaceMaps(maps)),
  ]).catch((err) => console.warn("Grand Tour: case setup", err));
  // Then every kind of case's shaders, in the background (see CaseStage.warmCases).
  void ready.then(() => cases3d === mine && cases && mine.warmCases(cases.profiles)).catch((err) => console.warn("Grand Tour: shader warm-up", err));
  return ready;
}

/**
 * Builds the Garage's stage before the Garage is first shown: off-page, with the selected game
 * and its neighbours on the turntables and their shaders compiled, so switching to the Garage is
 * instant. Grand Tour calls this when idle (skin.js).
 */
export async function prewarm(vellum) {
  if (cases3d || stageFailed || root) return;
  api = vellum;
  await createStage(null);
  if (!cases3d || root || !cases) return;
  const list = api.library.query();
  const i = Math.max(0, list.findIndex((e) => e.id === api.state.get().selectedId));
  const trio = [list[i - 1], list[i], list[i + 1]];
  if (!trio[1]) return;
  for (const e of trio) if (e) ensureModel(e);
  cases3d.setSlots(trio.map((e) => e?.id ?? null), 0);
  cases3d.flushFade();
  // Their finished prints too (composed now, or from the cache), then the shaders.
  await Promise.all(trio.map((e, k) => e && load(e, k === 1 ? 0 : 1, true)));
  await cases3d.warm();
}

function renderModel(force = false) {
  const e = current();
  if (!force && (e?.id ?? "") === modelFor) return;
  modelFor = e?.id ?? "";
  if (!e) {
    cases3d?.clear();
    shownCenter = null;
    stage.querySelector(".rl-gar-backdrop")?.replaceChildren();
    card.replaceChildren(el("p", "rl-gar-empty", "The showroom is empty."));
    return;
  }

  const c = condition(e.id);
  showCase(e);

  const m = makers[maker];
  stage.querySelector(".rl-gar-banner-maker").textContent = m.label;
  stage.querySelector(".rl-gar-banner-count").textContent = `${pad(sel + 1)} / ${pad(m.entries.length)}`;

  // The spec card.
  const g = grade(c);
  const head = el("header", "rl-gar-head");
  const names = el("div", "rl-gar-names");
  const make = el("p", "rl-gar-make", e.metadata.developer ?? stores(e).join(" / "));
  make.title = "Manufacturer";
  names.append(make, el("h2", "rl-gar-name", e.title));
  const badge = el("div", `rl-gar-class is-${g.toLowerCase()}`);
  badge.append(el("span", "rl-gar-class-label", "Class"), el("span", "rl-gar-class-value", g));
  head.append(names, badge);

  const [sv, su] = size(e.sizeBytes);
  const y = year(e);
  const figures = el("div", "rl-gar-figures");
  const figure = (label, value, unit) => {
    const f = el("div", "rl-gar-figure");
    const v = el("span", "rl-gar-figure-value", value);
    if (unit) v.append(el("small", null, unit));
    f.append(el("span", "rl-gar-figure-label", label), v);
    return f;
  };
  const body = bodyType(e);
  const bodyFig = figure("Body type", body ?? "—");
  bodyFig.classList.add("is-text");
  // Mileage: hours on the clock, as the store counts them.
  const hours = e.playtimeMinutes ? e.playtimeMinutes / 60 : null;
  const mileage = hours == null ? figure("Mileage", "—") : figure("Mileage", hours >= 10 ? Math.round(hours).toLocaleString() : hours.toFixed(1), "h");
  figures.append(figure("Model year", y ? String(y) : "—"), bodyFig, figure("Displacement", sv, su), mileage);

  // Condition: a segmented gauge, its state, and a warning when it may not start.
  const cond = el("section", "rl-gar-cond");
  cond.dataset.level = c >= 0.7 ? "good" : c >= 0.4 ? "fair" : "poor";
  const condHead = el("div", "rl-gar-cond-head");
  const pct = el("span", "rl-gar-cond-pct", String(Math.round(c * 100)));
  pct.append(el("small", null, "%"));
  condHead.append(el("span", "rl-gar-cond-label", "Condition"), el("span", "rl-gar-cond-state", describe(c)), pct);
  const gauge = el("div", "rl-gar-gauge");
  for (let i = 0; i < 20; i++) {
    const seg = el("span");
    if (i < Math.round(c * 20)) seg.className = "is-on";
    gauge.append(seg);
  }
  const svc = serviced(e.id);
  const risk = failChance(c);
  const note = el(
    "p",
    `rl-gar-cond-note${risk ? " is-warn" : ""}`,
    risk ? `May not start (${Math.round(risk * 100)}% chance). Service recommended.` : wearNote(e.id) ?? (svc ? `Last serviced ${shortDate(svc)}` : "Factory fresh until you start it"),
  );
  cond.append(condHead, gauge, note);

  const dealers = el("p", "rl-gar-dealers");
  dealers.append(el("span", null, "Available from"), ...stores(e).map((s) => el("b", null, s)));

  const actions = el("div", "rl-gar-actions");
  const play = document.createElement("vellum-play-button");
  play.entry = e;
  const fav = el("button", "v-button rl-gar-fav", e.favorite ? "★ In your garage" : "☆ Add to garage");
  fav.setAttribute("data-vellum-focus", "");
  fav.setAttribute("aria-pressed", String(e.favorite));
  fav.addEventListener("click", () => api.actions.toggleFavorite(e.id));
  const service = el("button", "v-button rl-gar-service", "Service");
  service.setAttribute("data-vellum-focus", "");
  service.disabled = c >= 1;
  service.addEventListener("click", () => void serviceCurrent());
  actions.append(play, service, fav);

  const notes = e.metadata.description ? el("p", "rl-gar-notes", e.metadata.description) : null;
  card.replaceChildren(...[head, figures, cond, notes, dealers, actions].filter(Boolean));
  card.classList.remove("is-arriving");
  void card.offsetWidth;
  card.classList.add("is-arriving");
}

async function serviceCurrent() {
  const e = current();
  if (!e || condition(e.id) >= 1) return;
  await openService(e);
  strip?.focus({ preventScroll: true });
}

/** Condition changed (a start, a service): redraw the card and the grime. */
function onCondition() {
  if (!root) return;
  renderModel(true);
  const m = makers[maker];
  for (const t of strip.querySelectorAll(".rl-gar-thumb")) {
    const e = m?.entries[Number(t.dataset.i)];
    if (e) t.querySelector(".rl-grime")?.style.setProperty("--wear", String(1 - condition(e.id)));
  }
}

// ---- selection ------------------------------------------------------------------------------

function markSelection() {
  for (const t of strip.querySelectorAll(".rl-gar-thumb")) t.classList.toggle("is-selected", Number(t.dataset.i) === sel);
}

function select(i) {
  const m = makers[maker];
  if (!m || i < 0 || i >= m.entries.length) return;
  sel = i;
  markSelection();
  reveal();
  renderModel();
  void api.state.set({ selectedId: m.entries[i].id });
}

function goMaker(m, i) {
  if (m < 0 || m >= makers.length) return false;
  maker = m;
  sel = Math.max(0, Math.min(i, makers[m].entries.length - 1));
  renderMakers();
  renderStrip();
  select(sel);
  return true;
}

function nav(dir) {
  const m = makers[maker];
  if (!m) return false;
  switch (dir) {
    case "left":
      return sel > 0 ? (select(sel - 1), true) : false;
    case "right":
      return sel < m.entries.length - 1 ? (select(sel + 1), true) : false;
    case "up":
      return goMaker(maker - 1, 0);
    case "down":
      return goMaker(maker + 1, 0);
    case "pageUp":
      select(Math.max(0, sel - 10));
      return true;
    case "pageDown":
      select(Math.min(m.entries.length - 1, sel + 10));
      return true;
  }
  return false;
}

function thumbBox(i) {
  const t = strip.querySelector(`.rl-gar-thumb[data-i="${i}"]`);
  if (!t) return null;
  const r = t.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

function enter(from) {
  const m = makers[maker];
  if (!m) return;
  if (!from) return select(sel);
  // Nearest visible thumbnail to where focus came from.
  const cx = (from.left + from.right) / 2;
  const sr = strip.getBoundingClientRect();
  let best = sel;
  let bestD = Infinity;
  for (const t of strip.querySelectorAll(".rl-gar-thumb")) {
    const r = t.getBoundingClientRect();
    if (r.right < sr.left || r.left > sr.right) continue;
    const d = Math.abs((r.left + r.right) / 2 - cx);
    if (d < bestD) [bestD, best] = [d, Number(t.dataset.i)];
  }
  select(best);
}

// ---- view -----------------------------------------------------------------------------------

export default {
  mount(host, vellum) {
    api = vellum;
    root = el("div", "rl-garage");

    stage = el("section", "rl-gar-stage");
    const floor = el("div", "rl-gar-floor");
    const banner = el("div", "rl-gar-banner");
    banner.append(el("span", "rl-gar-banner-label", "Showroom"), el("span", "rl-gar-banner-maker"), el("span", "rl-gar-banner-count"));
    const backdrop = el("div", "rl-gar-backdrop");
    const lights = el("div", "rl-gar-lights");
    const tips = el("div", "rl-gar-tips");
    tips.append(
      el("p", "rl-gar-tip", "Click to open · Right-click: front, back, turn"),
      el("p", "rl-gar-tip is-test", "T - Test Ignition"),
      el("p", "rl-gar-tip is-test", "Shift+T - Test with wear"),
    );
    floor.append(backdrop, lights, tips);
    // Clicking the case (open it, or right-click for its faces) would leave keyboard focus on the
    // page, and the next arrow would only bring it back to the strip instead of stepping.
    const refocus = () => strip?.focus({ preventScroll: true });
    floor.addEventListener("pointerup", refocus);
    floor.addEventListener("contextmenu", refocus);
    card = el("aside", "rl-gar-card");
    stage.append(banner, floor, card);

    const dock = el("section", "rl-gar-dock");
    makersEl = el("nav", "rl-gar-makers");
    makersEl.setAttribute("aria-label", "Body types");
    strip = el("div", "rl-gar-strip");
    strip.tabIndex = 0;
    strip.setAttribute("role", "listbox");
    strip.setAttribute("aria-label", "Models");
    strip.setAttribute("data-vellum-focus", "");
    strip.setAttribute("data-vellum-focus-default", "");
    strip.vellumNav = nav;
    strip.vellumFocusBox = () => thumbBox(sel);
    strip.vellumEnter = (from) => enter(from);
    strip.vellumConfirm = () => {
      const e = current();
      if (e) api.actions.launch(e.id).catch(() => {});
    };
    // S services the selected model and T test-drives it (the ignition, without launching).
    // Handled here, on the strip, so they only act while it has focus.
    strip.addEventListener("keydown", (ev) => {
      if (ev.ctrlKey || ev.altKey || ev.metaKey) return;
      const k = ev.key.toLowerCase();
      if (k !== "s" && k !== "t") return;
      ev.preventDefault();
      ev.stopPropagation();
      if (k === "s") void serviceCurrent();
      else void testIgnition(current(), { wear: ev.shiftKey });
    });
    dock.append(makersEl, strip);

    root.append(stage, dock);
    host.append(root);
    // Grand Tour's flash between views holds until the Garage has its cases up (skin.js).
    dispatchEvent(new CustomEvent("rl-view-busy", { detail: { view: "garage" } }));
    startStage(floor);
    announceReady();

    const s = vellum.state.get();
    key = JSON.stringify([s.query, s.filters, s.sort, s.groupBy]);
    rebuild();
    addEventListener("rl-condition", onCondition);
    addEventListener("rl-modal", onModal);
    unsubs = [
      vellum.library.on("change", rebuild),
      vellum.skin.on("options", onOptions),
      vellum.providers.on("change", onOptions),
      () => removeEventListener("rl-condition", onCondition),
      () => removeEventListener("rl-modal", onModal),
    ];
  },

  onState(s) {
    if (!root) return;
    const k = JSON.stringify([s.query, s.filters, s.sort, s.groupBy]);
    if (k !== key) {
      key = k;
      rebuild();
      return;
    }
    if (s.selectedId && s.selectedId !== current()?.id) {
      const before = maker;
      if (locate(s.selectedId)) {
        if (before !== maker) {
          renderMakers();
          renderStrip();
        } else {
          markSelection();
          reveal();
        }
        renderModel();
      }
    }
  },

  unmount() {
    unsubs.forEach((u) => u());
    unsubs = [];
    // Kept for next time (see startStage); a jump back in crossfades from what it showed.
    cases3d?.detach();
    shownCenter = null;
    readyAt = 0;
    stageFailed = false;
    root = stage = card = makersEl = strip = null;
    modelFor = "";
  },
};
