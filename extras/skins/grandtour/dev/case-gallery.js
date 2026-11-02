// The case gallery: every profile, each with mock games built to be awkward, composed by the case
// builder exactly as the Garage does it. It needs only the dev harness's art routes (no SDK), so
// it opens as a plain page on the skin origin.
import { loadCases, requestWrap } from "../case-builder/compose.js";

const art = (n) => {
  const id = `mock:mock-${String(n).padStart(4, "0")}`;
  return Object.fromEntries(["cover", "hero", "logo", "header", "icon"].map((k) => [k, `/__vellum/art/${encodeURIComponent(id)}/${k}`]));
};
const status = (overrides = {}) => ({ cover: "local", hero: "local", logo: "local", header: "local", icon: "local", ...overrides });
const source = (provider, providerName) => ({ provider, providerName, gameId: `${provider}:x`, capabilities: ["launch"] });

const META = {
  developer: "Quiet Fox",
  publisher: "Starling Works",
  releaseDate: "2019-04-12",
  genres: ["Racing", "Simulation"],
  description:
    "A racing game from Quiet Fox. Tune a garage of cars across forty circuits, from coastal sprints to the long night endurance race, with weather that changes lap by lap and a career that remembers every scrape.",
};

const GAMES = [
  { label: "Complete art, one store", title: "Golden Harbor", n: 2, sources: [source("steam", "Steam")] },
  { label: "Placeholder cover (hero + logo instead)", title: "Iron Meridian", n: 5, status: { cover: "placeholder" }, sources: [source("epic", "Epic Games")] },
  { label: "Placeholder cover and no logo (title set in type)", title: "The Wandering Citadel: The Long Night", n: 7, status: { cover: "placeholder", logo: "placeholder" }, sources: [source("gog", "GOG")] },
  { label: "No art at all", title: "Hollow Signal", n: 9, status: { cover: "placeholder", hero: "placeholder", logo: "placeholder", header: "placeholder", icon: "placeholder" }, sources: [source("xbox", "Xbox")] },
  { label: "No description", title: "Distant Orbit", n: 11, meta: { description: undefined }, sources: [source("steam", "Steam")] },
  {
    label: "85-character title, no logo",
    title: "The Endless Frozen Lighthouse Chronicles: Remastered Definitive Collector's Edition 3",
    n: 13,
    status: { logo: "placeholder" },
    sources: [source("pcsx2", "PCSX2")],
  },
  { label: "Three merged sources", title: "Crimson Atlas Tactics", n: 15, sources: [source("steam", "Steam"), source("epic", "Epic Games"), source("gog", "GOG")] },
];

function entry(g) {
  return {
    id: `gallery:${g.n}:${g.title}`,
    title: g.title,
    sources: g.sources,
    preferredSource: g.sources[0].provider,
    metadata: { ...META, ...(g.meta ?? {}) },
    art: art(g.n),
    artStatus: status(g.status),
  };
}

const main = document.getElementById("gallery");
const rich = document.getElementById("rich");

async function render() {
  const cases = await loadCases();
  main.replaceChildren();
  const jobs = [];
  for (const [name, profile] of Object.entries(cases.profiles)) {
    const h = document.createElement("h2");
    h.textContent = `${profile.label} (${name}): ${profile.outer.h} × ${profile.outer.w} × ${profile.outer.d} mm`;
    const row = document.createElement("div");
    row.className = "row";
    main.append(h, row);
    // Every store on this form, so the gallery shows each profile with each store's colors.
    const options = { caseSteam: name, caseEpic: name, caseGog: name, caseXbox: name, casePcsx2: name, caseOther: name, richBacks: rich.checked };
    for (const g of GAMES) {
      const fig = document.createElement("figure");
      const img = document.createElement("img");
      img.alt = `${g.title}: ${name} wrap`;
      const cap = document.createElement("figcaption");
      cap.innerHTML = `<b>${g.label}</b> · ${g.sources.map((s) => s.providerName).join(", ")}`;
      fig.dataset.profile = name;
      fig.append(img, cap);
      row.append(fig);
      jobs.push(
        requestWrap(entry(g), "medium", { cases, options, providers: [] }, 0).then(
          (rec) => {
            img.src = URL.createObjectURL(rec.wrap);
            fig.dataset.ready = "1";
          },
          (err) => {
            fig.classList.add("is-error");
            cap.append(` · failed: ${err.message}`);
          },
        ),
      );
    }
  }
  await Promise.allSettled(jobs);
  document.body.dataset.ready = "1";
}

rich.addEventListener("change", () => void render());
void render();
