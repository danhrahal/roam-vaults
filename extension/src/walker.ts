// The walker: a worker that lives for one scan and does all of that scan's file access. It walks
// the vault, tells the indexer what it found a batch at a time, and reads the notes the indexer
// asks for from the File objects it already has, so a note is looked up on disk once.
//
// It exists because of what file handles cost (see walk.ts): in a worker with nothing else in its
// heap they are collected as the walk goes, and when the scan is over the indexer ends the walker,
// which gives back whatever is left. The index is never in this worker.
import { VaultIgnore } from './core/ignore.ts';
import { walk, madeHandles, obsidianFilters } from './walk.ts';
import { SCAN_BATCH, type FileMeta } from './engine.ts';

/** Batches the indexer may have in hand at once. Their File objects are kept until it answers. */
const WINDOW = 4;
/** Note text in one message, in characters. */
const TEXT_CHARS = 2_000_000;
const READS_AT_ONCE = 32;

/** What the walker sends. */
export type FromWalker =
  /** Files found. `names` are the ones whose name on disk is not in NFC, with that name. */
  | { type: 'batch'; n: number; files: FileMeta[]; names: [path: string, name: string][] }
  /** The texts asked for from batch `n`, in the order asked, null for one that can't be read. */
  | { type: 'texts'; n: number; texts: (string | null)[]; last: boolean }
  /** The walk is over. The rules it went by, for the indexer to judge watcher events with. */
  | { type: 'done'; obsidian: unknown; gitignores: [dir: string, text: string][] }
  | { type: 'error'; name: string; message: string };
/** What the indexer answers a batch with: the files in it (by position) whose text it needs. */
export interface ToWalker { n: number; want: number[] }

interface Held { file: File | null; dir: FileSystemDirectoryHandle; name: string }

export async function runWalker(scope: DedicatedWorkerGlobalScope, root: FileSystemDirectoryHandle) {
  const post = (m: FromWalker) => scope.postMessage(m);
  const open = new Map<number, (Held | null)[]>(); // batches the indexer has not answered yet
  let room: (() => void) | null = null;
  let n = 0, files: FileMeta[] = [], held: (Held | null)[] = [], names: [string, string][] = [];

  const send = () => {
    if (!files.length && !names.length) return;
    open.set(n, held);
    post({ type: 'batch', n: n++, files, names });
    files = []; held = []; names = [];
  };
  const add = (meta: FileMeta, h: Held | null) => { files.push(meta); held.push(h); if (files.length >= SCAN_BATCH) send(); };

  async function text(h: Held): Promise<string | null> {
    try { if (h.file) return await h.file.text(); } catch { /* changed since the walk saw it */ }
    try { madeHandles(2); return await (await (await h.dir.getFileHandle(h.name)).getFile()).text(); }
    catch { return null; }
  }
  scope.onmessage = async ({ data }: MessageEvent<ToWalker>) => {
    const batch = open.get(data.n);
    if (!batch) return;
    let out: (string | null)[] = [], chars = 0;
    for (let i = 0; i < data.want.length; i += READS_AT_ONCE) {
      const texts = await Promise.all(data.want.slice(i, i + READS_AT_ONCE).map((k) => { const h = batch[k]; return h ? text(h) : null; }));
      for (const t of texts) { out.push(t); chars += t?.length ?? 0; }
      if (chars >= TEXT_CHARS) { post({ type: 'texts', n: data.n, texts: out, last: false }); out = []; chars = 0; }
    }
    post({ type: 'texts', n: data.n, texts: out, last: true });
    open.delete(data.n);
    room?.();
  };

  try {
    const skip = new VaultIgnore();
    const obsidian = await obsidianFilters(root);
    skip.setObsidianFilters(obsidian);
    const gitignores: [string, string][] = [];
    await walk(root, '', skip, {
      diskName(path, name) { names.push([path, name]); },
      folder() { /* the indexer looks a folder up when it first needs it */ },
      gitignore(dir, text) { gitignores.push([dir, text]); },
      other(path) { add({ path, size: 0, mtime: 0 }, null); },
      note(path, file, dir, name) { add(file ? { path, size: file.size, mtime: file.lastModified } : { path, size: -1, mtime: -1 }, { file, dir, name }); },
      async flow() { while (open.size >= WINDOW) await new Promise<void>((r) => { room = r; }); room = null; },
    });
    send();
    post({ type: 'done', obsidian, gitignores });
  } catch (e) {
    post({ type: 'error', name: (e as Error)?.name ?? 'Error', message: (e as Error)?.message ?? String(e) });
  }
}
