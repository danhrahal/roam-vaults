// Walking a vault folder through the File System Access API. Used by the walker (a whole vault,
// in a worker of its own) and by the indexer (one folder, after a watcher event).
import { VaultIgnore, GITIGNORE } from './core/ignore.ts';

// ---------- keeping file handles from piling up ----------
// A file handle or File object is released when the garbage collector gets to it, and the
// collector can't see what one costs: about 10 KB, most of it outside this worker, part of it in
// Roam's main process. Walking a 20,000-note vault makes over 40,000 of them and hardly any
// JavaScript garbage, so none were collected until well after the scan: about 400 MB at the peak.
// A large buffer that is never written to takes no real memory but counts as allocation, which
// brings the next collection forward. Measured with test/memory-bench.mjs (see DEVELOPING.md).
//
// The nudge only works in a worker whose own heap is small. With an index of 100,000 notes in the
// same heap, a walk of those notes still left over a gigabyte of handles waiting: that is why a
// whole vault is walked by the walker and not by the indexer.
const HANDLES_PER_NUDGE = 2000, NUDGE_BYTES = 64 << 20;
let handlesMade = 0;
export function madeHandles(n: number) {
  if ((handlesMade += n) < HANDLES_PER_NUDGE) return;
  handlesMade = 0;
  try { new ArrayBuffer(NUDGE_BYTES); } catch { /* no room for one: nothing is lost */ }
}

/** The text of a file in a folder, or null if there is none. */
export async function textOf(dir: FileSystemDirectoryHandle, name: string): Promise<string | null> {
  try { madeHandles(2); return await (await (await dir.getFileHandle(name)).getFile()).text(); }
  catch { return null; }
}

/** Obsidian's Excluded files, as stored in .obsidian/app.json, or undefined. */
export async function obsidianFilters(root: FileSystemDirectoryHandle): Promise<unknown> {
  try { return JSON.parse((await textOf(await root.getDirectoryHandle('.obsidian'), 'app.json')) ?? 'null')?.userIgnoreFilters; }
  catch { return undefined; }
}

export interface WalkSink {
  /** A file or folder whose name on disk is not written in NFC, as paths are. */
  diskName(path: string, name: string): void;
  folder(path: string, handle: FileSystemDirectoryHandle): void;
  /** A .gitignore file found in a folder that is walked ('' is the folder the walk started from). */
  gitignore?(dir: string, text: string): void;
  /** A file that is not a note. */
  other(path: string): void;
  /** A note and the File its size and time come from, or null if it could not be opened. */
  note(path: string, file: File | null, dir: FileSystemDirectoryHandle, name: string): void;
  /** Awaited every few dozen notes: a sink that is behind holds the walk back here. */
  flow?(): Promise<void> | void;
}

/**
 * Walk a folder and the folders inside. Dot-files, dot-folders and what `skip` leaves out are
 * passed over; the .gitignore files found on the way are added to `skip`.
 */
export async function walk(top: FileSystemDirectoryHandle, topPath: string, skip: VaultIgnore, sink: WalkSink): Promise<void> {
  const pending: Promise<void>[] = [];
  async function inside(dir: FileSystemDirectoryHandle, prefix: string) {
    // A folder's .gitignore applies to everything in it, so read it before the folder's entries.
    const gi = await textOf(dir, GITIGNORE);
    if (gi !== null) { skip.addGitignore(prefix, gi); sink.gitignore?.(prefix, gi); }
    for await (const [name, h] of (dir as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
      madeHandles(1);
      if (name.startsWith('.')) continue; // .obsidian, .trash, .git
      const rel = (prefix ? `${prefix}/${name}` : name).normalize('NFC');
      if (name !== name.normalize('NFC')) sink.diskName(rel, name);
      // Left out folders are not walked at all, so they cost nothing.
      if (skip.ignores(rel, h.kind === 'directory')) continue;
      if (h.kind === 'directory') { sink.folder(rel, h as FileSystemDirectoryHandle); await inside(h as FileSystemDirectoryHandle, rel); }
      else if (!/\.md$/i.test(name)) sink.other(rel); // only notes need a size and time
      else {
        madeHandles(1);
        pending.push((h as FileSystemFileHandle).getFile().then(
          (f) => sink.note(rel, f, dir, name),
          () => sink.note(rel, null, dir, name)));
        if (pending.length >= 64) { await Promise.all(pending.splice(0)); await sink.flow?.(); }
      }
    }
  }
  await inside(top, topPath);
  await Promise.all(pending);
}
