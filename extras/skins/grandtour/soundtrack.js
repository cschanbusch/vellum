// Grand Tour's soundtracks. music/ holds songs, each a MIDI file per view named
// <song>.<view>.mid (expressway.garage.mid, expressway.covers.mid...), and one SoundFont for all
// of them. Each launch of Vellum picks one song and plays only its files until Vellum closes; a
// new launch picks again, a different song where there is more than one. A view the song has no
// file for is silent. When the music first starts, a plate on the footer's left end names the
// song for a few seconds.
import vellum from "/__vellum/sdk.js";

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
  const { songs, soundbank } = await catalogue();
  if (!soundbank || !songs.size) return;
  const song = pick([...songs.keys()].sort());
  const scenes = songs.get(song);
  document.documentElement.dataset.rlSong = song; // for tests and the curious
  announceOnStart(song);
  vellum.music.configure({
    soundbank,
    autoplay: false,
    at: "beat",
    scenes,
    views: Object.fromEntries(Object.keys(scenes).map((v) => [v, v])),
  });
}

/** "nightdrive" -> "Nightdrive". */
const title = (song) => song.charAt(0).toUpperCase() + song.slice(1);

/** Names the song once the music is first heard this launch (not after a skin reload, and not
 *  when the Music volume is off). */
function announceOnStart(song) {
  if (store("session")?.getItem(ANNOUNCED) || !vellum.music.on) return;
  const off = vellum.music.on("scene", () => {
    off?.();
    const audible = (vellum._internal?.audio?.().music ?? 1) > 0;
    if (!audible) return;
    try {
      store("session")?.setItem(ANNOUNCED, "1");
    } catch {
      // storage blocked: it may show again after a reload
    }
    show(title(song));
  });
}

/** The plate: it rises out of the footer's left end, holds, and sinks back. */
function show(name) {
  const plate = document.createElement("div");
  plate.className = "rl-song";
  plate.setAttribute("role", "status");
  const label = document.createElement("span");
  label.className = "rl-song-label";
  label.textContent = "Now playing";
  const n = document.createElement("span");
  n.className = "rl-song-name";
  n.textContent = name;
  plate.append(label, n);
  document.body.append(plate);
  requestAnimationFrame(() => requestAnimationFrame(() => plate.classList.add("is-in")));
  setTimeout(() => {
    plate.classList.remove("is-in");
    plate.addEventListener("transitionend", () => plate.remove(), { once: true });
    setTimeout(() => plate.remove(), 800); // in case no transition runs
  }, SHOW_MS);
}
