# Developing Vaults

The user-facing guide is [README.md](README.md). Roam Depot shows that file inside Roam, so keep
developer notes here.

Roam renders the README like GitHub does: `<details>`/`<summary>` collapsibles work, Markdown inside
`<div align="center">` is kept, and a bare `https://github.com/user-attachments/assets/...` line shows
as a video. Images must use absolute URLs pinned to a commit.

## Build and test

```bash
npm install
npm test             # engine and parser tests (Node 22+)
npm run typecheck
npm run build        # writes dist/extension.js and copies README.md and CHANGELOG.md into dist/
npm run test:browser # builds, then runs a headless browser smoke test
```

`./build.sh` is what Roam Depot runs (see [docs/DEPOT-SUBMISSION.md](../docs/DEPOT-SUBMISSION.md)). It
does a clean `npm ci`, builds, and copies `dist/extension.js` to `extension.js` in this folder, where the
Depot looks for it.

## Load it in Roam (developer mode)

1. Run `npm install && npm run build`.
2. In Roam, open **Settings → Roam Depot** and turn on developer mode from the gear menu.
3. Under **Developer Extensions**, click the folder icon and choose the `dist` folder.
4. After rebuilding, click the refresh icon next to **Developer Extensions**, or press `Ctrl-D Ctrl-R`.

Local-folder developer extensions don't start by themselves after Roam restarts. Load them again from the
Roam Depot tab.

## How it works

- Each vault has its own Web Worker. It walks the vault, parses every `.md` file and builds a link index.
  The worker is bundled into `extension.js` as a string at build time and started from a Blob URL, so the
  extension stays a single file and never loads code from the network.
- The index keeps one small record per note: its path, aliases, tags, and each link's target and line. Links
  are resolved when a page asks for them, so there is no object per link. The worker keeps a handle for each
  folder, not for each note, because every live file handle also costs memory in Roam's main process. See
  [Memory](#memory).
- Parsed notes are cached in IndexedDB, one record per note, checked against the file's size and modification
  time, so later starts only re-read changed files and an edit writes one record. Removing a vault deletes
  its cache.
- Folder handles are kept in this device's IndexedDB, never in Roam settings, which sync through the graph.
- `FileSystemObserver` watches the folder, so edits made in Obsidian or any editor show up within a second.
- Daily notes use the format in `.obsidian/daily-notes.json`, falling back to `YYYY-MM-DD`.
- CSS classes are prefixed `rv-`, and every DOM node the extension adds carries a data attribute, so
  `onunload` can remove all of them.

The design and measurements are in [docs/FEASIBILITY.md](../docs/FEASIBILITY.md).

## Memory

A vault's cost is paid in three places: the worker's JavaScript heap (the index), the rest of Roam's renderer
process, and Roam's main process, which holds an object for every file handle a page keeps. Measure all
three when changing the indexer:

```bash
npm run build
node test/memory-bench.mjs            # 20,000 generated notes; pass a number for another size
DISK=1 node test/memory-bench.mjs     # the same, with the vault in a real folder on disk
```

It loads `dist/extension.js` in headless Chromium against a stand-in Roam page and a generated vault, then
prints the worker heap and each process's private memory after a first index, a start from the cache, some
browsing, some edits and a rescan. Pass a second argument to measure another build's `dist` folder.

Without `DISK=1` the vault lives in the browser's private file system. With it, the vault is written to a
temporary folder and handed to the page the way a dropped folder is, so the handles, the reads and the file
watcher are the ones a picked folder gets. That run also checks a note whose name is not NFC on disk and a
folder renamed while the vault is open. Neither is Roam's desktop app, so compare runs of two builds rather
than reading the numbers as what a vault costs there.

Things that made 0.1.0 heavy, to keep out:

- A `FileSystemFileHandle` kept per note. About 10 KB each across the two processes.
- File handles and `File` objects left for the garbage collector during a scan. It can't see what they
  cost, so 40,000 of them piled up before it ran. `madeHandles()` in `worker.ts` brings it forward.
- An object per link, in several lookup sets. A vault has ten or more links per note.
- Strings read back from IndexedDB. Each is its own copy; `intern()` them when loading.
- Arrays filled with `push()` and kept for good. They hold spare room; `slice()` them once filled.
- Rewriting the whole cache after a change.
