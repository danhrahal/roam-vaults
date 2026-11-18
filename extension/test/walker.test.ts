import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWalker } from '../src/walker.ts';

// The indexer and the walker, talking as they do in Roam. The indexer runs at import, so stand in
// for its worker scope first; `Worker` gives it a walker that runs here, with a scope of its own.
const answers = new Map<number, (m: any) => void>();
const statuses: string[] = [];
(globalThis as any).self = {
  location: { href: 'blob:indexer' },
  postMessage(m: any) { if (m.id !== undefined) answers.get(m.id)?.(m); else if (m.type === 'status') statuses.push(`${m.state} ${m.detail}`); },
};
(globalThis as any).indexedDB = { open() { throw new Error('no IndexedDB here'); } };
let fire: (records: any[]) => void = () => {};
(globalThis as any).FileSystemObserver = class { constructor(cb: any) { fire = cb; } async observe() {} disconnect() {} };

let walkers = 0, ended = 0, broken = false;
let inHand = 0, mostInHand = 0; // batches sent and not yet answered
const later = (fn: () => void) => setTimeout(fn, 0); // a message is never delivered in the same turn
(globalThis as any).Worker = class {
  onmessage: ((e: any) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  private live = true;
  private scope: any = {
    onmessage: null,
    postMessage: (m: any) => {
      if (m.type === 'batch') mostInHand = Math.max(mostInHand, ++inHand);
      later(() => { if (this.live) this.onmessage?.({ data: structuredClone(m) }); });
    },
  };
  constructor(url: string) {
    assert.equal(url, 'blob:indexer');
    walkers++;
    if (broken) later(() => this.onerror?.({ message: 'blocked' }));
  }
  postMessage(m: any) {
    if (broken) return;
    later(() => {
      if (!this.live) return;
      if (m.walk) return void runWalker(this.scope, m.walk);
      if (m.want) inHand--;
      this.scope.onmessage?.({ data: structuredClone(m) });
    });
  }
  terminate() { if (this.live) ended++; this.live = false; }
};

// A vault in memory: a path maps to a file's text. Folders come from the paths.
const files = new Map<string, string>();
const times = new Map<string, number>();
let opens = 0, texts = 0;
const notFound = () => new DOMException('missing', 'NotFoundError');
function dirHandle(path: string): any {
  const children = () => {
    const out = new Map<string, 'file' | 'directory'>();
    const pre = path ? `${path}/` : '';
    for (const p of files.keys()) {
      if (!p.startsWith(pre)) continue;
      const rest = p.slice(pre.length).split('/');
      out.set(rest[0], rest.length > 1 ? 'directory' : 'file');
    }
    return out;
  };
  const join = (n: string) => (path ? `${path}/${n}` : n);
  return {
    kind: 'directory',
    async *entries() { for (const [n, k] of children()) yield [n, k === 'file' ? fileHandle(join(n)) : dirHandle(join(n))]; },
    async getDirectoryHandle(n: string) { if (children().get(n) !== 'directory') throw notFound(); return dirHandle(join(n)); },
    async getFileHandle(n: string) { if (children().get(n) !== 'file') throw notFound(); return fileHandle(join(n)); },
  };
}
function fileHandle(path: string): any {
  return {
    kind: 'file',
    async getFile() {
      const t = files.get(path);
      if (t === undefined) throw notFound();
      if (path.endsWith('.md')) opens++;
      const at = times.get(path) ?? 1;
      return {
        size: t.length, lastModified: at,
        // as in a browser: a File can't be read once its file has changed
        async text() { texts++; if ((times.get(path) ?? 1) !== at) throw new DOMException('changed', 'NotReadableError'); return t; },
      };
    },
  };
}

await import('../src/worker.ts');
let seq = 0;
const call = (cmd: string, args?: unknown) => new Promise<any>((resolve) => {
  const id = ++seq;
  answers.set(id, resolve);
  (globalThis as any).self.onmessage({ data: { id, cmd, args } });
});
const titles = async (title: string) => (await call('query', { title })).result.counterparts.map((c: any) => c.path).sort();

const NOTES = 2600; // more than the walker lets the indexer have in hand at once
const DECOMPOSED = 'Café'; // "Café" as a Mac writes it
for (let i = 0; i < NOTES; i++) files.set(`Notes/${i % 7}/Note ${i}.md`, `[[Topic]] ${i}`);
for (const [p, t] of Object.entries({
  '.gitignore': 'artifacts/\n',
  '.obsidian/app.json': JSON.stringify({ userIgnoreFilters: ['Archive/'] }),
  'Topic.md': 'kept',
  'pic.png': '',
  'projects/.gitignore': 'tmp\n',
  'projects/Topic.md': 'kept',
  'projects/tmp/Topic.md': 'git-ignored, by the folder\'s own file',
  'projects/artifacts/Topic.md': 'git-ignored',
  'Archive/Topic.md': 'excluded in Obsidian',
  [`${DECOMPOSED}/${DECOMPOSED}.md`]: 'decomposed on disk',
})) files.set(p, t);
let ALL = NOTES + 3;

test('a first scan goes through a walker, which opens every note once', async () => {
  const r = await call('open', { handle: dirHandle(''), key: 'walker-test' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.result.notes, ALL);
  assert.equal(r.result.reread, ALL);
  assert.equal(r.result.files, ALL + 1);
  assert.deepEqual([walkers, ended], [1, 1], 'one walker, ended when the scan was over');
  assert.equal(opens, ALL, 'each note is looked up once');
  assert.equal(texts, ALL + 3, 'and read once (the rest are the ignore and settings files)');
  assert.ok(mostInHand > 1 && mostInHand <= 5, `the indexer had ${mostInHand} batches in hand at most`);
  assert.deepEqual(await titles('Topic'), ['Topic.md', 'projects/Topic.md']);
  assert.deepEqual(statuses.filter((s) => s.startsWith('indexing')).slice(0, -1), ['indexing reading files'], 'no count without a total');
  assert.equal(statuses.at(-1), `ready ${ALL} notes`);
});

test('names and rules the walker found are the indexer\'s to use', async () => {
  // a note whose name on disk is not in NFC is found by that name when it is read
  assert.deepEqual(await titles('Café'), ['Café/Café.md']);
  assert.equal((await call('read', { path: 'Café/Café.md' })).result, 'decomposed on disk');
  // the watcher goes by the .gitignore files and Excluded files the walker read
  for (const p of ['projects/tmp/Fresh.md', 'projects/artifacts/Fresh.md', 'Archive/Fresh.md', 'projects/Fresh.md']) files.set(p, 'new');
  fire(['projects/tmp/Fresh.md', 'projects/artifacts/Fresh.md', 'Archive/Fresh.md', 'projects/Fresh.md'].map((p) => (
    { type: 'appeared', relativePathComponents: p.split('/'), changedHandle: { kind: 'file' } })));
  await new Promise((r) => setTimeout(r, 450)); // the watcher waits 300 ms for a burst to end
  assert.deepEqual(await titles('Fresh'), ['projects/Fresh.md']);
});

test('a rescan with one note changed reads that note only', async () => {
  ALL++; // the note the watcher brought in
  files.set('Notes/3/Note 3.md', 'now about [[Elsewhere]]'); times.set('Notes/3/Note 3.md', 2);
  files.delete('Notes/4/Note 4.md');
  opens = 0; texts = 0; statuses.length = 0;
  const r = await call('rescan');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.result.notes, ALL - 1);
  assert.equal(r.result.reread, 1);
  assert.equal(opens, ALL - 1);
  assert.equal(texts, 1 + 3);
  assert.deepEqual([walkers, ended], [2, 2]);
  assert.match(statuses[1], new RegExp(`^indexing \\d+ of ${ALL} notes$`), 'counts towards the notes there were');
  const b = (await call('query', { title: 'Elsewhere' })).result.backlinks.map((x: any) => x.path);
  assert.deepEqual(b, ['Notes/3/Note 3.md']);
});

test('a note that changes between the walk and the read is read afresh', async () => {
  // Every note changes right after the walk has opened it.
  const stale = new Set<string>();
  const get = files.get.bind(files);
  files.set('Late.md', 'first');
  (files as any).get = (p: string) => { const t = get(p); if (p === 'Late.md' && !stale.has(p)) { stale.add(p); queueMicrotask(() => { files.set(p, 'second, with [[Topic]]'); times.set(p, 5); }); } return t; };
  const r = await call('rescan');
  (files as any).get = get;
  assert.equal(r.ok, true, r.error);
  assert.equal(r.result.errors.length, 0);
  const b = (await call('query', { title: 'Topic' })).result.backlinks.map((x: any) => x.path);
  assert.ok(b.includes('Late.md'), 'the text is the new one');
});

test('a vault that has gone away fails the scan, and the walker is still ended', async () => {
  const before = ended;
  const gone = { ...dirHandle(''), entries() { throw notFound(); } };
  const r = await call('open', { handle: gone, key: 'walker-test' });
  assert.equal(r.ok, false);
  assert.match(r.error, /NotFoundError/);
  assert.equal(ended, before + 1);
  assert.match(statuses.at(-1)!, /^error NotFoundError/);
});

test('where a walker can\'t be started, the indexer walks the vault itself', async () => {
  broken = true;
  const before = walkers;
  const r = await call('open', { handle: dirHandle(''), key: 'walker-test' });
  broken = false;
  assert.equal(r.ok, true, r.error);
  assert.equal(walkers, before + 1);
  assert.equal(r.result.notes, ALL);
  assert.deepEqual(await titles('Topic'), ['Topic.md', 'projects/Topic.md']);
});
