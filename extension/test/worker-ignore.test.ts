import { test } from 'node:test';
import assert from 'node:assert/strict';

// The worker runs at import, so stand in for the worker scope, IndexedDB and the file watcher first.
const answers = new Map<number, (m: any) => void>();
(globalThis as any).self = { postMessage(m: any) { if (m.id !== undefined) answers.get(m.id)?.(m); } };
(globalThis as any).indexedDB = { open() { throw new Error('no IndexedDB here'); } };
let fire: (records: any[]) => void = () => {};
(globalThis as any).FileSystemObserver = class { constructor(cb: any) { fire = cb; } async observe() {} disconnect() {} };

// A vault in memory: a path maps to a file's text. Folders come from the paths.
const files = new Map<string, string>();
let opened: string[] = []; // folders the scan listed
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
    async *entries() {
      opened.push(path);
      for (const [n, k] of children()) yield [n, k === 'file' ? fileHandle(join(n)) : dirHandle(join(n))];
    },
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
      return { size: t.length, lastModified: 1, async text() { return t; } };
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
const settle = () => new Promise((r) => setTimeout(r, 450)); // the watcher waits 300 ms for a burst to end

for (const [p, t] of Object.entries({
  '.gitignore': 'artifacts/\n',
  '.obsidian/app.json': JSON.stringify({ userIgnoreFilters: ['Archive/', '/\\.excalidraw\\.md$/'] }),
  'Topic.md': 'kept',
  'projects/a/Topic.md': 'kept',
  'projects/a/artifacts/Topic.md': 'git-ignored',
  'projects/a/artifacts/deep/x.md': 'git-ignored',
  'projects/b/.gitignore': 'tmp\n!keep/\n',
  'projects/b/tmp/Topic.md': 'nested git-ignored',
  'Archive/Topic.md': 'excluded in Obsidian',
  'Drawings/Topic.excalidraw.md': 'excluded in Obsidian',
})) files.set(p, t);

test('the scan skips git-ignored and Obsidian-excluded paths without opening them', async () => {
  const r = await call('open', { handle: dirHandle(''), key: 'ignore-test' });
  assert.equal(r.ok, true);
  assert.deepEqual(await titles('Topic'), ['Topic.md', 'projects/a/Topic.md']);
  assert.deepEqual(await titles('Topic.excalidraw'), []);
  for (const p of ['projects/a/artifacts', 'projects/a/artifacts/deep', 'projects/b/tmp', 'Archive']) {
    assert.ok(!opened.includes(p), `${p} was walked`);
  }
});

test('the watcher ignores changes in left-out folders and keeps the rest', async () => {
  files.set('projects/a/artifacts/new/Topic.md', 'new, ignored');
  files.set('notes/Topic.md', 'new, kept');
  opened = [];
  fire([
    { type: 'appeared', relativePathComponents: ['projects', 'a', 'artifacts', 'new'], changedHandle: { kind: 'directory' } },
    { type: 'appeared', relativePathComponents: ['projects', 'a', 'artifacts', 'new', 'Topic.md'], changedHandle: { kind: 'file' } },
    { type: 'appeared', relativePathComponents: ['notes', 'Topic.md'], changedHandle: { kind: 'file' } },
  ]);
  await settle();
  assert.deepEqual(opened, [], 'a new folder inside an ignored one does not start a rescan');
  assert.deepEqual(await titles('Topic'), ['notes/Topic.md', 'projects/a/Topic.md', 'Topic.md'].sort());
});

test('changing a .gitignore or the Excluded files rescans with the new rules', async () => {
  files.set('.gitignore', 'notes/\n');
  fire([{ type: 'modified', relativePathComponents: ['.gitignore'], changedHandle: { kind: 'file' } }]);
  await settle();
  assert.deepEqual(await titles('Topic'), ['projects/a/artifacts/new/Topic.md', 'projects/a/artifacts/Topic.md', 'projects/a/Topic.md', 'Topic.md'].sort());

  files.set('.obsidian/app.json', JSON.stringify({ userIgnoreFilters: ['projects/'] }));
  fire([{ type: 'modified', relativePathComponents: ['.obsidian', 'app.json'], changedHandle: { kind: 'file' } }]);
  await settle();
  assert.deepEqual(await titles('Topic'), ['Archive/Topic.md', 'Topic.md'].sort());
  assert.deepEqual(await titles('Topic.excalidraw'), ['Drawings/Topic.excalidraw.md']);
});
