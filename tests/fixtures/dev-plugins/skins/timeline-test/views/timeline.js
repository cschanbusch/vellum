// A custom view: games grouped by release year, newest first, one cover row per year.
// Uses only the SDK and kit components, through the same contract as the built-in views.

let unsubs = [];
let root = null;

function render(vellum) {
  const byYear = new Map();
  for (const e of vellum.library.query()) {
    const year = e.metadata.releaseDate?.slice(0, 4) ?? "Unknown";
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year).push(e);
  }
  const years = [...byYear.keys()].sort((a, b) => (a === "Unknown" ? 1 : b === "Unknown" ? -1 : b.localeCompare(a)));
  root.replaceChildren(
    ...years.map((year, i) => {
      const section = document.createElement("section");
      section.className = "tl-year";
      const h = document.createElement("h2");
      h.textContent = year;
      h.style.cssText = "margin: 12px var(--v-gap) 0; font: 650 1.1rem var(--v-font-display)";
      const row = document.createElement("vellum-cover-row");
      row.entries = byYear.get(year);
      if (i === 0) row.setAttribute("data-vellum-focus-default", "");
      section.append(h, row);
      return section;
    }),
  );
}

export default {
  mount(el, vellum) {
    root = document.createElement("div");
    root.className = "tl";
    root.style.cssText = "flex:1; overflow-y:auto; padding: 8px 0 32px";
    el.append(root);
    render(vellum);
    unsubs = [vellum.library.on("change", () => render(vellum))];
  },
  onState(state) {
    // Re-render when the query changes, not on every selection.
    const key = JSON.stringify([state.query, state.filters, state.sort]);
    if (key !== this.key) {
      this.key = key;
      if (root) render(window.vellum);
    }
  },
  unmount() {
    unsubs.forEach((u) => u());
    root = null;
  },
};
