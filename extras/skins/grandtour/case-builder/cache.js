// The case builder's cache: composed wraps (WebP blobs, plus a disc label and an emboss map when
// the case has them) in the skin's own IndexedDB. Each skin has its own origin, so the cache is
// private to it. Least recently used records go once the total passes LIMIT.
//
// Every call fails soft: without IndexedDB (a private window, blocked storage) cases are simply
// composed again.

const DB = "rl-cases";
const STORE = "wraps"; // the records, blobs and all
const META = "meta"; // { key, size, used }: small, so trimming never loads the images
const LIMIT = 1.5 * 1024 ** 3;

let dbp = null;
function db() {
  dbp ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE, { keyPath: "key" });
        req.result.createObjectStore(META, { keyPath: "key" }).createIndex("used", "used");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbp;
}

const done = (req) =>
  new Promise((resolve) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(undefined);
  });

/** The cached record for `key`, or null. Marks it used. */
export async function get(key) {
  const d = await db();
  if (!d) return null;
  try {
    const tx = d.transaction([STORE, META], "readwrite");
    const rec = await done(tx.objectStore(STORE).get(key));
    if (!rec) return null;
    tx.objectStore(META).put({ key, size: rec.size ?? 0, used: Date.now() });
    return rec;
  } catch {
    return null;
  }
}

/** Stores a record ({ key, wrap, disc?, emboss?, spine, w, h }) and trims the cache. */
export async function put(rec) {
  const d = await db();
  if (!d) return;
  try {
    const size = (rec.wrap?.size ?? 0) + (rec.disc?.size ?? 0) + (rec.emboss?.size ?? 0);
    const tx = d.transaction([STORE, META], "readwrite");
    tx.objectStore(STORE).put({ ...rec, size });
    tx.objectStore(META).put({ key: rec.key, size, used: Date.now() });
    await new Promise((r) => (tx.oncomplete = tx.onerror = r));
    void trim();
  } catch {
    // Full or blocked: the case is still shown, just not kept.
  }
}

let trimming = false;
async function trim() {
  if (trimming) return;
  trimming = true;
  try {
    const d = await db();
    const tx = d.transaction([STORE, META], "readwrite");
    const all = (await done(tx.objectStore(META).index("used").getAll())) ?? []; // oldest first
    let total = all.reduce((n, r) => n + (r.size ?? 0), 0);
    for (const r of all) {
      if (total <= LIMIT) break;
      tx.objectStore(STORE).delete(r.key);
      tx.objectStore(META).delete(r.key);
      total -= r.size ?? 0;
    }
  } catch {
    // Trimming is best effort.
  } finally {
    trimming = false;
  }
}
