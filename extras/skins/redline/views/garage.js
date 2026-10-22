// Grand Tour's Garage view: a showroom. The selected game's case (built for it by the case
// builder, ../case-builder) stands on a turntable under studio lights, a spec card gives its model year, manufacturer (developer), body type (genre) and
// condition, and a model-select strip runs along the bottom, one body type at a time (or the
// current grouping).
//
// The strip is a focus container: Left/Right choose the model, Up/Down change body type, Enter
// starts the game and S services it. On the case: click opens it; right click holds its front,
// then its back, then lets it turn again. The card's buttons sit outside it, so the focus manager reaches them
// normally.
import { caseFor, dropQueued, loadCases, requestWrap, surfaceMaps } from "../case-builder/compose.js";
import { CaseStage, quickWrap } from "../case-builder/renderer.js";
import { condition, describe, failChance, grade, lastWear, serviced } from "../condition.js";
import { modalOpen } from "../modal.js";
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

function renderStrip() {
  const m = makers[maker];
  if (!m) {
    strip.replaceChildren(el("p", "rl-gar-empty", "No models match your search."));
    return;
  }
  strip.replaceChildren(
    ...m.entries.map((e, i) => {
      const t = el("div", "rl-gar-thumb");
      t.dataset.i = String(i);
      t.setAttribute("role", "option");
      t.setAttribute("aria-label", e.title);
      if (i === sel) t.classList.add("is-selected");
      const img = el("img");
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      img.draggable = false;
      img.src = art(e, "cover", 160);
      const grime = el("span", "rl-grime");
      grime.style.setProperty("--wear", String(1 - condition(e.id)));
      t.append(img, grime, el("span", "rl-gar-thumb-no", pad(i + 1)));
      t.addEventListener("click", () => select(i));
      t.addEventListener("dblclick", () => api.actions.launch(e.id).catch(() => {}));
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

/** Puts `e`'s case on the turntable: at once with its cover, then with its composed wrap. */
function showCase(e) {
  if (!cases3d || !cases) {
    if (stageFailed) showFlat(e);
    return;
  }
  const wear = 1 - condition(e.id);
  const ids = [e.id];
  if (!cases3d.has(e.id)) {
    // Until the wrap is ready: the plain cover on the front, the shell color elsewhere.
    const c = caseFor(e, cases, api.skin.options);
    cases3d.preload({ id: e.id, case: c, wrap: quickWrap(c, null), wear, quick: true });
    const img = new Image();
    img.onload = () => {
      if (cases3d?.models.get(e.id)?.quick) cases3d.preload({ id: e.id, case: c, wrap: quickWrap(c, img), wear, quick: true });
    };
    img.src = art(e, "cover", 320);
  }
  cases3d.show(e.id);
  cases3d.setWear(e.id, wear);
  load(e, 0);
  // Its neighbours, so left and right are instant.
  const list = makers[maker]?.entries ?? [];
  for (const n of [list[sel - 1], list[sel + 1]]) {
    if (!n) continue;
    ids.push(n.id);
    load(n, 1);
  }
  cases3d.keep(ids);
  dropQueued(ids);
}

/** Composes (or fetches from the cache) a case's full wrap and hands it to the stage. */
async function load(e, priority) {
  let rec;
  try {
    rec = await requestWrap(e, "full", caseCtx(), priority);
  } catch {
    return; // dropped (the focus moved on) or failed: the quick wrap stays
  }
  const stageNow = cases3d;
  if (!stageNow) return;
  const list = makers[maker]?.entries ?? [];
  const wanted = [list[sel - 1], current(), list[sel + 1]].some((x) => x?.id === e.id);
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
  cases3d.keep([]);
  modelFor = "";
  renderModel(true);
}

/** An overlay (ignition, service) covers the turntable: stop drawing until it closes. */
function onModal() {
  cases3d?.pause(modalOpen());
}

function startStage(floor) {
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
  loadCases()
    .then((c) => {
      cases = c;
      if (cases3d === mine) renderModel(true);
    })
    .catch((err) => console.warn("Grand Tour: cases.json", err));
  surfaceMaps()
    .then((maps) => cases3d === mine && mine.setSurfaceMaps(maps))
    .catch((err) => console.warn("Grand Tour: surface maps", err));
}

function renderModel(force = false) {
  const e = current();
  if (!force && (e?.id ?? "") === modelFor) return;
  modelFor = e?.id ?? "";
  if (!e) {
    cases3d?.clear();
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
    const lights = el("div", "rl-gar-lights");
    const tips = el("p", "rl-gar-tips", "Click to open · Right-click: front, back, turn");
    floor.append(lights, tips);
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
    // S services the selected model. Handled here so the key doesn't start a search.
    strip.addEventListener("keydown", (ev) => {
      if ((ev.key === "s" || ev.key === "S") && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
        ev.preventDefault();
        ev.stopPropagation();
        void serviceCurrent();
      }
    });
    dock.append(makersEl, strip);

    root.append(stage, dock);
    host.append(root);
    startStage(floor);

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
    cases3d?.dispose();
    cases3d = null;
    stageFailed = false;
    root = stage = card = makersEl = strip = null;
    modelFor = "";
  },
};
