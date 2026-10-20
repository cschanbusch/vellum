// A little skin code: keep the game count in the title bar up to date, and wire the
// Settings button.
import vellum from "/__vellum/sdk.js";

const el = document.querySelector(".count");
const update = () => {
  const n = vellum.library.query().length;
  el.textContent = `${n} game${n === 1 ? "" : "s"}`;
};
await vellum.ready();
update();
vellum.library.on("change", update);
vellum.state.on("change", update);

// Inline handlers (onclick="…") are blocked by the skin CSP; attach them from a module.
document.querySelector(".settings").addEventListener("click", () => vellum.actions.openSettings());
