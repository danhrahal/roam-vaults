import { test } from 'node:test';
import assert from 'node:assert/strict';

// A later start: the notes saved by an earlier scan answer before any file has been looked at.
// The indexer runs at import, so stand in for its worker scope, IndexedDB and the watcher first.
const answers = new Map<number, (m: any) => void>();
let onStatus: (s: string) => void = () => {};
const statuses: string[] = [];
let changes = 0;
(globalThis as any).self = {
  postMessage(m: any) {
    if (m.id !== undefined) answers.get(m.id)?.(m);
    else if (m.type === 'changed') changes++;
    else if (m.type === 'status') { const s = `${m.state} ${m.detail}${m.scanning ? ` (${m.scanning})` : ''}`; statuses.push(s); onStatus(s); }
  },
};
(globalThis as any).FileSystemObserver = class { async observe() {} disconnect() {} };

// IndexedDB, as far as the note cache uses it: one store, keys of [vault, path].
const saved = new Map<string, any>();
const request = (get: () => unknown) => { const r: any = {}; queueMicrotask(() => { r.result = get(); r.onsuccess?.(); }); return r; };
const notesStore = {
  getAll(range: any, count: number) {
    const [vault, after] = range.lower;
    return request(() => [...saved].map(([k, v]) => [JSON.parse(k), v] as [string[], any])
      .filter(([k]) => k[0] === vault && (after === undefined || k[1] > after))
      .sort((a, b) => (a[0][1] < b[0][1] ? -1 : 1)).slice(0, count).map(([, v]) => structuredClone(v)));
  },
  put(v: any, key: string[]) { saved.set(JSON.stringify(key), structuredClone(v)); },
  delete(key: string[]) { saved.delete(JSON.stringify(key)); },
};
const db = {
  objectStoreNames: [], createObjectStore() {}, deleteObjectStore() {}, close() {},
  transaction() { const tx: any = { objectStore: () => notesStore }; setTimeout(() => tx.oncomplete?.(), 0); return tx; },
};
(globalThis as any).indexedDB = { open() { const r: any = { result: db }; queueMicrotask(() => r.onsuccess?.()); return r; } };
(globalThis as any).IDBKeyRange = { bound: (lower: unknown, upper: unknown) => ({ lower, upper }) };

const files = new Map<string, string>(Object.entries({
  'Topic.md': 'the topic',
  'Old.md': 'about [[Topic]]',
  'Gone.md': 'also about [[Topic]]',
}));
const times = new Map<string, number>();
let walking: Promise<void> | null = null; // set to hold the walk back
const root = {
  kind: 'directory',
  async getDirectoryHandle() { throw new DOMException('missing', 'NotFoundError'); },
  async *entries() { await walking; for (const name of [...files.keys()]) yield [name, await this.getFileHandle(name)]; },
  async getFileHandle(name: string) {
    const t = files.get(name);
    if (t === undefined) throw new DOMException('missing', 'NotFoundError');
    return { kind: 'file', async getFile() { return { size: t.length, lastModified: times.get(name) ?? 1, async text() { return t; } }; } };
  },
};

await import('../src/worker.ts');
let seq = 0;
const call = (cmd: string, args?: unknown) => new Promise<any>((resolve) => {
  const id = ++seq;
  answers.set(id, resolve);
  (globalThis as any).self.onmessage({ data: { id, cmd, args } });
});
const linkers = async () => (await call('query', { title: 'Topic' })).result?.backlinks.map((b: any) => b.path) ?? null;

test('a first scan has nothing to answer from until it is done', async () => {
  const r = await call('open', { handle: root, key: 'v' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(statuses, ['indexing reading files', 'indexing 3 of 3 notes', 'ready 3 notes']);
  assert.deepEqual(await linkers(), ['Gone.md', 'Old.md']);
  await new Promise((r) => setTimeout(r, 2200)); // the cache is written two seconds after a scan
  assert.equal(saved.size, 3);
});

test('a later start answers from the saved notes while the files are checked', async () => {
  await call('close');
  files.delete('Gone.md');
  files.set('New.md', 'new, about [[Topic]]');
  files.set('Old.md', 'no longer about it'); times.set('Old.md', 2);
  statuses.length = 0; changes = 0;
  // Hold the walk until the page has asked: what it gets can only have come from the saved notes.
  let walk!: () => void;
  walking = new Promise((r) => { walk = r; });
  let early: Promise<string[] | null> | null = null;
  onStatus = (s) => { if (!early && s.startsWith('ready')) early = linkers().finally(walk); };
  const r = await call('open', { handle: root, key: 'v' });
  onStatus = () => {};
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(await early, ['Gone.md', 'Old.md'], 'pages are answered as of the last session');
  assert.deepEqual(statuses.slice(0, 2), ['indexing reading files', 'ready 3 notes (reading files)']);
  assert.ok(statuses.slice(1, -1).every((s) => /^ready \d notes \(.+\)$/.test(s)), 'it stays ready, and says it is scanning, until the check is over');
  assert.equal(statuses.at(-1), 'ready 3 notes');
  assert.deepEqual([r.result.reread, r.result.changed], [2, true]);
  assert.equal(changes, 1, 'pages are told once the check has changed the index');
  assert.deepEqual(await linkers(), ['New.md']);
  await new Promise((r) => setTimeout(r, 2200));
  assert.deepEqual([...saved.keys()].map((k) => JSON.parse(k)[1]).sort(), ['New.md', 'Old.md', 'Topic.md'], 'the cache follows');
});

test('a rescan that finds nothing new leaves pages alone', async () => {
  statuses.length = 0; changes = 0;
  const r = await call('rescan');
  assert.equal(r.ok, true, r.error);
  assert.deepEqual([r.result.reread, r.result.changed], [0, false]);
  assert.equal(changes, 0);
  assert.ok(statuses.every((s) => s.startsWith('ready 3 notes')));
});

test('a new daily note format builds the index anew', async () => {
  const dir = { async getFileHandle(n: string) { if (n !== 'daily-notes.json') throw new DOMException('missing', 'NotFoundError'); return { async getFile() { return { async text() { return '{"format":"DD-MM-YYYY"}'; } }; } }; } };
  (root as any).getDirectoryHandle = async (n: string) => { if (n !== '.obsidian') throw new DOMException('missing', 'NotFoundError'); return dir; };
  files.set('09-11-2026.md', 'a daily note');
  statuses.length = 0; changes = 0;
  const r = await call('rescan');
  assert.equal(r.ok, true, r.error);
  assert.equal(statuses[0], 'indexing reading files');
  assert.equal(changes, 1);
  assert.deepEqual((await call('query', { title: 'November 9th, 2026' })).result.counterparts.map((c: any) => c.path), ['09-11-2026.md']);
});
