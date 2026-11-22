import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// The indexer with its index in SQLite: the page hands over SQLite's compiled wasm when it opens a
// vault. Node has no origin private file system, so the database here is one in memory; what a
// later start finds in a kept database is in sql.test.ts and the browser tests.
// The indexer runs at import, so stand in for its worker scope, IndexedDB and the watcher first.
const answers = new Map<number, (m: any) => void>();
const statuses: string[] = [];
let changes = 0;
(globalThis as any).self = {
  postMessage(m: any) {
    if (m.id !== undefined) answers.get(m.id)?.(m);
    else if (m.type === 'changed') changes++;
    else if (m.type === 'status') statuses.push(`${m.state} ${m.detail}${m.scanning ? ` (${m.scanning})` : ''}`);
  },
};
(globalThis as any).FileSystemObserver = class { async observe() {} disconnect() {} };
let idbUsed = 0;
(globalThis as any).indexedDB = { open() { idbUsed++; const r: any = {}; queueMicrotask(() => r.onerror?.()); return r; } };

const files = new Map<string, string>(Object.entries({
  'Topic.md': 'the topic',
  'Old.md': 'about [[Topic]]',
  'Gone.md': 'also about [[Topic]]',
}));
const times = new Map<string, number>();
const root = {
  kind: 'directory',
  async getDirectoryHandle(): Promise<any> { throw new DOMException('missing', 'NotFoundError'); },
  async *entries() { for (const name of [...files.keys()]) yield [name, await this.getFileHandle(name)]; },
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
const wasm = await WebAssembly.compile(fs.readFileSync(new URL('../node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm', import.meta.url)));

test('a first scan fills the database and saves nothing in IndexedDB', async () => {
  const r = await call('open', { handle: root, key: 'v', wasm });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(statuses, ['indexing reading files', 'indexing reading files', 'indexing 3 of 3 notes', 'ready 3 notes']);
  assert.deepEqual([r.result.notes, r.result.reread], [3, 3]);
  assert.equal(changes, 1);
  assert.deepEqual(await linkers(), ['Gone.md', 'Old.md']);
  await new Promise((r) => setTimeout(r, 2200)); // when the in-memory index would write its cache
  assert.equal(idbUsed, 0);
});

test('a rescan changes the database in place while pages are answered', async () => {
  files.delete('Gone.md');
  files.set('New.md', 'new, about [[Topic]]');
  files.set('Old.md', 'no longer about it'); times.set('Old.md', 2);
  statuses.length = 0; changes = 0;
  const r = await call('rescan');
  assert.equal(r.ok, true, r.error);
  assert.equal(statuses[0], 'ready 3 notes (reading files)');
  assert.ok(statuses.every((s) => s.startsWith('ready ')), 'it stays ready');
  assert.equal(statuses.at(-1), 'ready 3 notes');
  assert.deepEqual([r.result.reread, r.result.changed], [2, true]);
  assert.equal(changes, 1);
  assert.deepEqual(await linkers(), ['New.md']);
  const none = await call('rescan');
  assert.deepEqual([none.result.reread, none.result.changed, changes], [0, false, 1]);
});

test('a new daily note format is taken up without reading the vault again', async () => {
  const dir = { async getFileHandle(n: string) { if (n !== 'daily-notes.json') throw new DOMException('missing', 'NotFoundError'); return { async getFile() { return { async text() { return '{"format":"DD-MM-YYYY"}'; } }; } }; } };
  root.getDirectoryHandle = async (n?: string) => { if (n !== '.obsidian') throw new DOMException('missing', 'NotFoundError'); return dir; };
  files.set('09-11-2026.md', 'a daily note');
  statuses.length = 0;
  const r = await call('rescan');
  assert.equal(r.ok, true, r.error);
  assert.ok(statuses.every((s) => s.startsWith('ready ')), 'it stays ready');
  assert.equal(r.result.reread, 1);
  assert.deepEqual((await call('query', { title: 'November 9th, 2026' })).result.counterparts.map((c: any) => c.path), ['09-11-2026.md']);
  assert.equal(idbUsed, 0);
});
