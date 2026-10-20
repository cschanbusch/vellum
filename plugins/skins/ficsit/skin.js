// FICSIT Terminal: the status strip, clock, corporate notices and the boot sequence.
import vellum from "/__vellum/sdk.js";

const $ = (s) => document.querySelector(s);

// Corporate notices. Written for this skin.
const NOTICES = [
  "FICSIT reminds you: an idle library is an inefficient library.",
  "Leisure is a permitted secondary output. Please keep it below quota.",
  "Every game launched is one step closer to project completion.",
  "Hard hats are recommended in all play areas.",
  "FICSIT values you, Pioneer. Within reason.",
  "Lost a game? FICSIT has already catalogued it. FICSIT catalogues everything.",
  "Reminder: unplayed assets depreciate. Please play responsibly.",
  "Efficiency is its own reward. Snacks are a separate reward, sold separately.",
  "Your backlog has been flagged for optimization.",
  "FICSIT does not waste. Neither should your evenings.",
];

// ---- status strip --------------------------------------------------------------------------

function updateStatus() {
  const s = vellum.state.get();
  const n = vellum.library.query().length;
  $(".fx-count").textContent = n.toLocaleString();
  const e = s.selectedId ? vellum.library.get(s.selectedId) : null;
  $(".fx-selected").textContent = e ? e.title : "—";
}

function tickClock() {
  const d = new Date();
  const p = (v) => String(v).padStart(2, "0");
  $(".fx-clock").textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}  //  SHIFT ${Math.floor(d.getHours() / 8) + 1}`;
}

// ---- ticker --------------------------------------------------------------------------------

let notice = Math.floor(Math.random() * NOTICES.length);
function nextNotice() {
  const el = $(".fx-ticker-text");
  notice = (notice + 1) % NOTICES.length;
  el.textContent = NOTICES[notice];
  el.classList.remove("run");
  void el.offsetWidth; // restart the scroll animation
  el.classList.add("run");
}

// ---- boot sequence -------------------------------------------------------------------------

async function boot() {
  const overlay = $(".fx-boot");
  const log = $(".fx-boot-log");
  const bar = $(".fx-boot-bar i");
  let seen = false;
  try {
    seen = sessionStorage.getItem("vellum:ficsit:booted") === "1";
    sessionStorage.setItem("vellum:ficsit:booted", "1");
  } catch {
    // no session storage: boot every time
  }
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (seen || reduced || vellum.skin.options.boot === false) return;
  const total = vellum.library.all().length;
  const lines = [
    "FICSIT OS 4.2.7  (c) FICSIT Inc. All rights reserved. All lefts reserved.",
    "Verifying pioneer credentials ........ OK",
    "Mounting asset manifest ............... OK",
    `Indexing assets ....................... ${total.toLocaleString()} FOUND`,
    "Calibrating leisure throughput ........ NOMINAL",
    "Welcome back, Pioneer.",
  ];
  overlay.hidden = false;
  const skip = () => overlay.classList.add("done");
  overlay.addEventListener("click", skip, { once: true });
  addEventListener("keydown", skip, { once: true });
  for (let i = 0; i < lines.length && !overlay.classList.contains("done"); i++) {
    log.textContent += (i ? "\n" : "") + lines[i];
    bar.style.width = `${((i + 1) / lines.length) * 100}%`;
    await new Promise((r) => setTimeout(r, i === lines.length - 1 ? 450 : 210));
  }
  overlay.classList.add("done");
  setTimeout(() => (overlay.hidden = true), 500);
}

// ---- options --------------------------------------------------------------------------------

function applyOptions() {
  const o = vellum.skin.options;
  document.documentElement.toggleAttribute("data-fx-still", o.motion === false);
  $(".fx-ticker").hidden = o.ticker === false;
}

tickClock();
setInterval(tickClock, 1000);
await vellum.ready();
applyOptions();
updateStatus();
nextNotice();
$(".fx-ticker-text").addEventListener("animationend", nextNotice);
vellum.state.on("change", updateStatus);
vellum.library.on("change", updateStatus);
vellum.skin.on("options", applyOptions);
void boot();
