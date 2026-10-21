// Frontier Catalogue: advertisements.
//
// Period catalogues filled their spare corners with notices: patent remedies, agents wanted,
// goods no one could actually buy. Each entry below is one advertisement. To add one, append an
// object; the catalogue picks from this list, seeded by the library, so the same library always
// gets the same advertisements in the same places.
//
//   id      unique, stable (placement is seeded from it)
//   kind    "novelty" (made-up goods), "library" (about the user's own games) or "house"
//   sizes   where it can go: "full" (a whole page), "box" (a panel in spare space),
//           "strip" (a line across the foot of a game page, Generous mode only)
//   weight  how often it is picked, relative to the others (default 1)
//   when    optional (ctx) => boolean; leave it out to always qualify
//   render  (ctx) => the copy:
//     kicker    small capitals above the headline
//     headline  wood type
//     sub       italic line under the headline
//     body      the copy
//     strip     a one-line version for "strip" (falls back to sub)
//     price     set large, in wood type
//     fine      fine print
//     stamp     a rubber stamp across it, e.g. "Discontinued", "Not Available by Mail"
//     ornament  one of the engravings in textures/ads/ (bottle, hand, telegraph, watch, velocipede, star)
//     art       { entry, kind } to print a library game's art as an engraving instead
//     target    an entry: clicking the advertisement turns to that game's page
//     page      a page index: clicking turns there
//
// ctx gives read-only facts about the catalogue:
//   entries, depts ([{ label, heading, entries, page }]), catNo(e), pageOf(e), weight(bytes),
//   date(iso), neglected(), recent(), newest(), heaviest(), biggestDept()
//
// Write in the voice of an 1899 mail-order house. No real brands, and no game's own assets.

export default [
  // ---- novelty goods ------------------------------------------------------------------------
  {
    id: "eye-tonic",
    kind: "novelty",
    sizes: ["full", "box"],
    weight: 3,
    render: () => ({
      kicker: "Restores the sight!",
      headline: "Dr. Vellum's Patent Eye Tonic",
      sub: "For the screen-weary eye",
      body: "Do your eyes smart after a long evening's campaign? Do the letters swim and the lamps seem dim? A few drops before retiring restore the sight of a hawk. Compounded from rainwater, camphor and optimism.",
      price: "50¢ the bottle",
      fine: "Not to be taken internally. Not to be taken externally either.",
      ornament: "bottle",
    }),
  },
  {
    id: "save-elixir",
    kind: "novelty",
    sizes: ["full", "box"],
    weight: 2,
    render: () => ({
      kicker: "Undo your mistakes",
      headline: "Genuine Save-Point Elixir",
      sub: "One spoonful, and the last half hour never happened",
      body: "Recommended for those who forgot to save before the bridge, the boss or the bandit camp. Pleasant to the taste. Effects are not permanent and may wear off at the worst possible moment.",
      price: "$1.00 the dose",
      stamp: "Not Available by Mail",
      ornament: "bottle",
    }),
  },
  {
    id: "thumb-liniment",
    kind: "novelty",
    sizes: ["full", "box"],
    weight: 2,
    render: () => ({
      kicker: "For sportsmen",
      headline: "Rapid-Fire Thumb Liniment",
      sub: "Relief for the trigger finger",
      body: "Soothes the ache of the trigger finger and the cramp of the thumb-stick. Rub well into the afflicted digit. Results in time for the next match, or your thumb back.",
      price: "25¢ the tin",
      ornament: "hand",
    }),
  },
  {
    id: "telegraph",
    kind: "novelty",
    sizes: ["full", "box"],
    weight: 2,
    render: () => ({
      kicker: "Messages arrive before they are sent",
      headline: "The Lag-Be-Gone Telegraph Improver",
      body: "Fit our patent coil to any wire and your signals travel quicker than lightning, very nearly. Latency reduced or your money returned within the fortnight.",
      price: "$4.75 complete",
      fine: "Withdrawn by order of the Territorial Telegraph Commission.",
      stamp: "Discontinued",
      ornament: "telegraph",
    }),
  },
  {
    id: "patience-pills",
    kind: "novelty",
    sizes: ["full", "box"],
    weight: 2,
    render: () => ({
      kicker: "Calms the nerves",
      headline: "Loading-Screen Patience Pills",
      body: "Effective while the progress bar crawls, the shaders compile and the update arrives at two kilobytes the hour. Take one at every hint that tells you to dodge.",
      price: "Box of 40, 35¢",
      ornament: "watch",
    }),
  },
  {
    id: "speedrun-course",
    kind: "novelty",
    sizes: ["full", "box"],
    render: () => ({
      kicker: "Learn at home",
      headline: "A Correspondence Course in Speedrunning",
      body: "Twelve easy lessons by post teach you to finish any amusement in a fraction of the time, mostly by walking through walls. Diploma suitable for framing.",
      price: "$3.00 the course",
      fine: "Lessons arrive out of order and out of bounds.",
      ornament: "star",
    }),
  },
  {
    id: "velocipede",
    kind: "novelty",
    sizes: ["full", "box"],
    render: () => ({
      kicker: "The marvel of the age",
      headline: "The Vellum Steam Velocipede",
      sub: "Twelve horsepower · brass fittings",
      body: "A whistle heard three counties off, and the fastest thing on two wheels this side of the Mississippi. Every one tested on our own proving ground before shipping.",
      price: "$1,250.00",
      fine: "Sold only at our flagship store, which has burned down.",
      stamp: "Not Available by Mail",
      ornament: "velocipede",
    }),
  },
  {
    id: "secret-words",
    kind: "novelty",
    sizes: ["full", "box"],
    render: () => ({
      kicker: "Whispered by old-timers",
      headline: "The Little Book of Secret Words",
      body: "Words of power that grant thirty lives, every weapon and a wagon-load of gold. Up, up, down, down, and so on. Some of them may even work.",
      price: "10¢ postpaid",
      ornament: "hand",
    }),
  },
  {
    id: "backlog-remedy",
    kind: "novelty",
    sizes: ["full", "box"],
    when: (ctx) => ctx.entries.length >= 40,
    render: (ctx) => ({
      kicker: "A common complaint",
      headline: "Remedy for the Backlog",
      body: `Do you own ${ctx.entries.length} amusements and play the same two? Our remedy will not help in the least, but it tastes pleasantly of liquorice.`,
      price: "15¢",
      ornament: "bottle",
    }),
  },

  // ---- about the user's own library ---------------------------------------------------------
  {
    id: "neglected",
    kind: "library",
    sizes: ["full", "box", "strip"],
    weight: 3,
    when: (ctx) => !!ctx.neglected(),
    render: (ctx) => {
      const e = ctx.neglected();
      const since = e.lastLaunched ? `since ${ctx.date(e.lastLaunched)}` : "since the day it arrived";
      return {
        kicker: "Reduced to clear!",
        headline: "Neglected Goods",
        body: `Article No. ${ctx.catNo(e)}, ${e.title}, has stood untouched in your warehouse ${since}. Already paid for and delivered to your door. What are you waiting for?`,
        strip: `${e.title}, untouched ${since}.`,
        price: `See page ${ctx.pageOf(e)}`,
        art: { entry: e, kind: "cover" },
        target: e,
      };
    },
  },
  {
    id: "bestseller",
    kind: "library",
    sizes: ["full", "box", "strip"],
    weight: 2,
    when: (ctx) => !!ctx.recent(),
    render: (ctx) => {
      const e = ctx.recent();
      return {
        kicker: "By popular demand",
        headline: "Our Bestseller",
        body: `${e.title}: the customer who ordered it once came back for more, most recently on ${ctx.date(e.lastLaunched)}. Stocks are plentiful.`,
        strip: `${e.title}, last ordered ${ctx.date(e.lastLaunched)}.`,
        price: `See page ${ctx.pageOf(e)}`,
        art: { entry: e, kind: "cover" },
        target: e,
      };
    },
  },
  {
    id: "new-arrival",
    kind: "library",
    sizes: ["full", "box", "strip"],
    weight: 2,
    when: (ctx) => !!ctx.newest(),
    render: (ctx) => {
      const e = ctx.newest();
      return {
        kicker: "Just in",
        headline: "Newly Arrived",
        body: `Fresh off the westbound freight: ${e.title}, received into stock on ${ctx.date(e.addedAt)}. Be the first in your county to own one.`,
        strip: `${e.title}, received ${ctx.date(e.addedAt)}.`,
        price: `See page ${ctx.pageOf(e)}`,
        art: { entry: e, kind: "cover" },
        target: e,
      };
    },
  },
  {
    id: "heavyweight",
    kind: "library",
    sizes: ["full", "box", "strip"],
    when: (ctx) => !!ctx.heaviest(),
    render: (ctx) => {
      const e = ctx.heaviest();
      return {
        kicker: "Ship by freight",
        headline: "The Heavyweight Champion",
        body: `At ${ctx.weight(e.sizeBytes)}, ${e.title} is the weightiest article we stock. Delivered by freight wagon only; allow six to eight weeks and a strong back.`,
        strip: `${e.title}, ${ctx.weight(e.sizeBytes)}. Freight only.`,
        price: `See page ${ctx.pageOf(e)}`,
        target: e,
        ornament: "star",
      };
    },
  },
  {
    id: "department",
    kind: "library",
    sizes: ["full", "box", "strip"],
    when: (ctx) => (ctx.biggestDept()?.entries.length ?? 0) >= 3,
    render: (ctx) => {
      const d = ctx.biggestDept();
      return {
        kicker: "The largest assortment west of the Atlantic",
        headline: `Visit our ${d.label} Department`,
        body: `${d.entries.length} articles, every one in stock, from page ${d.page}. Our buyers have scoured the world so that you need not.`,
        strip: `${d.entries.length} articles from page ${d.page}.`,
        price: `Page ${d.page}`,
        page: d.page,
        ornament: "hand",
      };
    },
  },

  // ---- the house ----------------------------------------------------------------------------
  {
    id: "agents-wanted",
    kind: "house",
    sizes: ["full", "box"],
    render: () => ({
      kicker: "Opportunity knocks",
      headline: "Agents Wanted in Every Town",
      body: "Earn as much as three dollars a week showing this catalogue to your neighbours. No experience necessary; a firm handshake and a clean collar preferred.",
      price: "Write today",
      fine: "Vellum & Co. accepts no responsibility for neighbours.",
      ornament: "hand",
    }),
  },
];

/** The house guarantee, always the frontispiece. */
export const FRONTISPIECE = {
  id: "guarantee",
  kind: "house",
  sizes: ["full"],
  render: (ctx) => ({
    kicker: "Read this before ordering",
    headline: "Our Iron-Clad Guarantee",
    sub: "Purveyors of fine amusements since 1899",
    body: `Every one of the ${ctx.entries.length} articles in these pages is warranted to start, or to try its very best. Should any article fail to give entire satisfaction, simply play it again. We have served the sporting public for longer than we can remember, chiefly because we cannot remember.`,
    price: "Vellum & Co.",
    fine: "Prices subject to change without notice, and without prices.",
    ornament: "star",
  }),
};

/** A seeded random number generator (LCG); the same seed gives the same sequence. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
    return a / 4294967296;
  };
}

/**
 * Returns pick(size): a weighted choice among the advertisements that qualify and fit `size`,
 * without repeats until each has had a turn.
 */
export function adPicker(ctx, random) {
  const pool = ctx.ads.filter((a) => {
    try {
      return !a.when || a.when(ctx);
    } catch {
      return false;
    }
  });
  const used = new Set();
  return (size) => {
    const fits = pool.filter((a) => a.sizes.includes(size));
    let avail = fits.filter((a) => !used.has(a.id));
    if (!avail.length) {
      fits.forEach((a) => used.delete(a.id));
      avail = fits;
    }
    if (!avail.length) return null;
    const total = avail.reduce((n, a) => n + (a.weight ?? 1), 0);
    let r = random() * total;
    for (const a of avail) {
      r -= a.weight ?? 1;
      if (r <= 0) {
        used.add(a.id);
        return a;
      }
    }
    const a = avail[avail.length - 1];
    used.add(a.id);
    return a;
  };
}
