// Basis skin, Phase 2: a plain List view built only on the SDK. Enter or double-click
// launches; arrow keys move the selection; the selection lives in shell state, so it
// survives a skin reload.
import vellum from "/__vellum/sdk.js";

const tbody = document.querySelector("#list tbody");
const count = document.getElementById("count");
const empty = document.getElementById("empty");

const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"];
function formatSize(bytes) {
  if (!bytes) return "";
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < SIZE_UNITS.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${SIZE_UNITS[i]}`;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const formatWhen = (iso) => (iso ? dateFormat.format(new Date(iso)) : "Never");

let rows = [];

function cell(text, className) {
  const td = document.createElement("td");
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function render() {
  const entries = vellum.library.query();
  const selected = vellum.state.get().selectedId;
  count.textContent = `${entries.length} game${entries.length === 1 ? "" : "s"}`;

  const providers = vellum.providers.list();
  empty.hidden = entries.length > 0;
  if (!entries.length) {
    empty.textContent = providers.some((p) => p.state === "scanning")
      ? "Looking for installed games…"
      : providers.some((p) => p.state === "inactive")
        ? "A store's folder couldn't be found. Use Browse… above to point Vellum at it."
        : "No installed games found. Enable a provider in Settings → Plugins.";
  }

  const frag = document.createDocumentFragment();
  rows = entries.map((e) => {
    const tr = document.createElement("tr");
    tr.dataset.id = e.id;
    tr.tabIndex = -1;
    tr.setAttribute("aria-selected", String(e.id === selected));

    const title = cell(e.title, "title");
    if (e.favorite) {
      const star = document.createElement("span");
      star.className = "tag";
      star.textContent = "★";
      title.append(star);
    }
    tr.append(
      title,
      cell(e.sources.map((s) => s.providerName).join(", ")),
      cell(formatSize(e.sizeBytes), "num"),
      cell(formatWhen(e.lastLaunched)),
    );
    const playCell = document.createElement("td");
    const play = document.createElement("button");
    play.className = "play";
    play.textContent = "Play";
    play.addEventListener("click", (ev) => {
      ev.stopPropagation();
      launch(e.id);
    });
    playCell.append(play);
    tr.append(playCell);

    tr.addEventListener("click", () => select(e.id));
    tr.addEventListener("dblclick", () => launch(e.id));
    frag.append(tr);
    return tr;
  });
  tbody.replaceChildren(frag);
  rows.find((r) => r.dataset.id === selected)?.scrollIntoView({ block: "nearest" });
}

function select(id) {
  vellum.state.set({ selectedId: id });
}

function launch(id) {
  vellum.actions.launch(id).catch(() => {
    // The shell already showed an error toast.
  });
}

document.addEventListener("keydown", (e) => {
  const ids = rows.map((r) => r.dataset.id);
  if (!ids.length) return;
  const current = ids.indexOf(vellum.state.get().selectedId);
  const move = (delta) => {
    e.preventDefault();
    const next = Math.max(0, Math.min(ids.length - 1, current < 0 ? 0 : current + delta));
    select(ids[next]);
  };
  switch (e.key) {
    case "ArrowDown": return move(1);
    case "ArrowUp": return move(-1);
    case "PageDown": return move(10);
    case "PageUp": return move(-10);
    case "Home": return move(-ids.length);
    case "End": return move(ids.length);
    case "Enter":
      if (current >= 0) {
        e.preventDefault();
        launch(ids[current]);
      }
  }
});

/** Selection changes only touch attributes, so rows (and double-clicks on them) survive. */
function updateSelection() {
  const selected = vellum.state.get().selectedId;
  for (const r of rows) {
    const on = r.dataset.id === selected;
    r.setAttribute("aria-selected", String(on));
    if (on) r.scrollIntoView({ block: "nearest" });
  }
}

await vellum.ready();
render();
vellum.library.on("change", render);
vellum.state.on("change", updateSelection);
vellum.providers.on("change", render);
