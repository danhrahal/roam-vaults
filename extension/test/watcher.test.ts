import { test } from 'node:test';
import assert from 'node:assert/strict';

// The worker over an in-memory folder tree, driven by file watcher records as Chromium sends them.
// Folder events must update the index without walking the whole vault (issue #8).
const files = new Map<string, string>();
const mtimes = new Map<string, number>();
const write = (p: string, t: string) => { files.set(p, t); mtimes.set(p, (mtimes.get(p) ?? 0) + 1); };
const isDir = (p: string) => [...files.keys()].some((f) => f.startsWith(p + '/'));
let rootWalks = 0, reads = 0;
const gone = (what: string) => new DOMException(what, 'NotFoundError');

function fileHandle(path: string) {
  return {
    kind: 'file' as const,
    async getFile() {
      const t = files.get(path);
      if (t === undefined) throw gone(path);
      return { size: t.length, lastModified: mtimes.get(path)!, async text() { reads++; return t; } };
    },
  };
}
function dirHandle(path: string): any {
  const join = (name: string) => (path ? `${path}/${name}` : name);
  return {
    kind: 'directory' as const,
    async getDirectoryHandle(name: string) {
      const p = join(name);
      if (files.has(p)) throw new DOMException(p, 'TypeMismatchError');
      if (!isDir(p)) throw gone(p);
      return dirHandle(p);
    },
    async getFileHandle(name: string) {
      const p = join(name);
      if (!files.has(p)) throw isDir(p) ? new DOMException(p, 'TypeMismatchError') : gone(p);
      return fileHandle(p);
    },
    async *entries() {
      if (!path) rootWalks++;
      else if (!isDir(path)) throw gone(path);
      const names = new Set<string>();
      for (const f of files.keys()) if (!path || f.startsWith(path + '/')) names.add(f.slice(path ? path.length + 1 : 0).split('/')[0]);
      for (const n of names) yield [n, files.has(join(n)) ? fileHandle(join(n)) : dirHandle(join(n))];
    },
  };
}

const answers = new Map<number, (m: any) => void>();
const statuses: string[] = [];
(globalThis as any).self = {
  postMessage(m: any) {
    if (m.id !== undefined) answers.get(m.id)?.(m);
    else if (m.type === 'status') statuses.push(`${m.state} ${m.detail}`);
  },
};
(globalThis as any).indexedDB = { open() { throw new Error('no IndexedDB here'); } };
let report: (records: unknown[]) => void = () => {};
(globalThis as any).FileSystemObserver = class {
  constructor(cb: (records: unknown[]) => void) { report = cb; }
  async observe() {}
  disconnect() {}
};

await import('../src/worker.ts');
let seq = 0;
const call = (cmd: string, args?: unknown) => new Promise<any>((resolve) => {
  const id = ++seq;
  answers.set(id, resolve);
  (globalThis as any).self.onmessage({ data: { id, cmd, args } });
});
const settled = () => new Promise((r) => setTimeout(r, 450)); // the worker waits 300 ms for a burst to end
const record = (type: string, path: string, kind: 'file' | 'directory', from?: string) => ({
  type, relativePathComponents: path ? path.split('/') : [], changedHandle: { kind },
  ...(from ? { relativePathMovedFrom: from.split('/') } : {}),
});
/** The notes linking to a page, by path. */
const linking = async (title: string) => (await call('query', { title })).result.backlinks.map((b: any) => b.path).sort();

write('Hub.md', 'hub');
write('Notes/One.md', '[[Hub]] one');
await call('open', { handle: dirHandle(''), key: 'watched' });
assert.equal(rootWalks, 1);

test('a new folder is walked on its own, with notes that got no events', async () => {
  write('Agent/Run 1/Log.md', '[[Hub]] from a new folder');
  write('Agent/Run 1/Deeper/Plan.md', '[[Hub]] deeper');
  report([record('appeared', 'Agent', 'directory')]);
  await settled();
  assert.deepEqual(await linking('Hub'), ['Agent/Run 1/Deeper/Plan.md', 'Agent/Run 1/Log.md', 'Notes/One.md']);
  assert.equal(rootWalks, 1, 'the vault was not walked again');
  assert.equal(statuses.at(-1), 'ready 4 notes', 'the note count follows');
});

test('notes in a new folder that do get events are read once', async () => {
  const before = reads;
  write('Agent/Run 2/Log.md', '[[Hub]] run 2');
  report([record('appeared', 'Agent/Run 2', 'directory'), record('appeared', 'Agent/Run 2/Log.md', 'file'), record('modified', 'Agent/Run 2/Log.md', 'file')]);
  await settled();
  assert.equal(reads - before, 1, 'the new note is read once');
  assert.ok((await linking('Hub')).includes('Agent/Run 2/Log.md'));
  assert.equal(rootWalks, 1);
});

test('a moved folder keeps its notes under the new path without reading them', async () => {
  for (const p of [...files.keys()].filter((p) => p.startsWith('Agent/'))) {
    write(p.replace('Agent/', 'Archive/Agent/'), files.get(p)!); mtimes.set(p.replace('Agent/', 'Archive/Agent/'), mtimes.get(p)!);
    files.delete(p); mtimes.delete(p);
  }
  const before = reads;
  report([record('moved', 'Archive/Agent', 'directory', 'Agent')]);
  await settled();
  assert.equal(reads, before, 'nothing was read');
  assert.deepEqual(await linking('Hub'), ['Archive/Agent/Run 1/Deeper/Plan.md', 'Archive/Agent/Run 1/Log.md', 'Archive/Agent/Run 2/Log.md', 'Notes/One.md']);
  assert.equal(rootWalks, 1);
});

test('a folder that goes away, or is moved into a hidden folder, takes its notes with it', async () => {
  for (const p of [...files.keys()].filter((p) => p.startsWith('Archive/Agent/Run 1/'))) files.delete(p);
  report([record('disappeared', 'Archive/Agent/Run 1', 'directory')]);
  await settled();
  assert.deepEqual(await linking('Hub'), ['Archive/Agent/Run 2/Log.md', 'Notes/One.md']);
  for (const p of [...files.keys()].filter((p) => p.startsWith('Archive/'))) { files.set(`.trash/${p}`, files.get(p)!); files.delete(p); }
  report([record('moved', '.trash/Archive', 'directory', 'Archive')]);
  await settled();
  assert.deepEqual(await linking('Hub'), ['Notes/One.md']);
  assert.equal(statuses.at(-1), 'ready 2 notes');
  assert.equal(rootWalks, 1);
});

test('lost events in one folder walk that folder; lost events anywhere walk the vault', async () => {
  write('Notes/Two.md', '[[Hub]] two');
  report([{ type: 'unknown', relativePathComponents: ['Notes'] }]);
  await settled();
  assert.deepEqual(await linking('Hub'), ['Notes/One.md', 'Notes/Two.md']);
  assert.equal(rootWalks, 1);
  report([{ type: 'unknown', relativePathComponents: [] }]);
  await settled();
  assert.equal(rootWalks, 2);
  report([{ type: 'errored', relativePathComponents: [] }]);
  await settled();
  assert.equal(rootWalks, 3);
});
