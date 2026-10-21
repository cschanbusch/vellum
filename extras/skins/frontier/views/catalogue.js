// Frontier's Catalogue view: the library as a frontier mail-order catalogue, after the shop
// catalogues in Red Dead Redemption 2. Fan-made; no game assets.
//
// An open book. The left page is a priced listing: engraved plates (the cover drawn as a
// pencil sketch and printed into the paper), catalogue numbers, dotted leaders. The right page
// is the plate of the selected article: a large engraving, wood type, a description with a
// drop cap, specifications and an order button. Departments (genres, the current grouping or
// letter ranges) are leather thumb-index tabs on the fore-edge. The selected article is circled
// in red pencil. Arrows move through the listing and turn the page at its edges; Page Up/Down
// jump between departments.

let api = null;
let root = null;
let book = null;
let left = null;
let listing = null;
let plate = null;
let tabs = null;
let unsubs = [];
let resize = null;

let depts = []; // { label, heading, entries, firstPage }
let pages = []; // { dept, entries, first, folio }
let page = 0;
let sel = 0; // index on the page
let rows = 4;
let key = "";
let plateFor = "";

const COLS = 2;

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

function weight(bytes) {
  if (!bytes) return "—";
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb >= 10 ? Math.round(gb) : gb.toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

function year(e) {
  return e.metadata.releaseDate?.slice(0, 4) ?? null;
}

function dateline(iso) {
  if (!iso) return "Not yet enjoyed";
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

const installed = (e) => e.sources.some((s) => s.installDir);
const maker = (e) => e.metadata.developer ?? e.metadata.publisher ?? null;
const stores = (e) => [...new Set(e.sources.map((s) => s.providerName))].join(" & ");

/** Period copy for articles the store gives no description for. */
const BLURBS = [
  (e, g) => `A ${g} amusement of the first quality, warranted to give entire satisfaction or your money cheerfully refunded. Handsomely finished and packed with care.`,
  (e, g) => `Our most popular ${g} diversion this season. Thousands sold to satisfied customers in every state and territory. Sturdily made; will last a lifetime with ordinary care.`,
  (e, g) => `Recommended by gentlemen and ladies of discernment. A ${g} entertainment for the long winter evenings, guaranteed free from defects of material and workmanship.`,
  (e, g) => `Imported at great expense and offered at a price within the reach of all. A thoroughly modern ${g} pastime, approved by the best authorities.`,
  (e, g) => `The genuine article; beware of cheap imitations. A ${g} recreation of superior grade, every one carefully inspected before leaving our warehouse.`,
];

function description(e) {
  if (e.metadata.description) return e.metadata.description;
  const g = (e.metadata.genres?.[0] ?? "parlour").toLowerCase();
  return BLURBS[hash(e.id) % BLURBS.length](e, g);
}

/** Listing plates are engravings unless the user turned that off; then the skin's art style applies. */
const plateStyle = () => (api.skin.options.engravings === false ? undefined : "sketch");

/** The large figure: a hand-coloured (watercolor) plate by default, as catalogues tinted their
 *  feature engravings; or an engraving; or the skin's art style ("skin"). */
function figureStyle() {
  const v = api.skin.options.figureArt ?? "watercolor";
  return v === "skin" ? undefined : v;
}

// ---- departments and pages ------------------------------------------------------------------

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

function paginate() {
  const per = rows * COLS;
  pages = [];
  depts.forEach((d, di) => {
    d.firstPage = pages.length;
    let i = 0;
    let first = true;
    while (i < d.entries.length || first) {
      const cap = first ? per - COLS : per; // the department heading takes a row
      pages.push({ dept: di, entries: d.entries.slice(i, i + cap), first, start: i });
      i += cap;
      first = false;
      if (!d.entries.length) break;
    }
  });
  pages.forEach((p, i) => (p.folio = i * 2 + 7));
}

/** Rebuilds departments and pages, keeping the selected article in view. */
function rebuild() {
  if (!root) return;
  depts = departments(api.library.query());
  paginate();
  if (!locate(api.state.get().selectedId)) {
    page = Math.min(page, Math.max(0, pages.length - 1));
    sel = 0;
  }
  renderAll();
}

/** Moves to the page holding `id`; false if it isn't in the catalogue. */
function locate(id) {
  if (!id) return false;
  for (let p = 0; p < pages.length; p++) {
    const i = pages[p].entries.findIndex((e) => e.id === id);
    if (i >= 0) {
      page = p;
      sel = i;
      return true;
    }
  }
  return false;
}

const current = () => pages[page]?.entries[sel] ?? null;

// ---- rendering ------------------------------------------------------------------------------

function renderAll() {
  renderListing();
  renderPlate(true);
  renderTabs();
}

function catNo(p, i) {
  const pg = pages[p];
  return `${pg.dept + 1}-${String(pg.start + i + 101)}`;
}

function cut(e, cls, kind, width, style = plateStyle()) {
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

function renderListing() {
  const p = pages[page];
  const sheet = el("div", "fr-cat-sheet");
  const running = el("header", "fr-cat-running");
  running.append(el("span", null, "Vellum & Co."), el("span", "fr-cat-running-dept", p ? depts[p.dept].heading : ""), el("span", null, "Catalogue No. 1899"));
  sheet.append(running);

  if (!p || !depts.length) {
    const none = el("div", "fr-cat-none");
    none.append(el("p", "fr-cat-none-big", "Regret to inform"), el("p", null, "No goods in our warehouse answer to your enquiry. Kindly amend your order and try again."));
    sheet.append(none);
  } else {
    if (p.first) {
      const d = depts[p.dept];
      const band = el("div", "fr-cat-band");
      band.append(el("h2", "fr-cat-band-title", d.heading), el("p", "fr-cat-band-sub", `${d.entries.length} article${d.entries.length === 1 ? "" : "s"} · carriage paid to any railway station`));
      sheet.append(band);
    }
    const ol = el("ol", "fr-cat-items");
    ol.style.setProperty("--rows", String(p.first ? rows - 1 : rows));
    p.entries.forEach((e, i) => {
      const li = el("li", "fr-cat-item");
      li.dataset.i = String(i);
      if (i === sel) li.classList.add("is-selected");
      if (e.favorite) li.classList.add("is-favorite");
      const copy = el("div", "fr-cat-copy");
      copy.append(el("div", "fr-cat-no", `No. ${catNo(page, i)}`), el("h3", "fr-cat-title", e.title));
      const by = [maker(e), year(e)].filter(Boolean).join(", ");
      copy.append(el("p", "fr-cat-maker", by || stores(e)));
      const price = el("p", "fr-cat-price");
      price.append(el("span", null, "Shipping wt."), el("i", "fr-cat-leader"), el("b", null, weight(e.sizeBytes)));
      copy.append(price);
      li.append(cut(e, "fr-cat-cut", "cover", 160), copy);
      li.addEventListener("click", () => select(i));
      li.addEventListener("dblclick", () => api.actions.launch(e.id).catch(() => {}));
      ol.append(li);
    });
    sheet.append(ol);
  }
  const folio = el("footer", "fr-cat-folio", p ? `— ${p.folio} —` : "");
  sheet.append(folio);
  listing.replaceChildren(sheet);
}

function renderPlate(force = false) {
  const e = current();
  const id = e?.id ?? "";
  if (!force && id === plateFor) return;
  plateFor = id;
  const sheet = el("div", "fr-cat-sheet");
  const running = el("header", "fr-cat-running");
  running.append(el("span", null, pages[page] ? depts[pages[page].dept].label : ""), el("span", null, "Illustrated Plates"), el("span", null, "Vellum & Co."));
  sheet.append(running);
  if (!e) {
    const orn = el("div", "fr-cat-ornament-page");
    orn.append(el("p", "fr-cat-none-big", "Vellum & Co."), el("p", null, "Purveyors of fine amusements since 1899"));
    sheet.append(orn);
    plate.replaceChildren(sheet);
    return;
  }
  const art = e.artStatus.hero === "placeholder" && e.artStatus.cover !== "placeholder" ? "cover" : "hero";
  const fig = cut(e, `fr-cat-engraving is-${art}`, art, 1280, figureStyle());
  if (figureStyle() === "watercolor") fig.classList.add("is-coloured");
  fig.append(el("span", "fr-cat-fig", `Fig. ${catNo(page, sel).split("-")[1]}.`));
  sheet.append(fig);

  const title = el("h2", "fr-cat-plate-title", e.title);
  if (e.title.length > 26) title.classList.add("is-long");
  sheet.append(title);
  const byline = [
    e.metadata.developer ? `Manufactured by ${e.metadata.developer}` : null,
    e.metadata.publisher && e.metadata.publisher !== e.metadata.developer ? `sold by ${e.metadata.publisher}` : null,
  ].filter(Boolean);
  sheet.append(el("p", "fr-cat-byline", byline.length ? byline.join(", ") : `Supplied through ${stores(e)}`));
  sheet.append(el("div", "fr-cat-rule"));
  sheet.append(el("p", "fr-cat-desc", description(e)));

  const specs = el("dl", "fr-cat-specs");
  const row = (k, v) => {
    const d = el("div");
    d.append(el("dt", null, k), el("i", "fr-cat-leader"), el("dd", null, v));
    specs.append(d);
  };
  row("Catalogue No.", catNo(page, sel));
  row("Department", e.metadata.genres?.slice(0, 2).join(", ") || depts[pages[page].dept].label);
  if (year(e)) row("Established", year(e));
  row("Purveyor", stores(e));
  row("Shipping weight", weight(e.sizeBytes));
  row("Last enjoyed", dateline(e.lastLaunched));
  sheet.append(specs);

  // The order blank at the foot of the page, to be cut out along the dotted line.
  const order = el("div", "fr-cat-order");
  const head = el("div", "fr-cat-order-head");
  head.append(el("span", "fr-cat-scissors", "✂"), el("span", null, "Order Blank"), el("span", null, "Vellum & Co., Purveyors"));
  const line = el("p", "fr-cat-order-line");
  const field = (text) => el("span", "fr-cat-field", text);
  line.append("Please forward at once Article No. ", field(catNo(page, sel)), ", ", field(e.title), ", by ", field(stores(e)), ".");
  const actions = el("div", "fr-cat-actions");
  const play = document.createElement("vellum-play-button");
  play.entry = e;
  const want = el("button", "fr-cat-want", e.favorite ? "✓ On your want list" : "Add to want list");
  want.setAttribute("data-vellum-focus", "");
  want.setAttribute("aria-pressed", String(e.favorite));
  want.addEventListener("click", () => api.actions.toggleFavorite(e.id));
  actions.append(play, want, el("span", "fr-cat-signed", "Signed, the Proprietor"));
  order.append(head, line, actions);
  const stamp = el("div", `fr-cat-stamp ${installed(e) ? "is-stock" : "is-order"}`, installed(e) ? "In Stock" : "Special Order");
  stamp.style.setProperty("--tilt", `${(hash(e.id) % 9) - 12}deg`);
  sheet.append(stamp, order);

  plate.replaceChildren(sheet);
}

function renderTabs() {
  const at = pages[page]?.dept ?? -1;
  tabs.replaceChildren(
    ...depts.map((d, i) => {
      const b = el("button", "fr-cat-tab");
      b.append(el("span", null, d.label));
      b.title = d.heading;
      b.setAttribute("data-vellum-focus", "");
      b.style.setProperty("--hue", String((i * 37) % 360));
      if (i === at) b.setAttribute("aria-current", "page");
      b.addEventListener("click", () => goPage(d.firstPage, 0, i > at ? "next" : "prev"));
      return b;
    }),
  );
}

// ---- selection and page turns ---------------------------------------------------------------

function markSelection() {
  for (const li of listing.querySelectorAll(".fr-cat-item")) li.classList.toggle("is-selected", Number(li.dataset.i) === sel);
}

function select(i) {
  const p = pages[page];
  if (!p || i < 0 || i >= p.entries.length) return;
  sel = i;
  markSelection();
  renderPlate();
  void api.state.set({ selectedId: p.entries[i].id });
}

function goPage(p, i, dir) {
  if (p < 0 || p >= pages.length) return false;
  const turned = p !== page;
  page = p;
  sel = Math.max(0, Math.min(i, pages[p].entries.length - 1));
  renderListing();
  renderTabs();
  if (turned && dir) turn(dir);
  select(sel);
  return true;
}

/** A leaf passing over the page: the new page is uncovered from the gutter (or the fore-edge). */
function turn(dir) {
  left.classList.remove("turn-next", "turn-prev");
  void left.offsetWidth; // restart the animation
  left.classList.add(dir === "next" ? "turn-next" : "turn-prev");
}

function nav(dir) {
  const p = pages[page];
  if (!p || !p.entries.length) return false;
  const n = p.entries.length;
  const col = sel % COLS;
  const row = Math.floor(sel / COLS);
  switch (dir) {
    case "right":
      if (col < COLS - 1 && sel + 1 < n) return select(sel + 1), true;
      return goPage(page + 1, row * COLS, "next");
    case "left":
      if (col > 0) return select(sel - 1), true;
      return goPage(page - 1, row * COLS + 1, "prev");
    case "down":
      if (sel + COLS < n) return select(sel + COLS), true;
      if (row < Math.ceil(n / COLS) - 1) return select(n - 1), true;
      return goPage(page + 1, col, "next");
    case "up":
      if (sel - COLS >= 0) return select(sel - COLS), true;
      return false; // leave for the toolbar
    case "pageDown": {
      const d = p.dept + 1;
      if (d < depts.length) goPage(depts[d].firstPage, 0, "next");
      return true;
    }
    case "pageUp": {
      const d = page === depts[p.dept].firstPage ? p.dept - 1 : p.dept;
      if (d >= 0) goPage(depts[d].firstPage, 0, "prev");
      return true;
    }
  }
  return false;
}

function itemBox(i) {
  const li = listing.querySelector(`.fr-cat-item[data-i="${i}"]`);
  if (!li) return null;
  const r = li.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

function enter(from) {
  const p = pages[page];
  if (!p || !p.entries.length) return;
  if (!from) return select(Math.min(sel, p.entries.length - 1));
  const cx = (from.left + from.right) / 2;
  const cy = (from.top + from.bottom) / 2;
  let best = sel;
  let bestD = Infinity;
  p.entries.forEach((_, i) => {
    const b = itemBox(i);
    if (!b) return;
    const d = Math.abs((b.left + b.right) / 2 - cx) + 2 * Math.abs((b.top + b.bottom) / 2 - cy);
    if (d < bestD) [bestD, best] = [d, i];
  });
  select(best);
}

/** Rows that fit on a page at the current size. */
function measureRows() {
  const em = parseFloat(getComputedStyle(book).fontSize) || 14;
  const h = left.clientHeight - em * 6.6; // running head, folio and page margins
  return Math.max(2, Math.min(6, Math.floor(h / (em * 8.6))));
}

// ---- view -----------------------------------------------------------------------------------

export default {
  mount(el_, vellum) {
    api = vellum;
    root = el("div", "fr-cat");
    book = el("div", "fr-cat-book");
    left = el("section", "fr-cat-page fr-cat-left");
    listing = el("div", "fr-cat-listing");
    listing.tabIndex = 0;
    listing.setAttribute("data-vellum-focus", "");
    listing.setAttribute("data-vellum-focus-default", "");
    listing.setAttribute("role", "listbox");
    listing.setAttribute("aria-label", "Catalogue");
    listing.vellumNav = nav;
    listing.vellumFocusBox = () => itemBox(sel);
    listing.vellumEnter = (from) => enter(from);
    listing.vellumConfirm = () => {
      const e = current();
      if (e) api.actions.launch(e.id).catch(() => {});
    };
    left.append(listing, el("div", "fr-cat-curl"));
    left.addEventListener("animationend", () => left.classList.remove("turn-next", "turn-prev"));
    plate = el("section", "fr-cat-page fr-cat-right");
    tabs = el("nav", "fr-cat-tabs");
    tabs.setAttribute("aria-label", "Departments");
    book.append(left, el("div", "fr-cat-gutter"), plate, tabs);
    root.append(book);
    el_.append(root);

    const s = vellum.state.get();
    key = JSON.stringify([s.query, s.filters, s.sort, s.groupBy]);
    rows = 4;
    rebuild();
    requestAnimationFrame(() => {
      if (!root) return;
      rows = measureRows();
      rebuild();
    });
    resize = new ResizeObserver(() => {
      if (!root) return;
      const r = measureRows();
      if (r !== rows) {
        rows = r;
        rebuild();
      }
    });
    resize.observe(left);
    unsubs = [vellum.library.on("change", rebuild), vellum.skin.on("options", () => renderAll())];
  },

  onState(s) {
    if (!root) return;
    const k = JSON.stringify([s.query, s.filters, s.sort, s.groupBy]);
    if (k !== key) {
      key = k;
      rebuild();
      return;
    }
    // Selected elsewhere (search, another view, the harness): follow it.
    if (s.selectedId && s.selectedId !== current()?.id) {
      const before = page;
      if (locate(s.selectedId)) {
        if (before !== page) {
          renderListing();
          renderTabs();
        } else markSelection();
        renderPlate();
      }
    }
  },

  unmount() {
    unsubs.forEach((u) => u());
    unsubs = [];
    resize?.disconnect();
    root = book = left = listing = plate = tabs = null;
    plateFor = "";
  },
};
