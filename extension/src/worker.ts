// Indexer Web Worker. Loaded from a Blob URL of this bundled file. Owns the vault
// directory handle, the index, the IndexedDB parse cache and the file watcher.
import { VaultEngine, type VaultFS, type FileMeta, type Cache } from './engine.ts';
import { readNotes, writeNotes } from './cache-db.ts';
import { intern } from './core/parser.ts';
import { NONE } from './core/vault-index.ts';
import type { Note } from './core/types.ts';

declare const self: DedicatedWorkerGlobalScope;
declare const FileSystemObserver: any;

let root: FileSystemDirectoryHandle | null = null;
let engine: VaultEngine | null = null;
let vaultKey = '';
let observer: any = null;
// Folder handles by path ('' is the vault itself). A handle per note would be tens of thousands
// of live handles in a big vault, each one costing memory in Roam's main process as well as here.
let dirs = new Map<string, FileSystemDirectoryHandle>();
// Paths are kept in NFC. The few files whose name on disk is written differently (decomposed
// accents, common in folders that came from a Mac) are looked up by that name.
let diskNames = new Map<string, string>();
let live = false;      // is the file watcher running?
let notLiveWhy = '';

const post = (msg: unknown) => self.postMessage(msg);
const status = (state: string, detail = '') => post({ type: 'status', state, detail, live, notLiveWhy });

// ---------- keeping file handles from piling up ----------
// A file handle or File object is released when the garbage collector gets to it, and the
// collector can't see what one costs: about 10 KB, most of it outside this worker, part of it in
// Roam's main process. Walking a 20,000-note vault makes over 40,000 of them and hardly any
// JavaScript garbage, so none were collected until well after the scan: about 400 MB at the peak.
// A large buffer that is never written to takes no real memory but counts as allocation, which
// brings the next collection forward. Measured with test/memory-bench.mjs (see DEVELOPING.md).
const HANDLES_PER_NUDGE = 2000, NUDGE_BYTES = 64 << 20;
let handlesMade = 0;
function madeHandles(n: number) {
  if ((handlesMade += n) < HANDLES_PER_NUDGE) return;
  handlesMade = 0;
  try { new ArrayBuffer(NUDGE_BYTES); } catch { /* no room for one: nothing is lost */ }
}

// ---------- file system over a FileSystemDirectoryHandle ----------
async function getDir(path: string): Promise<FileSystemDirectoryHandle> {
  let dir = dirs.get(path);
  if (dir) return dir;
  dir = root!;
  let at = '';
  for (const p of path.split('/')) {
    at = at ? `${at}/${p}` : p;
    let next = dirs.get(at);
    if (!next) dirs.set(at, next = await dir.getDirectoryHandle(p));
    dir = next;
  }
  return dir;
}
async function getFile(path: string): Promise<File> {
  if (!root) throw new DOMException('missing', 'NotFoundError');
  const i = path.lastIndexOf('/');
  const dir = i < 0 ? root : await getDir(path.slice(0, i));
  madeHandles(2);
  return (await dir.getFileHandle(diskNames.get(path) ?? path.slice(i + 1))).getFile();
}

const handleFS: VaultFS = {
  async list() {
    const out: FileMeta[] = [];
    const found = new Map<string, FileSystemDirectoryHandle>();
    const names = new Map<string, string>();
    const pending: Promise<void>[] = [];
    async function walk(dir: FileSystemDirectoryHandle, prefix: string) {
      for await (const [name, h] of (dir as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
        madeHandles(1);
        if (name.startsWith('.')) continue; // .obsidian, .trash, .git
        const rel = (prefix ? `${prefix}/${name}` : name).normalize('NFC');
        if (h.kind === 'directory') { found.set(rel, h as FileSystemDirectoryHandle); await walk(h as FileSystemDirectoryHandle, rel); }
        else if (!/\.md$/i.test(name)) out.push({ path: rel, size: 0, mtime: 0 }); // only notes need a size and time
        else {
          if (name !== name.normalize('NFC')) names.set(rel, name);
          madeHandles(1);
          pending.push((h as FileSystemFileHandle).getFile().then(
            (f) => { out.push({ path: rel, size: f.size, mtime: f.lastModified }); },
            () => { out.push({ path: rel, size: -1, mtime: -1 }); }));
          if (pending.length >= 64) await Promise.all(pending.splice(0));
        }
      }
    }
    await walk(root!, '');
    await Promise.all(pending);
    dirs = found; diskNames = names;
    return out;
  },
  async readText(path) { return (await getFile(path)).text(); },
  async stat(path) {
    try { const f = await getFile(path); return { path, size: f.size, mtime: f.lastModified }; }
    catch { return null; }
  },
};

// ---------- IndexedDB parse cache ----------
async function loadCache(key: string): Promise<Cache> {
  const cache: Cache = new Map();
  try {
    await readNotes(key, (n) => {
      // A copy read back from the database has its own string for every link: share them again.
      const l = n.links;
      for (let i = 0; i < l.length; i += 2) l[i] = intern(l[i] as string);
      for (let i = 0; i < n.tags.length; i++) n.tags[i] = intern(n.tags[i]);
      if (!l.length) n.links = NONE;
      if (!n.tags.length) n.tags = NONE;
      if (!n.aliases.length) n.aliases = NONE;
      cache.set(n.path, n);
    });
  } catch { cache.clear(); /* the cache is only an optimisation */ }
  return cache;
}
let unsaved = new Map<string, Note | null>(); // changes the cache has not caught up with
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let saving: Promise<void> = Promise.resolve();
/** Queue an engine's changes for the cache: only the notes that changed are written. */
function saveCacheSoon(from: VaultEngine) {
  for (const [path, note] of from.unsaved) unsaved.set(path, note);
  from.unsaved = new Map();
  if (!unsaved.size) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const changes = [...unsaved], key = vaultKey;
    unsaved = new Map();
    saving = saving.then(() => writeNotes(key, changes)).catch(() => { /* the cache is only an optimisation */ });
  }, 2000);
}

// ---------- vault settings ----------
async function dailyFormats(): Promise<string[]> {
  const fmts = ['YYYY-MM-DD'];
  try {
    const cfg = await root!.getDirectoryHandle('.obsidian');
    const f = await (await cfg.getFileHandle('daily-notes.json')).getFile();
    const j = JSON.parse(await f.text());
    if (typeof j.format === 'string' && j.format.trim()) fmts.unshift(j.format.trim());
  } catch { /* no daily-notes config: Obsidian's default format */ }
  return [...new Set(fmts)];
}

// ---------- watcher ----------
let pendingPaths = new Set<string>();
let needRescan = false;
let rewatch = false;   // the watcher reported "errored": it has stopped and must be started again
let building = 0;      // scans in progress
let flushTimer: ReturnType<typeof setTimeout> | undefined;
function onRecords(records: any[]) {
  for (const r of records) {
    const parts: string[] = r.relativePathComponents ?? [];
    const path = parts.join('/').normalize('NFC');
    const name = parts[parts.length - 1];
    if (name && name !== name.normalize('NFC')) diskNames.set(path, name);
    if (r.type === 'errored') rewatch = true;
    if (r.type === 'unknown' || r.type === 'errored') { needRescan = true; continue; }
    if (!path || path.split('/').some((s: string) => s.startsWith('.'))) continue;
    if (r.type === 'moved' && r.relativePathMovedFrom) pendingPaths.add(r.relativePathMovedFrom.join('/').normalize('NFC'));
    // A folder appeared, vanished or moved: simplest to rescan (cached notes are not re-read).
    if (r.changedHandle?.kind === 'directory' || !/\.[^/]+$/.test(path)) { needRescan = true; continue; }
    pendingPaths.add(path);
  }
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 300); // editors write files in bursts
}
async function flush() {
  if (!root) return;
  // A scan is running: keep the changes and apply them to the index it builds.
  if (building) { clearTimeout(flushTimer); flushTimer = setTimeout(flush, 300); return; }
  if (needRescan || !engine) {
    needRescan = false; pendingPaths = new Set();
    if (rewatch) { rewatch = false; await watch(); }
    await build().catch(() => {}); // build() has already reported the failure
    return;
  }
  const paths = [...pendingPaths]; pendingPaths = new Set();
  if (await engine.refresh(paths)) { saveCacheSoon(engine); post({ type: 'changed', paths }); }
}
/** Start the file watcher. Whether it is running goes out with every status message. */
async function watch() {
  observer?.disconnect();
  observer = null; live = false;
  if (typeof FileSystemObserver === 'undefined') { notLiveWhy = 'FileSystemObserver unavailable'; return; }
  try {
    const o = new FileSystemObserver(onRecords);
    await o.observe(root, { recursive: true });
    observer = o; live = true; notLiveWhy = '';
  } catch (e) { notLiveWhy = (e as Error).message; }
}

// ---------- commands ----------
async function build() {
  building++;
  status('indexing', 'reading files');
  try {
    if (!root) throw new Error('The vault is not connected.');
    // The index in use stays in place until the new one is complete. Its notes are the cache
    // for the new one; only the first scan reads the saved cache.
    const next = new VaultEngine(handleFS, await dailyFormats());
    const stats = await next.build(engine ? engine.cache : await loadCache(vaultKey), (done, total) => status('indexing', `${done} of ${total} notes`));
    engine = next;
    saveCacheSoon(next);
    status('ready', `${stats.notes} ${stats.notes === 1 ? 'note' : 'notes'}`);
    post({ type: 'changed', paths: [] });
    return stats;
  } catch (e) {
    // Say so, or the vault would stay "indexing" for good (folder moved, deleted or unmounted).
    status('error', `${(e as Error).name}: ${(e as Error).message}`);
    throw e;
  } finally { building--; }
}

const commands: Record<string, (a: any) => Promise<unknown> | unknown> = {
  async open({ handle, key }) {
    if (key !== vaultKey) { engine = null; unsaved = new Map(); }
    root = handle; vaultKey = key; dirs = new Map(); diskNames = new Map();
    await watch(); // before the scan, so a file edited while it runs is not missed
    return build();
  },
  rescan: () => build(),
  query: ({ title }) => engine ? engine.query(title) : null,
  read: ({ path }) => engine!.read(path),
  resolve: ({ target, from }) => engine?.resolve(target, from) ?? null,
  close() { observer?.disconnect(); observer = null; engine = null; root = null; return true; },
};

self.onmessage = async ({ data }) => {
  const { id, cmd, args } = data;
  try { post({ id, ok: true, result: await commands[cmd](args ?? {}) }); }
  catch (e) { post({ id, ok: false, error: `${(e as Error).name}: ${(e as Error).message}` }); }
};
