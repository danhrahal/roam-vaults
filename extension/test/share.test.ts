import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Share, shareName, type ShareEnv, type ShareHooks } from '../src/share.ts';

// Web Locks as far as Share uses them: one holder per name, the others in line or turned away.
class Locks {
  held = new Set<string>();
  line = new Map<string, (() => void)[]>();
  request(name: string, o: { ifAvailable?: boolean; signal?: AbortSignal }, fn: (lock: unknown) => unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const run = () => {
        this.held.add(name);
        Promise.resolve(fn({ name })).then((v) => { this.held.delete(name); this.line.get(name)?.shift()?.(); resolve(v); });
      };
      if (!this.held.has(name)) return run();
      if (o.ifAvailable) return void Promise.resolve(fn(null)).then(resolve);
      const line = this.line.get(name) ?? [];
      this.line.set(name, line);
      line.push(run);
      o.signal?.addEventListener('abort', () => { line.splice(line.indexOf(run), 1); reject(new DOMException('called off', 'AbortError')); });
    });
  }
}
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
function windows() {
  const locks = new Locks();
  const env: ShareEnv = { locks, channel: (name) => new BroadcastChannel(name) };
  const open: Share[] = [];
  const win = (hooks: Partial<ShareHooks> = {}) => {
    const w = { told: [] as unknown[], promoted: 0, share: null as unknown as Share };
    w.share = new Share(shareName('rv-test'), env, {
      serve: hooks.serve ?? ((cmd, args) => ({ cmd, args })),
      told: (m) => w.told.push(m),
      promoted: () => { w.promoted++; },
    });
    open.push(w.share);
    return w;
  };
  return { locks, win, done: () => open.forEach((s) => s.close()) };
}

test('the first window to open a vault has it, and the others ask that one', async (t) => {
  const { win, done } = windows();
  t.after(done);
  const a = win({ serve: (cmd, args: any) => { if (cmd === 'fail') throw new RangeError('no such note'); return `${cmd}:${args.title}`; } });
  const b = win(), c = win();
  assert.equal(await a.share.claim(), true);
  assert.equal(await b.share.claim(), false);
  assert.equal(await c.share.claim(), false);
  assert.deepEqual([a.share.role, b.share.role, c.share.role], ['owner', 'follower', 'follower']);
  assert.equal(await a.share.claim(), true, 'asked again, it still has it');
  // each follower gets its own answers, also to questions with the same number
  assert.deepEqual(await Promise.all([b.share.ask('query', { title: 'B' }), c.share.ask('query', { title: 'C' })]), ['query:B', 'query:C']);
  await assert.rejects(b.share.ask('fail', {}), /RangeError: no such note/);
});

test('what the owner tells reaches every follower, and a later one is told the last status', async (t) => {
  const { win, done } = windows();
  t.after(done);
  const a = win(), b = win();
  await a.share.claim(); await b.share.claim();
  await tick(); // nothing was kept when b came: it is told nothing for coming
  a.share.tell({ type: 'status', state: 'ready' }, true);
  a.share.tell({ type: 'changed', paths: ['x.md'] }, false);
  b.share.tell('followers tell nobody', true);
  await tick();
  assert.deepEqual(b.told, [{ type: 'status', state: 'ready' }, { type: 'changed', paths: ['x.md'] }]);
  assert.deepEqual(a.told, []);
  const c = win();
  await c.share.claim();
  await tick();
  assert.deepEqual(c.told, [{ type: 'status', state: 'ready' }], 'the status, not the change it missed');
});

test('when the owner goes, the next in line has the vault and the rest ask that one', async (t) => {
  const { win, locks, done } = windows();
  t.after(done);
  const a = win({ serve: () => new Promise(() => {}) }); // asked as it goes: it never answers
  const b = win({ serve: () => 'from b' }), c = win();
  await a.share.claim(); await b.share.claim(); await c.share.claim();
  const lost = b.share.ask('query', {}, 0);
  a.share.close();
  await assert.rejects(lost, /changed hands/);
  await tick();
  assert.deepEqual([a.share.role, b.share.role, c.share.role], ['alone', 'owner', 'follower']);
  assert.deepEqual([b.promoted, c.promoted], [1, 0]);
  assert.equal(await c.share.ask('query', {}), 'from b');
  // a follower that closes leaves the line
  c.share.close();
  b.share.close();
  await tick();
  assert.deepEqual([c.promoted, c.share.role, locks.held.size], [0, 'alone', 0]);
});

test('an owner that does not answer is not waited for without end', async (t) => {
  const { win, done } = windows();
  t.after(done);
  const a = win({ serve: () => new Promise(() => {}) }), b = win();
  await a.share.claim(); await b.share.claim();
  await assert.rejects(b.share.ask('query', {}, 30), /did not answer/);
});

test('without Web Locks or BroadcastChannel a window is on its own', async () => {
  const s = new Share('x', {}, { serve: () => null, told() {}, promoted() {} });
  assert.equal(await s.claim(), true);
  assert.equal(s.role, 'alone');
  s.tell('nobody hears', true);
  s.close();
});
