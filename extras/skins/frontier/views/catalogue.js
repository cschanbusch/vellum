// Frontier's Catalogue view: the library as a frontier mail-order catalogue, after the shop
// catalogues in Red Dead Redemption 2. Fan-made; no game assets.
//
// A bound book, read a spread (two facing pages) at a time. Front matter: the inside cover, the
// title page, the house guarantee and "How to Order". Then the Contents, which lists every
// article with its page number, over as many spreads as it needs. Each department opens with a
// divider page, followed by one game per page. Advertisements fill the gaps (see
// catalogue-ads.js), and the back holds the want list.
//
// Leaves turn with a bending page (leaf.js): Left/Right turn at the edge of a spread, a corner
// can be dragged over by hand, and long jumps riffle through several leaves. Page Up/Down jump
// between departments, Back returns to the Contents, and the leather thumb tabs on the fore-edge
// jump straight to a department.

import ADS, { FRONTISPIECE, adPicker, rng } from "./catalogue-ads.js";
import { createLeaf, edge, progressAt } from "./leaf.js";

let api = null;
let root = null;
let book = null;
let spread = null; // the focus container: both pages
let slotL = null;
let slotR = null;
let layer = null; // turning leaves
let cast = null; // the leaf's shadow on the page beneath
let tabs = null;
let unsubs = [];
let resize = null;

let depts = []; // { label, heading, entries, page }
let pages = []; // { kind, dept, ... } (see paginate)
let toc = []; // focusable contents lines, in reading order: { page, col, row, to, line }
let tocAt = 0;
let cFirst = 4; // first contents page
let cCount = 2;
let byId = new Map(); // entry id -> page index
let info = new Map(); // entry id -> { dept, i }
let at = 0; // the page with focus
let perCol = 20; // contents lines per column
let key = "";
let lastSel = null; // the selectedId the catalogue last followed or set
let adCtx = null;

let busy = false; // a leaf is turning
let pending = null; // the last input received while busy
let dirty = false; // a rebuild waits for the turn to finish
let drag = null;

const LEAF_MS = 640;
const FAST_MS = 380;
const SESSION_KEY = "vellum.frontier.catalogue.opened";

// ---- helpers --------------------------------------------------------------------------------

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function weight(bytes) {
  if (!bytes) return "—";
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb >= 10 ? Math.round(gb) : gb.toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

function year(e) {
  return e.metadata.releaseDate?.slice(0, 4) ?? null;
}

function longDate(iso) {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

function dateline(iso) {
  return iso ? longDate(iso) : "Not yet enjoyed";
}

const installed = (e) => e.sources.some((s) => s.installDir);
const stores = (e) => [...new Set(e.sources.map((s) => s.providerName))].join(" & ");
const spreadOf = (i) => i >> 1;
const ornament = (name) => new URL(`../textures/ads/${name}.svg`, import.meta.url).href;

/** Period copy for articles the store gives no description for. */
const BLURBS = [
  (e, g) => `A ${g} amusement of the first quality, warranted to give entire satisfaction or your money cheerfully refunded. Handsomely finished and packed with care.`,
  (e, g) => `Our most popular ${g} diversion this season. Thousands sold to satisfied customers in every state and territory. Sturdily made; will last a lifetime with ordinary care.`,
  (e, g) => `Recommended by gentlemen and ladies of discernment. A ${g} entertainment for the long winter evenings, guaranteed free from defects of material and workmanship.`,
  (e, g) => `Imported at great expense and offered at a price within the reach of all. A thoroughly modern ${g} pastime, approved by the best authorities.`,
  (e, g) => `The genuine article; beware of cheap imitations. A ${g} recreation of superior grade, every one carefully inspected before leaving our warehouse.`,
];

/** Testimonials for the open paper under a short description. */
const TESTIMONIALS = [
  ["Kept the whole family amused through the hardest winter in memory.", "Mrs. J. H., of Ohio"],
  ["I have not been outdoors since it arrived, and I do not regret it.", "A gentleman of Kansas City"],
  ["Superior in every respect to the one my brother bought from your competitor.", "R. T., Lemoyne"],
  ["My husband says it is educational. I have my doubts.", "Mrs. E. W., Saint Denis"],
  ["Arrived promptly, well packed, and has not stopped since.", "The Reverend A. B., of Vermont"],
  ["I ordered one for my son and have played it myself every evening.", "A grateful father, Iowa"],
  ["Worth every cent, and a good many cents more.", "C. M., Strawberry"],
  ["The finest diversion I have owned since the gramophone.", "Col. H. P. (retd.)"],
];

const DEPT_BLURBS = [
  (d) => `Our ${d.label} goods are chosen by buyers of long experience and sold at prices that defy competition.`,
  (d) => `Every article in this department is shipped the same day the order is received, Sundays excepted.`,
  (d) => `The most complete line of ${d.label} amusements to be found in any catalogue published.`,
  (d) => `Customers in every state and territory testify to the quality of our ${d.label} stock. Compare our prices.`,
];

function description(e) {
  if (e.metadata.description) return e.metadata.description;
  const g = (e.metadata.genres?.[0] ?? "parlour").toLowerCase();
  return BLURBS[hash(e.id) % BLURBS.length](e, g);
}

/** Advertisement art is engraved unless the user turned that off; then the skin's style applies. */
const plateStyle = () => (api.skin.options.engravings === false ? undefined : "sketch");

/** The large figure: a hand-coloured (watercolor) plate by default, as catalogues tinted their
 *  feature engravings; or an engraving; or the skin's art style ("skin"). */
function figureStyle() {
  const v = api.skin.options.figureArt ?? "watercolor";
  return v === "skin" ? undefined : v;
}

const adMode = () => api.skin.options.adverts ?? "sparing";

/** Reduced motion, or Frontier's own "still" switch: pages cross-fade instead of turning. */
const still = () => document.documentElement.hasAttribute("data-fr-still") || matchMedia("(prefers-reduced-motion: reduce)").matches;

function catNo(e) {
  const i = info.get(e.id);
  return i ? `${i.dept + 1}-${i.i + 101}` : "—";
}

function cut(e, cls, kind, width, style) {
  const box = el("div", cls);
  const img = el("img");
  img.alt = "";
  img.decoding = "async";
  img.draggable = false;
  img.src = api.art.url(e.id, kind, width, style);
  if (e.artStatus[kind] === "placeholder") box.classList.add("is-placeholder");
  box.append(img);
  return box;
}

// ---- departments and pagination ---------------------------------------------------------------

function departments(entries) {
  if (api.state.get().groupBy) {
    return api.library.groups().filter((g) => g.entries.length).map((g) => ({ label: g.label, heading: g.label, entries: g.entries }));
  }
  const withGenre = entries.filter((e) => e.metadata.genres?.length).length;
  if (entries.length && withGenre >= entries.length / 2) {
    const by = new Map();
    for (const e of entries) {
      const g = e.metadata.genres?.[0] ?? "Sundries";
      if (!by.has(g)) by.set(g, []);
      by.get(g).push(e);
    }
    return [...by.entries()]
      .sort(([a], [b]) => (a === "Sundries") - (b === "Sundries") || a.localeCompare(b))
      .map(([g, list]) => ({ label: g, heading: g === "Sundries" ? "Sundries & Notions" : `${g} Department`, entries: list }));
  }
  // No genres: letter ranges when sorted by title, else one department.
  const sort = api.state.get().sort.replace(/^-/, "");
  if (sort !== "title" || entries.length < 24) return entries.length ? [{ label: "General", heading: "General Merchandise", entries }] : [];
  const letter = (e) => (/[a-z]/.test(e.sortTitle[0] ?? "") ? e.sortTitle[0].toUpperCase() : "#");
  const target = Math.ceil(entries.length / 6);
  const out = [];
  let cur = null;
  for (const e of entries) {
    const l = letter(e);
    if (!cur || (cur.entries.length >= target && l !== cur.to)) {
      cur = { from: l, to: l, entries: [] };
      out.push(cur);
    }
    cur.to = l;
    cur.entries.push(e);
  }
  return out.map((d) => {
    const range = d.from === d.to ? d.from : `${d.from} – ${d.to}`;
    return { label: range, heading: `Goods, ${d.from === d.to ? d.from : `${d.from} to ${d.to}`}`, entries: d.entries };
  });
}

/** What the advertisements may know about the catalogue (see catalogue-ads.js). */
function adContext(entries) {
  const once = (f) => {
    let done = false;
    let v;
    return () => (done ? v : ((done = true), (v = f())));
  };
  const by = (list, score) => list.reduce((best, e) => (best == null || score(e) > score(best) ? e : best), null);
  const month = 30 * 24 * 3600 * 1000;
  return {
    ads: ADS,
    entries,
    get depts() {
      return depts;
    },
    catNo,
    pageOf: (e) => byId.get(e.id) ?? "—",
    weight,
    date: longDate,
    // Installed and never started; else installed and not started for a month.
    neglected: once(() => {
      const inst = entries.filter(installed);
      const never = inst.filter((e) => !e.lastLaunched);
      if (never.length) return by(never, (e) => -Date.parse(e.addedAt));
      const old = inst.filter((e) => Date.now() - Date.parse(e.lastLaunched) > month);
      return by(old, (e) => -Date.parse(e.lastLaunched));
    }),
    recent: once(() => by(entries.filter((e) => e.lastLaunched), (e) => Date.parse(e.lastLaunched))),
    newest: once(() => (entries.length >= 2 ? by(entries, (e) => Date.parse(e.addedAt)) : null)),
    heaviest: once(() => by(entries.filter((e) => e.sizeBytes), (e) => e.sizeBytes)),
    biggestDept: once(() => (depts.length >= 2 ? by(depts, (d) => d.entries.length) : null)),
  };
}

/**
 * Lays the book out as pages. Page kinds:
 *   inside (the inside cover), title, frontis (the house guarantee), howto,
 *   contents { n, cols: [[line | null]...], box }, divider { dept, box }, game { entry, dept, strip },
 *   ad { ad }, memo (a ruled page, when advertisements are off), wants, colophon.
 * Body pages carry `dept` so running heads and tabs know where they are.
 */
function paginate() {
  const entries = api.library.query();
  depts = departments(entries);
  info = new Map();
  depts.forEach((d, di) => d.entries.forEach((e, i) => info.set(e.id, { dept: di, i })));
  byId = new Map();
  adCtx = adContext(entries);
  const mode = adMode();
  const random = rng(hash(entries.map((e) => e.id).sort().join("|") + mode));
  const pickAd = mode === "none" ? () => null : adPicker(adCtx, random);
  const gapPage = (dept) => {
    const ad = pickAd("full");
    return ad ? { kind: "ad", ad, dept } : { kind: "memo", dept };
  };

  pages = [{ kind: "inside", dept: -1 }, { kind: "title", dept: -1 }, { kind: "frontis", ad: FRONTISPIECE, dept: -1 }, { kind: "howto", dept: -1 }];

  // The contents, in columns; a department heading never sits alone at the foot of a column.
  const cols = [];
  let col = [];
  const lines = [];
  depts.forEach((d, di) => {
    lines.push({ kind: "dept", dept: di, d });
    d.entries.forEach((e) => lines.push({ kind: "game", dept: di, entry: e }));
  });
  for (const ln of lines) {
    if (ln.kind === "dept" && col.length && col.length + 3 > perCol) (cols.push(col), (col = []));
    else if (ln.kind === "dept" && col.length) col.push(null);
    else if (col.length >= perCol) (cols.push(col), (col = []));
    col.push(ln);
  }
  if (col.length) cols.push(col);
  cCount = Math.max(2, Math.ceil(cols.length / 2));
  cCount += cCount % 2;
  cFirst = pages.length;
  for (let n = 0; n < cCount; n++) {
    const mine = cols.slice(n * 2, n * 2 + 2);
    if (!mine.length && n > 0) {
      const g = gapPage(-1);
      pages.push({ ...g, inContents: true });
      continue;
    }
    // Spare room at the foot of the last column takes a boxed notice.
    const last = mine[mine.length - 1];
    const room = mine.length < 2 ? perCol : perCol - (last?.length ?? 0);
    const box = n === Math.ceil(cols.length / 2) - 1 && room >= 9 ? pickAd("box") : null;
    // The box goes in the second column: at its foot, or filling it when it is empty.
    pages.push({ kind: "contents", n, cols: mine, box, dept: -1 });
  }

  // The body: each department opens with a divider on a left-hand page, facing its first article.
  let since = 0;
  const every = () => (mode === "generous" ? 5 + Math.floor(random() * 3) : 9 + Math.floor(random() * 4));
  let next = every();
  depts.forEach((d, di) => {
    if (pages.length % 2) pages.push(gapPage(di - 1));
    d.page = pages.length;
    pages.push({ kind: "divider", dept: di, box: pickAd("box") });
    d.entries.forEach((e, i) => {
      if (mode !== "none" && since >= next && i > 0) {
        const ad = pickAd("full");
        if (ad) pages.push({ kind: "ad", ad, dept: di });
        since = 0;
        next = every();
      }
      byId.set(e.id, pages.length);
      pages.push({ kind: "game", entry: e, dept: di, strip: mode === "generous" ? pickAd("strip") : null });
      since++;
    });
  });
  pages.push({ kind: "wants", dept: -1 });
  if (pages.length % 2) pages.push({ kind: "colophon", dept: -1 });

  // Contents lines now know their pages.
  toc = [];
  pages.forEach((p, pi) => {
    if (p.kind !== "contents") return;
    p.cols.forEach((c, ci) =>
      c.forEach((ln, row) => {
        if (!ln) return;
        ln.to = ln.kind === "dept" ? depts[ln.dept].page : byId.get(ln.entry.id);
        ln.ti = toc.length;
        toc.push({ page: pi, col: (pi - cFirst) * 2 + ci, row, to: ln.to, line: ln });
      }),
    );
  });
  root.dataset.ads = pages.flatMap((p) => [p.ad, p.box, p.strip].filter(Boolean).map((a) => a.id)).join(" ");
}

/** Rebuilds the book. `reason` "query" returns to the Contents; otherwise the page stays put. */
let librarySig = "";

/** What the pages print about each game. A library update that changes none of it (a rescan that
 *  found the same games) leaves the book alone, so its art doesn't reload and flash. */
function pagesSignature() {
  return JSON.stringify(
    api.library.query().map((e) => [e.id, e.title, e.art, e.artStatus, e.metadata, e.sizeBytes, e.favorite, e.labels, e.lastLaunched, e.playtimeMinutes]),
  );
}

function onLibrary() {
  const sig = pagesSignature();
  if (sig === librarySig) return;
  librarySig = sig;
  rebuild();
}

function rebuild(reason) {
  if (!root) return;
  if (busy) {
    dirty = reason ?? (dirty || true);
    return;
  }
  const keep = pages[at]?.kind === "game" ? pages[at].entry.id : null;
  const keepIndex = at;
  paginate();
  if (reason === "query") setAt(cFirst);
  else if (keep && byId.has(keep)) setAt(byId.get(keep));
  else setAt(Math.min(keepIndex, pages.length - 1));
  showSpread();
  renderTabs();
}

// ---- pages ------------------------------------------------------------------------------------

function running(s, i, middle) {
  const head = el("header", "fr-cat-running");
  const outer = i % 2 ? "Vellum & Co." : "Catalogue No. 1899";
  const inner = i % 2 ? "Catalogue No. 1899" : "Vellum & Co.";
  head.append(el("span", null, i % 2 ? inner : outer), el("span", "fr-cat-running-dept", middle), el("span", null, i % 2 ? outer : inner));
  s.append(head);
}

const folio = (s, i) => s.append(el("footer", "fr-cat-folio", `— ${i} —`));

function middleOf(p) {
  if (p.kind === "contents" || p.inContents) return "Contents";
  if (p.dept >= 0) return depts[p.dept].heading;
  if (p.kind === "wants") return "Order Department";
  return "Notices";
}

/** A fresh copy of page `i`, or a blank leaf of paper when `i` is out of range. */
function sheet(i) {
  const p = pages[i];
  const s = el("div", `fr-cat-sheet ${i % 2 ? "is-recto" : "is-verso"} is-${p?.kind ?? "blank"}`);
  if (!p) return s;
  s.dataset.page = String(i);
  const bare = p.kind === "inside" || p.kind === "title" || p.kind === "colophon";
  if (!bare) running(s, i, middleOf(p));
  RENDER[p.kind](s, p, i);
  if (!bare) folio(s, i);
  return s;
}

function blank(i) {
  return el("div", `fr-cat-sheet ${i % 2 ? "is-recto" : "is-verso"} is-blank`);
}

function band(title, sub) {
  const b = el("div", "fr-cat-band");
  b.append(el("h2", "fr-cat-band-title", title));
  if (sub) b.append(el("p", "fr-cat-band-sub", sub));
  return b;
}

const RENDER = {
  inside(s) {
    s.append(el("div", "fr-cat-marble"));
    const plate = el("div", "fr-cat-bookplate");
    const n = adCtx.entries.length;
    plate.append(
      el("p", "fr-cat-bookplate-ex", "Ex Libris"),
      el("div", "fr-cat-rule"),
      el("p", null, `This catalogue, being a complete list of ${n} article${n === 1 ? "" : "s"} in stock, is the property of`),
      el("p", "fr-cat-bookplate-line"),
      el("p", "fr-cat-bookplate-foot", "Vellum & Co. · Catalogue No. 1899"),
    );
    s.append(plate);
  },

  title(s) {
    const t = el("div", "fr-cat-titlepage");
    const m = new Date().getMonth();
    const season = m < 2 || m > 9 ? "Winter" : m < 5 ? "Spring" : m < 8 ? "Summer" : "Autumn";
    const n = adCtx.entries.length;
    const orn = el("img", "fr-cat-titlepage-orn");
    orn.src = ornament("star");
    orn.alt = "";
    t.append(
      el("p", "fr-cat-titlepage-season", `${season} Edition`),
      el("p", "fr-cat-titlepage-house", "Vellum & Co.'s"),
      el("h1", "fr-cat-titlepage-big", "Catalogue"),
      el("p", "fr-cat-titlepage-no", "No. 1899"),
      el("div", "fr-cat-rule"),
      el("p", "fr-cat-titlepage-of", "of Fine Amusements, Diversions, Parlour Games & Sporting Goods"),
      el("p", "fr-cat-titlepage-count", `Being a complete list of ${n} article${n === 1 ? "" : "s"} in ${depts.length} department${depts.length === 1 ? "" : "s"}`),
      orn,
      el("p", "fr-cat-titlepage-foot", "Wholesale & Retail · Shipped to every State and Territory"),
      el("p", "fr-cat-titlepage-city", "Saint Vellum, Western Territories"),
    );
    s.append(t);
  },

  frontis(s, p) {
    s.append(renderAd(p.ad, "full"));
  },

  howto(s) {
    s.append(band("How to Order", "Read carefully · it will save you time"));
    const ol = el("ol", "fr-cat-howto");
    const step = (k, text) => {
      const li = el("li");
      li.append(el("b", "fr-cat-key", k), el("span", null, text));
      ol.append(li);
    };
    step("Esc", "Consult the Contents and choose an article: the leaves will turn to it of their own accord.");
    step("← →", "Turn the leaves, or take the corner of a page in hand and turn it yourself.");
    step("PgUp PgDn", "Reach the departments, or use the leather tabs along the fore-edge.");
    step("Enter", "Press it, or the red Order button on the article's page, and your amusement is dispatched at once.");
    step("Ctrl D", "Place an article on your Want List, printed at the back of this catalogue.");
    s.append(ol, el("p", "fr-cat-terms", "Terms: cash with order. No goods sent C.O.D. We pay the freight."));
  },

  contents(s, p, i) {
    s.append(band(p.n === 0 ? "Contents" : "Contents, continued", p.n === 0 ? `${adCtx.entries.length} articles in ${depts.length} departments` : null));
    if (!depts.length) {
      const none = el("div", "fr-cat-none");
      none.append(el("p", "fr-cat-none-big", "Regret to inform"), el("p", null, "No goods in our warehouse answer to your enquiry. Kindly amend your order and try again."));
      s.append(none);
      return;
    }
    const cols = el("div", "fr-cat-toc");
    cols.style.setProperty("--lines", String(perCol));
    for (let c = 0; c < 2; c++) {
      const ol = el("ol", "fr-cat-toc-col");
      for (const ln of p.cols[c] ?? []) {
        const li = el("li");
        if (!ln) {
          li.className = "fr-cat-toc-gap";
          ol.append(li);
          continue;
        }
        const b = el("button", ln.kind === "dept" ? "fr-cat-toc-line is-dept" : "fr-cat-toc-line");
        b.type = "button";
        b.tabIndex = -1;
        b.dataset.ti = String(ln.ti);
        if (ln.kind === "dept") b.append(el("span", "fr-cat-toc-title", depts[ln.dept].heading));
        else {
          b.append(el("span", "fr-cat-toc-no", catNo(ln.entry)), el("span", "fr-cat-toc-title", ln.entry.title));
          if (ln.entry.favorite) b.classList.add("is-favorite");
        }
        b.append(el("i", "fr-cat-leader"), el("span", "fr-cat-toc-page", String(ln.to)));
        if (ln.ti === tocAt) b.classList.add("is-focus");
        b.addEventListener("click", (ev) => {
          ev.stopPropagation();
          tocAt = ln.ti;
          goTo(ln.to);
        });
        li.append(b);
        ol.append(li);
      }
      if (c === 1 && p.box) {
        const li = el("li", "fr-cat-toc-box");
        li.append(renderAd(p.box, "box"));
        ol.append(li);
      }
      cols.append(ol);
    }
    s.append(cols);
  },

  divider(s, p) {
    const d = depts[p.dept];
    s.append(band(d.heading, `${d.entries.length} article${d.entries.length === 1 ? "" : "s"} · carriage paid to any railway station`));
    const body = el("div", "fr-cat-divider");
    body.append(el("p", "fr-cat-divider-blurb", DEPT_BLURBS[hash(d.label) % DEPT_BLURBS.length](d)));
    const names = d.entries.slice(0, 4).map((e) => e.title);
    const incl = el("p", "fr-cat-divider-incl");
    incl.append(el("span", null, "Including "), names.join(", ") + (d.entries.length > 4 ? `, and ${d.entries.length - 4} more.` : "."));
    body.append(incl);
    if (p.box) body.append(renderAd(p.box, "box"));
    else body.append(el("div", "fr-cat-divider-orn"));
    s.append(body);
  },

  game(s, p, i) {
    const e = p.entry;
    const art = e.artStatus.hero === "placeholder" && e.artStatus.cover !== "placeholder" ? "cover" : "hero";
    const fig = cut(e, `fr-cat-engraving is-${art}`, art, 1280, figureStyle());
    if (figureStyle() === "watercolor") fig.classList.add("is-coloured");
    fig.append(el("span", "fr-cat-fig", `Fig. ${i}.`));
    fig.addEventListener("dblclick", () => api.actions.launch(e.id).catch(() => {}));
    s.append(fig);

    const title = el("h2", "fr-cat-plate-title", e.title);
    if (e.title.length > 26) title.classList.add("is-long");
    s.append(el("span", "fr-cat-tick", "✓"), title);
    const byline = [
      e.metadata.developer ? `Manufactured by ${e.metadata.developer}` : null,
      e.metadata.publisher && e.metadata.publisher !== e.metadata.developer ? `sold by ${e.metadata.publisher}` : null,
    ].filter(Boolean);
    s.append(el("p", "fr-cat-byline", byline.length ? byline.join(", ") : `Supplied through ${stores(e)}`));
    s.append(el("div", "fr-cat-rule"));
    s.append(el("p", `fr-cat-desc${p.strip ? " is-short" : ""}`, description(e)));

    const specs = el("dl", "fr-cat-specs");
    const row = (k, v) => {
      const d = el("div");
      d.append(el("dt", null, k), el("i", "fr-cat-leader"), el("dd", null, v));
      specs.append(d);
    };
    row("Catalogue No.", catNo(e));
    row("Department", e.metadata.genres?.slice(0, 2).join(", ") || depts[p.dept].label);
    if (year(e)) row("Established", year(e));
    row("Purveyor", stores(e));
    row("Shipping weight", weight(e.sizeBytes));
    row("Last enjoyed", dateline(e.lastLaunched));
    s.append(specs);

    // Short copy leaves open paper; a customer fills it, as in the catalogues of the day.
    if (description(e).length < 260) {
      const [quote, who] = TESTIMONIALS[hash(e.id + "t") % TESTIMONIALS.length];
      const t = el("blockquote", "fr-cat-testimonial", `“${quote}”`);
      t.append(el("cite", null, `— ${who}`));
      s.append(t);
    }
    const stamp = el("div", `fr-cat-stamp ${installed(e) ? "is-stock" : "is-order"}`, installed(e) ? "In Stock" : "Special Order");
    stamp.style.setProperty("--tilt", `${(hash(e.id) % 9) - 12}deg`);
    s.append(stamp);
    if (p.strip) s.append(renderAd(p.strip, "strip"));

    // The order blank at the foot of the page, to be cut out along the dotted line.
    const order = el("div", "fr-cat-order");
    const head = el("div", "fr-cat-order-head");
    head.append(el("span", "fr-cat-scissors", "✂"), el("span", null, "Order Blank"), el("span", null, "Vellum & Co., Purveyors"));
    const line = el("p", "fr-cat-order-line");
    const field = (text) => el("span", "fr-cat-field", text);
    line.append("Please forward at once Article No. ", field(catNo(e)), ", ", field(e.title), ", by ", field(stores(e)), ".");
    const actions = el("div", "fr-cat-actions");
    const play = document.createElement("vellum-play-button");
    play.entry = e;
    const want = el("button", "fr-cat-want", e.favorite ? "✓ On your want list" : "Add to want list");
    want.type = "button";
    want.setAttribute("aria-pressed", String(e.favorite));
    want.addEventListener("click", (ev) => {
      ev.stopPropagation();
      api.actions.toggleFavorite(e.id);
    });
    actions.append(play, want, el("span", "fr-cat-signed", "Signed, the Proprietor"));
    order.append(head, line, actions);
    s.append(order);
  },

  ad(s, p) {
    s.append(renderAd(p.ad, "full"));
  },

  memo(s) {
    s.append(band("Memoranda", "For the customer's own notes"));
    s.append(el("div", "fr-cat-memo"));
  },

  wants(s) {
    s.append(band("Your Want List", "Articles marked for future order"));
    const wants = adCtx.entries.filter((e) => e.favorite);
    if (!wants.length) {
      s.append(el("p", "fr-cat-wants-none", "Your want list is empty. Mark any article with Ctrl D, or with the button on its page, and it will be entered here."));
    } else {
      const ol = el("ol", "fr-cat-wants");
      for (const e of wants.slice(0, 18)) {
        const li = el("li");
        const b = el("button", "fr-cat-toc-line");
        b.type = "button";
        b.tabIndex = -1;
        b.append(el("span", "fr-cat-toc-no", catNo(e)), el("span", "fr-cat-toc-title", e.title), el("i", "fr-cat-leader"), el("span", "fr-cat-toc-page", String(byId.get(e.id) ?? "—")));
        b.addEventListener("click", (ev) => {
          ev.stopPropagation();
          if (byId.has(e.id)) goTo(byId.get(e.id));
        });
        li.append(b);
        ol.append(li);
      }
      s.append(ol);
      if (wants.length > 18) s.append(el("p", "fr-cat-wants-more", `and ${wants.length - 18} more, continued on a separate sheet.`));
    }
    const sig = el("div", "fr-cat-wants-sign");
    sig.append(el("span", null, "Name"), el("i"), el("span", null, "Post office"), el("i"));
    s.append(sig);
  },

  colophon(s) {
    const c = el("div", "fr-cat-colophon");
    const orn = el("img", "fr-cat-titlepage-orn");
    orn.src = ornament("star");
    orn.alt = "";
    c.append(orn, el("p", "fr-cat-colophon-big", "Thank you for your patronage"), el("p", null, "Printed and bound by Vellum & Co. on paper of our own manufacture. Set in wood type and Old Style by hand."));
    s.append(c);
  },
};

/** One advertisement, in the period manner: ruled border, wood type, an engraving. */
function renderAd(ad, size) {
  let c = null;
  try {
    c = ad.render(adCtx);
  } catch (err) {
    console.warn(`Frontier: advertisement "${ad.id}" failed to render`, err);
  }
  const box = el(size === "strip" ? "div" : "article", `fr-cat-ad is-${size} is-${ad.kind}`);
  box.dataset.ad = ad.id;
  if (!c) return box;
  if (size === "strip") {
    box.append(el("b", "fr-cat-ad-head", c.headline), el("span", "fr-cat-ad-sub", c.strip ?? c.sub ?? ""), el("i", "fr-cat-leader"), el("span", "fr-cat-ad-price", c.price ?? ""));
  } else {
    if (c.kicker) box.append(el("p", "fr-cat-ad-kicker", c.kicker));
    box.append(el("h3", "fr-cat-ad-head", c.headline));
    if (c.sub) box.append(el("p", "fr-cat-ad-sub", c.sub));
    if (c.art?.entry) box.append(cut(c.art.entry, "fr-cat-ad-art", c.art.kind ?? "cover", size === "full" ? 480 : 240, plateStyle()));
    else if (c.ornament) {
      const img = el("img", "fr-cat-ad-orn");
      img.alt = "";
      img.src = ornament(c.ornament);
      box.append(img);
    }
    box.append(el("p", "fr-cat-ad-body", c.body));
    if (c.price) box.append(el("p", "fr-cat-ad-price", c.price));
    if (c.fine) box.append(el("p", "fr-cat-ad-fine", c.fine));
    if (c.stamp) {
      const st = el("div", "fr-cat-stamp fr-cat-ad-stamp", c.stamp);
      st.style.setProperty("--tilt", `${(hash(ad.id) % 14) - 18}deg`);
      box.append(st);
    }
  }
  const to = c.target ? byId.get(c.target.id) : c.page;
  if (to != null) {
    box.classList.add("is-link");
    box.dataset.to = String(to);
    box.addEventListener("click", (ev) => {
      ev.stopPropagation();
      goTo(to);
    });
  }
  return box;
}

// ---- the spread on screen ---------------------------------------------------------------------

function showSpread() {
  const sp = spreadOf(at);
  slotL.replaceChildren(sheet(sp * 2));
  slotR.replaceChildren(sheet(sp * 2 + 1));
  markAt();
  thickness();
}

/** The page stack on each side thickens as pages pass to it. */
function thickness() {
  const f = pages.length > 2 ? (spreadOf(at) * 2) / (pages.length - 2) : 0;
  book.style.setProperty("--read", f.toFixed(3));
}

function markAt() {
  slotL.classList.toggle("is-at", at % 2 === 0);
  slotR.classList.toggle("is-at", at % 2 === 1);
  for (const b of spread.querySelectorAll(".fr-cat-toc-line.is-focus")) b.classList.remove("is-focus");
  if (pages[at]?.kind === "contents") spread.querySelector(`.fr-cat-toc-line[data-ti="${tocAt}"]`)?.classList.add("is-focus");
  renderTabsCurrent();
}

/** Puts focus on page `i` (and, on a game page, selects that game). */
function setAt(i, { toc: line } = {}) {
  at = Math.max(0, Math.min(i, pages.length - 1));
  const p = pages[at];
  if (p?.kind === "contents") {
    if (line != null) tocAt = line;
    else if (toc[tocAt]?.page !== at) tocAt = toc.findIndex((t) => t.page === at);
    if (tocAt < 0) tocAt = 0;
  }
  if (p?.kind === "game") {
    lastSel = p.entry.id;
    if (p.entry.id !== api.state.get().selectedId) void api.state.set({ selectedId: p.entry.id });
  }
  try {
    api.skin.storage.set("catalogue.at", { page: at, sel: api.state.get().selectedId });
  } catch {
    // storage is a convenience
  }
}

// ---- turning ------------------------------------------------------------------------------------

/** Turns to page `i` (riffling when it is more than a spread away) and puts focus there. */
function goTo(i, opts = {}) {
  if (!root || i == null || i < 0 || i >= pages.length) return;
  if (busy) {
    pending = () => goTo(i, opts);
    return;
  }
  const from = spreadOf(at);
  const to = spreadOf(i);
  if (from === to) {
    setAt(i, opts);
    markAt();
    return;
  }
  void turn(from, to, opts.fast).then(() => {
    if (!root) return;
    setAt(i, opts);
    markAt();
  });
}

function begin() {
  busy = true;
  book.dataset.turning = "";
}

function end() {
  busy = false;
  delete book.dataset.turning;
  cast.style.setProperty("--a", "0");
  if (dirty) {
    const reason = dirty;
    dirty = false;
    rebuild(reason === true ? undefined : reason);
  }
  const next = pending;
  pending = null;
  if (next) next();
}

function castAt(leaf) {
  const W = spread.clientWidth;
  const w = W / 2;
  const e = edge(leaf.t, leaf.strips, leaf.bend);
  const x = W / 2 + leaf.dir * e * w;
  const a = (0.5 * Math.sin(Math.PI * leaf.t)).toFixed(3);
  const reach = 18 + 0.22 * w * (1 - Math.abs(e));
  // The shadow falls on the far side of the fore-edge, away from the spine: a 100 px band,
  // stretched to `reach` and flipped when it falls to the left.
  const away = x >= W / 2 ? 1 : -1;
  cast.style.setProperty("--x", `${x.toFixed(1)}px`);
  cast.style.setProperty("--sx", ((away * reach) / 100).toFixed(3));
  cast.style.setProperty("--a", a);
}

/** Turns the book from spread `from` to spread `to`. */
async function turn(from, to, fast = false) {
  const dir = to > from ? 1 : -1;
  begin();
  if (still()) {
    spread.classList.add("is-fading");
    await delay(150);
    if (!root) return;
    at = to * 2 + (dir > 0 ? 0 : 1);
    showSpread();
    spread.classList.remove("is-fading");
    end();
    return;
  }
  const w = slotR.clientWidth;
  const h = slotR.clientHeight;
  const near = dir > 0 ? from * 2 + 1 : from * 2; // the page lifting
  const far = dir > 0 ? to * 2 : to * 2 + 1; // where it lands
  const under = dir > 0 ? to * 2 + 1 : to * 2; // revealed beneath it
  (dir > 0 ? slotR : slotL).replaceChildren(sheet(under));
  const count = Math.min(5, Math.abs(to - from));
  const leaves = [];
  for (let k = 0; k < count; k++) {
    const first = k === 0;
    const last = k === count - 1;
    leaves.push(
      createLeaf(layer, {
        dir,
        width: w,
        height: h,
        front: first ? () => sheet(near) : () => blank(near),
        back: last ? () => sheet(far) : () => blank(far),
      }),
    );
  }
  const ms = count > 1 ? 520 : fast ? FAST_MS : LEAF_MS;
  const order = () => {
    leaves.forEach((lf, k) => (lf.el.style.zIndex = String(lf.t < 0.5 ? 100 - k : 200 + k)));
    castAt(leaves.find((lf) => lf.t > 0 && lf.t < 1) ?? leaves[leaves.length - 1]);
  };
  order();
  await Promise.all(leaves.map((lf, k) => delay(k * 85).then(() => lf.animate(1, ms, order))));
  if (!root) return;
  (dir > 0 ? slotL : slotR).replaceChildren(sheet(far));
  leaves.forEach((lf) => lf.remove());
  at = far;
  markAt();
  thickness();
  end();
}

// ---- dragging a corner over ---------------------------------------------------------------------

function grip(dir) {
  const g = el("div", `fr-cat-grip ${dir > 0 ? "is-next" : "is-prev"}`);
  g.addEventListener("pointerdown", (ev) => {
    if (busy || ev.button !== 0) return;
    const sp = spreadOf(at);
    const to = sp + dir;
    if (to < 0 || to * 2 >= pages.length) return;
    g.setPointerCapture(ev.pointerId);
    drag = { dir, from: sp, to, x: ev.clientX, started: false, leaf: null, v: 0, lastX: ev.clientX, lastT: performance.now() };
    ev.preventDefault();
  });
  g.addEventListener("pointermove", (ev) => {
    if (!drag || drag.dir !== dir) return;
    const now = performance.now();
    drag.v = (ev.clientX - drag.lastX) / Math.max(1, now - drag.lastT);
    drag.lastX = ev.clientX;
    drag.lastT = now;
    if (!drag.started) {
      if (Math.abs(ev.clientX - drag.x) < 6 || still()) return;
      drag.started = true;
      begin();
      const w = slotR.clientWidth;
      const h = slotR.clientHeight;
      const near = dir > 0 ? drag.from * 2 + 1 : drag.from * 2;
      const far = dir > 0 ? drag.to * 2 : drag.to * 2 + 1;
      drag.near = near;
      drag.far = far;
      (dir > 0 ? slotR : slotL).replaceChildren(sheet(dir > 0 ? drag.to * 2 + 1 : drag.to * 2));
      drag.leaf = createLeaf(layer, { dir, width: w, height: h, front: () => sheet(near), back: () => sheet(far), bend: 48 });
      drag.leaf.el.style.zIndex = "100";
    }
    const r = spread.getBoundingClientRect();
    const spine = r.left + r.width / 2;
    const w = r.width / 2;
    const x = Math.max(-1, Math.min(1, (dir * (ev.clientX - spine)) / w));
    drag.leaf.set(progressAt(x, drag.leaf.strips, drag.leaf.bend));
    castAt(drag.leaf);
  });
  const release = async () => {
    const d = drag;
    drag = null;
    if (!d) return;
    if (!d.started) {
      // A click on the margin turns the page.
      goTo(dir > 0 ? d.to * 2 : d.to * 2 + 1);
      return;
    }
    const flick = -dir * d.v > 0.6;
    const done = d.leaf.t > 0.35 || flick;
    await d.leaf.animate(done ? 1 : 0, (done ? 1 - d.leaf.t : d.leaf.t) * 520 + 80, castAt);
    if (!root) return;
    if (done) {
      (dir > 0 ? slotL : slotR).replaceChildren(sheet(d.far));
      d.leaf.remove();
      at = d.far;
      setAt(d.far);
      markAt();
      thickness();
    } else {
      showSpread();
      d.leaf.remove();
    }
    end();
  };
  g.addEventListener("pointerup", release);
  g.addEventListener("pointercancel", release);
  return g;
}

// ---- the cover ------------------------------------------------------------------------------------

function coverFace() {
  const c = el("div", "fr-cat-sheet fr-cat-coverface is-recto");
  c.append(
    el("p", "fr-cat-cover-house", "Vellum & Co."),
    el("div", "fr-cat-cover-rule"),
    el("p", "fr-cat-cover-big", "Catalogue"),
    el("p", "fr-cat-cover-no", "No. 1899"),
    el("div", "fr-cat-cover-rule"),
    el("p", "fr-cat-cover-foot", "Fine Amusements · Sporting Goods"),
  );
  return c;
}

/** The closed book swings open on its spine, then turns to `target`. Once per session. */
async function openCover(target) {
  begin();
  book.classList.add("is-closed");
  slotL.replaceChildren(sheet(0));
  slotR.replaceChildren(sheet(1));
  const leaf = createLeaf(layer, {
    dir: 1,
    width: slotR.clientWidth,
    height: slotR.clientHeight,
    front: coverFace,
    back: () => sheet(0),
    strips: 1,
    bend: 0,
    className: "is-cover",
  });
  leaf.el.style.zIndex = "300";
  await delay(420);
  if (!root) return;
  book.classList.add("is-opening");
  await leaf.animate(1, 1150, castAt);
  if (!root) return;
  leaf.remove();
  book.classList.remove("is-closed", "is-opening");
  at = 1;
  markAt();
  // Input that arrived while the cover opened wins over resuming the last page read.
  if (!pending) pending = () => (spreadOf(target) !== 0 ? goTo(target) : (setAt(target), markAt()));
  end();
}

// ---- tabs ---------------------------------------------------------------------------------------

function renderTabs() {
  const tab = (label, title, hue, to) => {
    const b = el("button", "fr-cat-tab");
    b.type = "button";
    b.append(el("span", null, label));
    b.title = title;
    b.setAttribute("data-vellum-focus", "");
    b.style.setProperty("--hue", String(hue));
    b.addEventListener("click", () => goTo(to()));
    return b;
  };
  tabs.replaceChildren(
    tab("Contents", "Contents", 200, () => cFirst),
    ...depts.map((d, i) => tab(d.label, d.heading, (i * 37) % 360, () => d.page)),
  );
  tabs.firstChild.classList.add("is-contents");
  renderTabsCurrent();
}

function renderTabsCurrent() {
  if (!tabs) return;
  const p = pages[at];
  const inContents = at >= cFirst && at < cFirst + cCount;
  const current = inContents ? 0 : p && p.dept >= 0 ? p.dept + 1 : -1;
  [...tabs.children].forEach((b, i) => (i === current ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current")));
}

// ---- keyboard and controller ------------------------------------------------------------------

/** Moves through the Contents lines; turns the leaf when the next line is on another spread. */
function tocMove(next) {
  if (next < 0 || next >= toc.length) return false;
  tocAt = next;
  const t = toc[next];
  if (spreadOf(t.page) !== spreadOf(at)) goTo(t.page, { toc: next });
  else {
    setAt(t.page, { toc: next });
    markAt();
  }
  return true;
}

function tocColumn(d) {
  const cur = toc[tocAt];
  if (!cur) return step(d);
  const col = cur.col + d;
  const inCol = toc.filter((t) => t.col === col);
  if (!inCol.length) return step(d);
  const best = inCol.reduce((b, t) => (Math.abs(t.row - cur.row) < Math.abs(b.row - cur.row) ? t : b));
  return tocMove(toc.indexOf(best));
}

function step(d) {
  const next = at + d;
  if (next < 0 || next >= pages.length) return false;
  if (spreadOf(next) === spreadOf(at)) {
    setAt(next);
    markAt();
  } else goTo(next);
  return true;
}

/** Page Down: the next department. Page Up: the start of this one, or the one before when
 *  already there; before the first department, the Contents. */
function deptJump(d) {
  if (d > 0) {
    const next = depts.find((x) => x.page > at);
    if (next) goTo(next.page);
    return true;
  }
  const starts = depts.filter((x) => x.page <= at);
  const here = starts[starts.length - 1];
  // On a divider's spread, "the start of this one" is already on screen.
  if (here && spreadOf(here.page) !== spreadOf(at)) goTo(here.page);
  else if (starts.length > 1) goTo(starts[starts.length - 2].page);
  else if (at >= cFirst + cCount) goTo(cFirst);
  return true;
}

function nav(dir) {
  if (busy) {
    if (dir === "left" || dir === "right" || dir === "pageUp" || dir === "pageDown") pending = () => nav(dir);
    return true;
  }
  const p = pages[at];
  if (p?.kind === "contents" && toc.length) {
    if (dir === "down") return tocMove(tocAt + 1) || true;
    if (dir === "up") return tocMove(tocAt - 1);
    if (dir === "left" || dir === "right") return tocColumn(dir === "right" ? 1 : -1);
  }
  switch (dir) {
    case "right":
      return step(1);
    case "left":
      return step(-1);
    case "down":
      return true;
    case "up":
      return false; // leave for the toolbar
    case "pageDown":
      return deptJump(1);
    case "pageUp":
      return deptJump(-1);
  }
  return false;
}

function confirm() {
  if (busy) return;
  const p = pages[at];
  if (!p) return;
  if (p.kind === "contents") {
    const t = toc[tocAt];
    if (t) goTo(t.to);
  } else if (p.kind === "game") api.actions.launch(p.entry.id).catch(() => {});
  else if (p.kind === "divider" && at + 1 < pages.length) goTo(at + 1);
  else {
    const link = spread.querySelector(`.fr-cat-sheet[data-page="${at}"] .fr-cat-ad.is-link`);
    if (link) goTo(Number(link.dataset.to));
  }
}

function focusBox() {
  const target = pages[at]?.kind === "contents" ? spread.querySelector(".fr-cat-toc-line.is-focus") : at % 2 ? slotR : slotL;
  if (!target) return null;
  const r = target.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

/** Back returns to the Contents, on the page that lists the current article. */
function onNav(e) {
  if (e.name !== "back" || !root || !spread.contains(document.activeElement)) return;
  if (at >= cFirst && at < cFirst + cCount) return;
  e.preventDefault();
  const id = pages[at]?.kind === "game" ? pages[at].entry.id : null;
  const line = id ? toc.findIndex((t) => t.line.entry?.id === id) : -1;
  if (line >= 0) {
    tocAt = line;
    goTo(toc[line].page, { toc: line });
  } else goTo(cFirst);
}

/** Contents lines per column at the current size. */
function measure() {
  const em = parseFloat(getComputedStyle(book).fontSize) || 14;
  const h = slotL.clientHeight;
  return Math.max(8, Math.floor((h - em * 10.4) / (em * 0.92 * 1.62)));
}

// ---- view -----------------------------------------------------------------------------------

export default {
  mount(el_, vellum) {
    api = vellum;
    root = el("div", "fr-cat");
    book = el("div", "fr-cat-book");
    spread = el("div", "fr-cat-spread");
    spread.tabIndex = 0;
    spread.setAttribute("data-vellum-focus", "");
    spread.setAttribute("data-vellum-focus-default", "");
    spread.setAttribute("aria-label", "Catalogue");
    spread.vellumNav = nav;
    spread.vellumFocusBox = focusBox;
    spread.vellumEnter = () => markAt();
    spread.vellumConfirm = confirm;
    slotL = el("section", "fr-cat-page fr-cat-left");
    slotR = el("section", "fr-cat-page fr-cat-right");
    for (const slot of [slotL, slotR]) {
      slot.addEventListener("click", () => {
        const i = Number(slot.firstChild?.dataset.page);
        if (!busy && Number.isFinite(i) && i !== at) {
          setAt(i);
          markAt();
        }
      });
    }
    cast = el("div", "fr-cat-cast");
    layer = el("div", "fr-cat-leaves");
    spread.append(slotL, el("div", "fr-cat-gutter"), slotR, grip(-1), grip(1), cast, layer);
    tabs = el("nav", "fr-cat-tabs");
    tabs.setAttribute("aria-label", "Departments");
    book.append(el("div", "fr-cat-edge is-left"), el("div", "fr-cat-edge is-right"), spread, tabs);
    root.append(book);
    el_.append(root);

    const s = vellum.state.get();
    key = JSON.stringify([s.query, s.filters, s.sort, s.groupBy]);
    paginate();

    // Resume where the reader left off: the saved page if nothing was picked since, else the
    // selected game, else the Contents.
    let saved = null;
    try {
      saved = vellum.skin.storage.get("catalogue.at", null);
    } catch {
      saved = null;
    }
    const sel = s.selectedId;
    let start = cFirst;
    if (saved && saved.sel === sel && saved.page < pages.length) start = saved.page;
    else if (sel && byId.has(sel)) start = byId.get(sel);
    lastSel = sel;

    let opened = true;
    try {
      opened = sessionStorage.getItem(SESSION_KEY) === "1";
      sessionStorage.setItem(SESSION_KEY, "1");
    } catch {
      opened = true;
    }
    renderTabs();
    // Busy until the first spread (or the cover) is up, a frame from now: input in between waits
    // for it instead of being overtaken by it.
    begin();
    requestAnimationFrame(() => {
      if (!root) return;
      const n = measure();
      if (n !== perCol) {
        perCol = n;
        paginate();
        renderTabs();
        if (start >= pages.length) start = cFirst;
      }
      if (!opened && !still()) {
        at = 0;
        void openCover(start);
      } else {
        setAt(start);
        showSpread();
        end();
      }
    });
    resize = new ResizeObserver(() => {
      if (!root) return;
      const n = measure();
      if (n !== perCol) {
        perCol = n;
        rebuild();
      }
    });
    resize.observe(book);
    librarySig = pagesSignature();
    unsubs = [vellum.library.on("change", onLibrary), vellum.skin.on("options", () => rebuild()), vellum.input.on("nav", onNav)];
  },

  onState(s) {
    if (!root) return;
    const k = JSON.stringify([s.query, s.filters, s.sort, s.groupBy]);
    if (k !== key) {
      const queryChanged = JSON.parse(key)[0] !== s.query;
      key = k;
      rebuild(queryChanged ? "query" : undefined);
      return;
    }
    // Selected elsewhere (search, another view, the harness): turn to it.
    if (s.selectedId && s.selectedId !== lastSel) {
      lastSel = s.selectedId;
      if (byId.has(s.selectedId) && byId.get(s.selectedId) !== at) goTo(byId.get(s.selectedId));
    }
  },

  unmount() {
    unsubs.forEach((u) => u());
    unsubs = [];
    resize?.disconnect();
    root = book = spread = slotL = slotR = layer = cast = tabs = null;
    busy = false;
    pending = null;
    dirty = false;
    drag = null;
  },
};
