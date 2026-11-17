import { test } from 'node:test';
import assert from 'node:assert/strict';

// The worker runs at import, so stand in for the worker scope, IndexedDB and the file watcher first.
const answers = new Map<number, (m: any) => void>();
(globalThis as any).self = { postMessage(m: any) { if (m.id !== undefined) answers.get(m.id)?.(m); } };
(globalThis as any).indexedDB = { open() { throw new Error('no IndexedDB here'); } };
(globalThis as any).FileSystemObserver = class { async observe() {} disconnect() {} };

let reading = 0, mostAtOnce = 0, scans = 0;
const file = {
  kind: 'file',
  async getFile() {
    reading++; mostAtOnce = Math.max(mostAtOnce, reading);
    await new Promise((r) => setTimeout(r, 15));
    reading--;
    return { size: 20, lastModified: 1, async text() { return '# Note\n[[Target]]'; } };
  },
};
const root = {
  async getDirectoryHandle() { throw new Error('no .obsidian'); },
  async *entries() { scans++; yield ['Note.md', file]; },
  async getFileHandle() { return file; },
};

await import('../src/worker.ts');
let seq = 0;
const call = (cmd: string, args?: unknown) => new Promise<any>((resolve) => {
  const id = ++seq;
  answers.set(id, resolve);
  (globalThis as any).self.onmessage({ data: { id, cmd, args } });
});

test('rescans asked for while one runs share one scan after it', async () => {
  assert.equal((await call('open', { handle: root, key: 'v' })).ok, true);
  scans = 0; mostAtOnce = 0;
  const results = await Promise.all(Array.from({ length: 5 }, () => call('rescan')));
  assert.ok(results.every((r) => r.ok));
  assert.equal(mostAtOnce, 1);
  assert.equal(scans, 2); // the one that started, then one for every request that came in during it
  scans = 0;
  assert.equal((await call('rescan')).ok, true);
  assert.equal(scans, 1); // nothing left queued
});
