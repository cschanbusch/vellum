// Calling Card: ransom-note lettering, and a "target" card for the selected game.
import vellum from "/__vellum/sdk.js";

const FONTS = ["Anton", "Archivo Black", "Bebas Neue"];

/** Stable pseudo-random numbers from a string, so a title always gets the same letters. */
function seeded(text) {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.codePointAt(0), 16777619) >>> 0;
  return () => {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    return h / 4294967296;
  };
}

/**
 * <cc-ransom text="…">: each letter cut from a different "magazine": its own font, size,
 * tilt and paper (black on white, white on black, or red).
 */
class Ransom extends HTMLElement {
  static observedAttributes = ["text"];

  attributeChangedCallback() {
    this.render();
  }

  connectedCallback() {
    this.render();
  }

  render() {
    const text = this.getAttribute("text") ?? "";
    const r = seeded(text);
    this.setAttribute("aria-label", text);
    const frag = document.createDocumentFragment();
    let i = 0;
    for (const word of text.split(/\s+/).filter(Boolean)) {
      const w = document.createElement("span");
      w.className = "cc-word";
      w.setAttribute("aria-hidden", "true");
      for (const ch of word) {
        const s = document.createElement("span");
        const paper = i === 0 ? 1 : Math.floor(r() * 3);
        s.className = `cc-letter p${paper}`;
        s.textContent = i === 0 ? ch.toUpperCase() : r() < 0.35 ? ch.toLowerCase() : ch.toUpperCase();
        s.style.fontFamily = `"${FONTS[Math.floor(r() * FONTS.length)]}", sans-serif`;
        s.style.setProperty("--rot", `${(r() - 0.5) * 16}deg`);
        s.style.setProperty("--scale", `${0.85 + r() * 0.4}`);
        s.style.setProperty("--lift", `${(r() - 0.5) * 0.18}em`);
        w.append(s);
        i++;
      }
      frag.append(w);
    }
    this.replaceChildren(frag);
  }
}
customElements.define("cc-ransom", Ransom);

// The brand, as a ransom note.
const brand = document.createElement("cc-ransom");
brand.setAttribute("text", "Vellum");
brand.className = "cc-brand";

const card = document.querySelector(".cc-card");
const title = card.querySelector(".cc-card-title");
const meta = card.querySelector(".cc-card-meta");
let shown = null;

function updateCard() {
  const s = vellum.state.get();
  const e = s.selectedId ? vellum.library.get(s.selectedId) : null;
  const visible = !!e && vellum.skin.options.card !== false && s.view !== "spotlight";
  card.hidden = !visible;
  if (!visible || e.id === shown) return;
  shown = e.id;
  title.setAttribute("text", e.title);
  const year = e.metadata.releaseDate?.slice(0, 4);
  meta.textContent = [e.metadata.developer, year].filter(Boolean).join(" / ") || e.sources.map((x) => x.providerName).join(" / ");
  // Restart the slam-in animation.
  card.classList.remove("slam");
  void card.offsetWidth;
  card.classList.add("slam");
}

function toggles() {
  const o = vellum.skin.options;
  document.documentElement.toggleAttribute("data-cc-still", o.motion === false);
}

await vellum.ready();
document.querySelector("vellum-app .v-brand")?.replaceChildren(brand);
// <vellum-app> re-renders its own markup; keep the ransom brand in place.
new MutationObserver(() => {
  const b = document.querySelector("vellum-app .v-brand");
  if (b && !b.contains(brand)) b.replaceChildren(brand);
}).observe(document.querySelector("vellum-app"), { childList: true, subtree: true, characterData: true });
toggles();
updateCard();
vellum.state.on("change", updateCard);
vellum.library.on("change", () => {
  shown = null;
  updateCard();
});
vellum.skin.on("options", () => {
  toggles();
  shown = null;
  updateCard();
});
