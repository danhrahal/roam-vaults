// Scans that never finished. The indexer runs in Roam's own process, so a scan that runs out of
// memory takes Roam down with it, and as every vault is scanned on load, that scan would crash
// Roam again on every launch. So a mark is kept on this device while a scan runs, and a vault
// whose mark is still there on load waits for Rescan.
//
// The mark goes to IndexedDB with strict durability: localStorage alone is not enough, because
// Roam doesn't write localStorage to disk for many seconds, and a crash in that time loses it.
// Each mark carries a token. Closing or reloading Roam mid-scan isn't a crash, so on page hide the
// mark is cleared and its token is also noted in localStorage as closed (Roam writes localStorage
// out when it closes normally, while an IndexedDB delete started on page hide may not land).
// A mark set in localStorage by hand also counts, so the guard can be tried without a crash.
const DB = 'roam-vaults-marks', STORE = 'scanning';
const lsMark = (id: string) => `roam-vaults:scanning:${id}`;
const lsClosed = (id: string) => `roam-vaults:closed:${id}`;

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

// Writes go one after another, so a clear can't land before the set it follows.
let queue: Promise<unknown> = Promise.resolve();
function write(fn: (s: IDBObjectStore) => void): Promise<void> {
  const next = queue.then(async () => {
    const db = await open();
    await new Promise<void>((res, rej) => {
      const tx = (db.transaction as any)(STORE, 'readwrite', { durability: 'strict' }) as IDBTransaction;
      fn(tx.objectStore(STORE));
      tx.oncomplete = () => res();
      tx.onerror = tx.onabort = () => rej(tx.error);
    }).finally(() => db.close());
  });
  queue = next.catch(() => {});
  return next;
}
const ls = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
  del: (k: string) => { try { localStorage.removeItem(k); } catch { /* storage blocked */ } },
};

/** Set (with a new token) or clear a vault's mark. The promise settles when it is on disk. */
export function setScanMark(id: string, token: string | null): Promise<void> {
  if (token) { ls.del(lsClosed(id)); ls.set(lsMark(id), token); }
  else ls.del(lsMark(id));
  return write((s) => { if (token) s.put(token, id); else s.delete(id); }).catch((e) => {
    console.warn('[roam-vaults] could not save the scan mark', e); // storage blocked or full: no guard
  });
}

/** Page hide: Roam is closing or reloading, which isn't a crash. */
export function closeScanMark(id: string, token: string) {
  ls.set(lsClosed(id), token);
  void setScanMark(id, null);
}

/** The vaults whose last scan never finished, of those given. */
export async function unfinishedScans(ids: string[]): Promise<Set<string>> {
  let saved = new Map<string, string>();
  try {
    const db = await open();
    saved = await new Promise((res, rej) => {
      const out = new Map<string, string>();
      const r = db.transaction(STORE).objectStore(STORE).openCursor();
      r.onsuccess = () => { const c = r.result; if (!c) return res(out); out.set(String(c.key), String(c.value)); c.continue(); };
      r.onerror = () => rej(r.error);
    }).finally(() => db.close()) as Map<string, string>;
  } catch (e) { console.warn('[roam-vaults] could not read the scan marks', e); }
  const out = new Set<string>();
  for (const id of ids) {
    const token = saved.get(id);
    const closed = token !== undefined && ls.get(lsClosed(id)) === token;
    if ((token !== undefined && !closed) || ls.get(lsMark(id)) !== null) out.add(id);
    else if (closed) void setScanMark(id, null); // a delete that didn't land before Roam closed
  }
  return out;
}
