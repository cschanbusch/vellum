// Grand Tour's soundtracks. music/ holds songs, each a MIDI file per view named
// <song>.<view>.mid (expressway.garage.mid, expressway.covers.mid...), and one SoundFont for all
// of them. Each launch of Vellum picks one song and plays only its files until Vellum closes; a
// new launch picks again, a different song where there is more than one. A view the song has no
// file for is silent. When the music first starts, a plate on the footer's left end names the
// song for a few seconds, then folds into a music note button. The button (or M) opens a list of
// the songs: it shows what's playing, and choosing another switches to it from its beginning.
import vellum from "/__vellum/sdk.js";
import { modalOpen } from "./modal.js";
import { ui } from "./sound.js";

const FOLDER = "music";
const THIS_LAUNCH = "rl-song"; // sessionStorage: kept through skin reloads, gone when Vellum closes
const LAST_LAUNCH = "rl-song-last"; // localStorage: so the next launch picks another
const ANNOUNCED = "rl-song-shown"; // sessionStorage: the plate shows once per launch
const SHOW_MS = 4200;

const path = (name) => `${FOLDER}/${encodeURIComponent(name)}`;

function store(kind) {
  try {
    return kind === "session" ? sessionStorage : localStorage;
  } catch {
    return null; // storage blocked: a new pick each time
  }
}

/** The songs in music/: song -> { view: path }, and the SoundFont's path. */
async function catalogue() {
  let names = [];
  try {
    const r = await fetch(`/__vellum/skin-files/${FOLDER}`);
    if (r.ok) names = await r.json();
  } catch {
    // no listing: no music
  }
  const songs = new Map();
  for (const n of names) {
    const m = n.match(/^(.+)\.([^.]+)\.midi?$/i);
    if (!m) continue;
    const song = m[1].toLowerCase();
    if (!songs.has(song)) songs.set(song, {});
    songs.get(song)[m[2].toLowerCase()] = path(n);
  }
  const bank = names.find((n) => /\.(sf2|sf3|dls)$/i.test(n));
  return { songs, soundbank: bank ? path(bank) : null };
}

/** This launch's song: the one already picked, else a random one (not last launch's if
 *  there's a choice). */
function pick(names) {
  const session = store("session");
  const local = store("local");
  const kept = session?.getItem(THIS_LAUNCH);
  if (kept && names.includes(kept)) return kept;
  const last = local?.getItem(LAST_LAUNCH);
  const pool = names.length > 1 ? names.filter((n) => n !== last) : names;
  const song = pool[Math.floor(Math.random() * pool.length)];
  try {
    session?.setItem(THIS_LAUNCH, song);
    local?.setItem(LAST_LAUNCH, song);
  } catch {
    // storage full or blocked: the pick still stands for now
  }
  return song;
}

/** Picks this launch's song and hands it to the music engine (it starts after the title
 *  screen; see skin.js). Does nothing before Vellum 0.3.0, which has no music. */
export async function setupSoundtrack() {
  if (!vellum.music?.configure) return;
  const found = await catalogue();
  if (!found.soundbank || !found.songs.size) return;
  library = found;
  current = pick([...found.songs.keys()].sort());
  document.documentElement.dataset.rlSong = current; // for tests and the curious
  appearOnStart();
  vellum.music.configure(configFor(current));
}

let library = null; // the catalogue
let current = null; // the song playing

/** The engine's setup for a song: its views, and `<view>@top` to enter a view's file at its start
 *  (a change of view picks up where the music is; choosing a song begins it). */
function configFor(song) {
  const files = library.songs.get(song);
  const scenes = { ...files };
  for (const [view, midi] of Object.entries(files)) scenes[`${view}@top`] = { midi, from: 0 };
  return {
    soundbank: library.soundbank,
    autoplay: false,
    at: "beat",
    scenes,
    views: Object.fromEntries(Object.keys(files).map((v) => [v, v])),
  };
}

/** Switches to `song` now. It lasts until Vellum closes, like a song picked at launch. */
function choose(song) {
  if (song === current) return;
  current = song;
  document.documentElement.dataset.rlSong = song;
  try {
    store("session")?.setItem(THIS_LAUNCH, song);
    store("local")?.setItem(LAST_LAUNCH, song);
  } catch {
    // storage full or blocked: it still plays for now
  }
  vellum.music.configure(configFor(song));
  // The music has started, so configure() starts the view's file where the old one had got to;
  // this replaces that before it's heard.
  const view = vellum.state.get().view;
  if (library.songs.get(song)[view]) void vellum.music.play(`${view}@top`, { at: "now" });
  refreshPlate();
  renderList();
}

/** "nightdrive" -> "Nightdrive". */
const title = (song) => song.charAt(0).toUpperCase() + song.slice(1);

/** Brings up the plate once the music has started: spelled out the first time it's heard this
 *  launch, already folded after a skin reload or with the Music volume off. */
function appearOnStart() {
  if (!vellum.music.on) return;
  const off = vellum.music.on("scene", () => {
    off?.();
    const audible = (vellum._internal?.audio?.().music ?? 1) > 0;
    const announce = audible && !store("session")?.getItem(ANNOUNCED);
    try {
      if (announce) store("session")?.setItem(ANNOUNCED, "1");
    } catch {
      // storage blocked: it may spell it out again after a reload
    }
    showPlate(announce);
  });
}

// ---- the plate and its button -------------------------------------------------------------------

let plate = null;
let foldTimer = 0;

function refreshPlate() {
  if (!plate) return;
  plate.querySelector(".rl-song-name").textContent = title(current);
  plate.setAttribute("aria-label", `Music: ${title(current)}. Choose a song`);
}

const fold = () => {
  clearTimeout(foldTimer);
  plate?.classList.add("is-docked");
};

/** It rises out of the footer's left end, holds, and folds leftward into the note button. */
function showPlate(announce) {
  plate = document.createElement("button");
  plate.className = "rl-song";
  plate.type = "button";
  plate.setAttribute("aria-haspopup", "dialog");
  plate.setAttribute("aria-expanded", "false");
  const label = document.createElement("span");
  label.className = "rl-song-label";
  const note = document.createElement("span");
  note.className = "rl-song-note";
  note.textContent = "♪";
  const word = document.createElement("span");
  word.className = "rl-song-word";
  word.textContent = "Now playing";
  label.append(note, word);
  const name = document.createElement("span");
  name.className = "rl-song-name";
  plate.append(label, name);
  refreshPlate();
  plate.addEventListener("click", () => (panel ? closePanel() : openPanel()));
  document.body.append(plate);
  if (!announce) plate.classList.add("is-docked");
  requestAnimationFrame(() => requestAnimationFrame(() => plate.classList.add("is-in")));
  if (announce) foldTimer = setTimeout(fold, SHOW_MS);
}

// ---- the song list -------------------------------------------------------------------------------

let panel = null;
let list = null;

function renderList() {
  if (!list) return;
  const focused = document.activeElement?.dataset?.song;
  list.replaceChildren(
    ...[...library.songs.keys()].sort().map((song) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "rl-music-song";
      b.dataset.song = song;
      const name = document.createElement("span");
      name.textContent = title(song);
      b.append(name);
      if (song === current) {
        b.setAttribute("aria-current", "true");
        const playing = document.createElement("span");
        playing.className = "rl-music-playing";
        playing.textContent = "♪ Playing";
        b.append(playing);
      }
      b.addEventListener("click", () => choose(song));
      return b;
    }),
  );
  (list.querySelector(`[data-song="${CSS.escape(focused ?? current)}"]`) ?? list.firstElementChild)?.focus({ preventScroll: true });
}

function step(by) {
  const items = [...list.children];
  items[(items.indexOf(document.activeElement) + by + items.length) % items.length]?.focus({ preventScroll: true });
}

const outside = (e) => {
  if (!panel?.contains(e.target) && !plate?.contains(e.target)) closePanel();
};

function openPanel() {
  if (panel || !plate) return;
  fold();
  panel = document.createElement("div");
  panel.className = "rl-music";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Music");
  const head = document.createElement("div");
  head.className = "rl-music-head";
  head.textContent = "Music";
  list = document.createElement("div");
  list.className = "rl-music-list";
  panel.append(head, list);
  if ((vellum._internal?.audio?.().music ?? 1) <= 0) {
    const muted = document.createElement("p");
    muted.className = "rl-music-muted";
    muted.textContent = "Music volume is off in Settings";
    panel.append(muted);
  }
  // Keys stop here, so nothing behind the list moves. Enter and Space press the focused song.
  panel.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape" || e.key === "m" || e.key === "M") {
      closePanel();
      ui("back");
    } else if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
      step(1);
      ui("move", "down");
    } else if (e.key === "ArrowUp" || e.key === "Tab") {
      step(-1);
      ui("move", "up");
    } else if (e.key === "Home") list.firstElementChild?.focus();
    else if (e.key === "End") list.lastElementChild?.focus();
    else return;
    e.preventDefault();
  });
  document.body.append(panel);
  plate.setAttribute("aria-expanded", "true");
  addEventListener("pointerdown", outside, true);
  renderList();
}

function closePanel() {
  if (!panel) return;
  panel.remove();
  panel = list = null;
  removeEventListener("pointerdown", outside, true);
  plate.setAttribute("aria-expanded", "false");
  plate.focus({ preventScroll: true });
}

// Controller buttons come as nav events; keyboard keys never get this far while the list is open.
vellum.input.on("nav", (e) => {
  if (!panel) return;
  e.preventDefault();
  if (e.name === "back") closePanel();
  else if (e.name === "up") step(-1);
  else if (e.name === "down") step(1);
  else if (e.name === "confirm") document.activeElement?.click?.();
});

// M opens the list from anywhere, except while typing or with an overlay up.
addEventListener(
  "keydown",
  (e) => {
    if (panel || !plate || modalOpen() || e.repeat || e.ctrlKey || e.altKey || e.metaKey || (e.key !== "m" && e.key !== "M")) return;
    let a = document.activeElement;
    while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
    if (a?.matches?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    openPanel();
    ui("open");
  },
  true,
);
