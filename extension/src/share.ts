// One vault, several Roam windows. A vault's database can be held by one worker at a time, so the
// indexer of the first window to open a vault holds it (the owner), and the indexers of other
// windows and tabs ask that one (followers) instead of reading the vault again into a database of
// their own. Who holds it is a Web Lock named after the vault: it is let go when the owner's
// window closes or the vault is removed there, and the follower that gets it next takes over.
// What followers ask and are told goes over a BroadcastChannel of the same name.

/** What the indexer does for the windows that share its vault. */
export interface ShareHooks {
  /** Owner: answer what a follower asked. */
  serve(cmd: string, args: unknown): unknown;
  /** Follower: something the owner told every window (a status, a change in the vault). */
  told(msg: unknown): void;
  /** Follower no more: the owner is gone and this indexer holds the vault now. */
  promoted(): void;
}
export interface ShareEnv {
  locks?: { request(name: string, options: { ifAvailable?: boolean; signal?: AbortSignal }, fn: (lock: unknown) => unknown): Promise<unknown> };
  channel?: (name: string) => Channel;
}
interface Channel { postMessage(m: unknown): void; close(): void; onmessage: ((e: any) => void) | null }

type Msg =
  | { t: 'hello'; from: string }
  | { t: 'tell'; msg: unknown; to?: string }
  | { t: 'ask'; from: string; id: number; cmd: string; args: unknown }
  | { t: 'answer'; to: string; id: number; ok: boolean; result?: unknown; error?: string };

/** How long a follower waits for the owner's answer. An owner that is gone doesn't answer; the
 *  follower then takes over, and the page asks again. */
const ANSWER_MS = 15000;

export class Share {
  role: 'alone' | 'owner' | 'follower' = 'alone';
  private name: string;
  private env: ShareEnv;
  private hooks: ShareHooks;
  private me = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  private ch: Channel | null = null;
  private letGo: (() => void) | null = null;
  private waiting: AbortController | null = null;
  private asked = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void; timer: ReturnType<typeof setTimeout> | undefined }>();
  private seq = 0;
  /** The last thing told that later windows need to hear too (the status). */
  private last: unknown;

  constructor(name: string, env: ShareEnv, hooks: ShareHooks) { this.name = name; this.env = env; this.hooks = hooks; }

  /** Take the vault, or follow the window that has it. True if it is this indexer's to open. */
  async claim(): Promise<boolean> {
    const { locks, channel } = this.env;
    if (!locks || !channel) return true; // nothing to share over: as a lone window
    if (this.role !== 'alone') return this.role === 'owner';
    const got = await this.hold(true);
    this.ch = channel(this.name);
    this.ch.onmessage = (e: { data: Msg }) => { void this.heard(e.data); };
    if (got) { this.role = 'owner'; return true; }
    this.role = 'follower';
    // In line for the vault: granted when its owner goes away.
    this.waiting = new AbortController();
    this.hold(false, this.waiting.signal).then((mine) => {
      if (!mine || this.role !== 'follower') return;
      this.waiting = null;
      this.role = 'owner';
      for (const a of this.asked.values()) { clearTimeout(a.timer); a.rej(new Error('the vault changed hands')); }
      this.asked.clear();
      this.hooks.promoted();
    });
    this.say({ t: 'hello', from: this.me });
    return false;
  }
  /** Ask for the lock. Resolves once it is held (kept until close()), or to false if it can't be had. */
  private hold(ifAvailable: boolean, signal?: AbortSignal): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.env.locks!.request(this.name, ifAvailable ? { ifAvailable } : { signal }, (lock) => {
        if (!lock) { resolve(false); return; }
        resolve(true);
        return new Promise<void>((release) => { this.letGo = release; });
      }).catch(() => resolve(false)); // the wait was called off
    });
  }
  private say(m: Msg) { try { this.ch?.postMessage(m); } catch { /* closed, or not cloneable */ } }

  private async heard(m: Msg) {
    if (this.role === 'owner') {
      if (m.t === 'hello') { if (this.last !== undefined) this.say({ t: 'tell', msg: this.last, to: m.from }); }
      else if (m.t === 'ask') {
        try { this.say({ t: 'answer', to: m.from, id: m.id, ok: true, result: await this.hooks.serve(m.cmd, m.args) }); }
        catch (e) { this.say({ t: 'answer', to: m.from, id: m.id, ok: false, error: `${(e as Error).name}: ${(e as Error).message}` }); }
      }
    } else if (this.role === 'follower') {
      if (m.t === 'tell') { if (m.to === undefined || m.to === this.me) this.hooks.told(m.msg); }
      else if (m.t === 'answer' && m.to === this.me) {
        const a = this.asked.get(m.id);
        if (!a) return;
        this.asked.delete(m.id); clearTimeout(a.timer);
        if (m.ok) a.res(m.result); else a.rej(new Error(m.error));
      }
    }
  }

  /** Owner: tell the other windows. `keep`: later windows are told it too, until the next one kept. */
  tell(msg: unknown, keep: boolean) {
    if (this.role !== 'owner') return;
    if (keep) this.last = msg;
    this.say({ t: 'tell', msg });
  }
  /** Follower: have the owner do something, and get its answer. `wait`: how long for, in ms (0: as
   *  long as it takes, or until the vault changes hands). */
  ask<T>(cmd: string, args: unknown, wait = ANSWER_MS): Promise<T> {
    return new Promise<T>((res, rej) => {
      const id = ++this.seq;
      const timer = wait ? setTimeout(() => { this.asked.delete(id); rej(new Error('the window that has this vault did not answer')); }, wait) : undefined;
      this.asked.set(id, { res: res as (v: unknown) => void, rej, timer });
      this.say({ t: 'ask', from: this.me, id, cmd, args });
    });
  }
  /** Let the vault go, or stop waiting for it. */
  close() {
    this.waiting?.abort(); this.waiting = null;
    this.letGo?.(); this.letGo = null;
    for (const a of this.asked.values()) { clearTimeout(a.timer); a.rej(new Error('closed')); }
    this.asked.clear();
    this.ch?.close(); this.ch = null;
    this.role = 'alone';
  }
}

/** The name a vault is shared under: its lock and its channel. */
export const shareName = (pool: string) => `roam-vaults:${pool}`;
