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

The Tests workflow (`.github/workflows/tests.yml`) runs the type check, unit tests and smoke test on
GitHub Actions for every pull request and push to main, and fails if `dist/` is out of date.

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

- Each vault has its own Web Worker, the indexer. It parses every `.md` file and builds a link index.
  The worker is bundled into `extension.js` as a string at build time and started from a Blob URL, so the
  extension stays a single file and never loads code from the network.
- A scan's file access is done by a second worker, the walker (`walker.ts`), which the indexer starts from
  its own URL for each scan and ends when the scan is over. The walker walks the vault and tells the
  indexer what it found, 500 files at a time; the indexer answers with the notes its cache doesn't cover,
  and the walker reads those from the `File` objects it already has. See [Memory](#memory) for why. A
  folder that changes while the vault is open is walked by the indexer itself (`walk.ts` is shared).
- The index keeps one small record per note: its path, aliases, tags, and each link's target and line. Links
  are resolved when a page asks for them, so there is no object per link. The worker keeps a handle for each
  folder, not for each note, because every live file handle also costs memory in Roam's main process. See
  [Memory](#memory).
- The index is a SQLite database, one per vault, kept in the Roam app's storage on this computer (see
  [SQLite index](#sqlite-index)). It holds each note with its file's size and modification time, so it is
  also the cache: a scan only reads the files that changed. Removing a vault deletes its database.
- At a later start pages are answered from the database straight away. The vault's files are then checked
  in the background (`check()` in `engine.ts`): the index stays in use and only what differs on disk is
  changed in it. Rescan does the same, and so does a first scan, into an empty database that answers once
  the scan is done. Settings show the scan's progress meanwhile, and the scan mark (see `scan-mark.ts`) is
  set as for any scan.
- Where SQLite can't be loaded, the index is the same one in JavaScript maps (`core/vault-index.ts`), with
  the parsed notes cached in IndexedDB, one record per note. There a first scan, or a change of the vault's
  daily note format, builds a whole index in one go.
- Folder handles are kept in this device's IndexedDB, never in Roam settings, which sync through the graph.
- `FileSystemObserver` watches the folder, so edits made in Obsidian or any editor show up within a second.
  A file event re-checks that file. A folder that appears, goes away or moves is walked on its own
  (`VaultEngine.refreshFolders`), since a folder moved into the vault brings notes that get no events of
  their own; a moved folder's notes keep their parse under the new path. Only an `errored` record, or an
  `unknown` one without a path (events lost somewhere in the vault), walks the whole vault again.
- Daily notes use the format in `.obsidian/daily-notes.json`, falling back to `YYYY-MM-DD`.
- Similar names: a page that no note is lists notes whose name or alias is close to its title. The scoring,
  its guards (every word must start with the same letter, keep its numbers, and so on) and the highlighted
  letters (`diffMarks`) are in `src/core/fuzzy.ts`. The lookup runs on the vault's SQLite database
  (`src/sql/fuzzy.ts`, see below): each name and alias is a row cut into trigrams by triggers, and a title's
  rarer trigrams pull the 50 closest keys for `fuzzy.ts` to judge (2 to 5 ms a page at 20,000 notes, 5 MB of
  database). When SQLite can't load, `src/core/fuzzy-index.ts` does the same in memory, with notes in buckets
  by the first letters of their words. To measure quality, latency and size of both:
  `npm pack wordlist-english && tar xzf wordlist-english-*.tgz` once, then
  `WORDS=path/to/package node --expose-gc test/fuzzy-bench.mjs [notes]`.
- The scan skips dot-folders, paths matched by the vault's `.gitignore` files (git's rules, through the
  `ignore` package, nearest file decides) and Obsidian's Excluded files (`userIgnoreFilters` in
  `.obsidian/app.json`: a plain entry is a path prefix, `/.../` a regular expression tested against file
  paths). Ignored folders are never opened. The watcher drops events under them, and a change to a
  `.gitignore`, `app.json` or `daily-notes.json` rescans. See `src/core/ignore.ts`.
- CSS classes are prefixed `rv-`, and every DOM node the extension adds carries a data attribute, so
  `onunload` can remove all of them.

The design and measurements are in [docs/FEASIBILITY.md](../docs/FEASIBILITY.md).

## SQLite index

The worker keeps the index in SQLite instead of JavaScript maps: the notes of a large vault then take up
disk, not memory. Full-text search over the notes was prototyped on top of it and taken out again (on the
backlog); its code is in commit 1b8305b.

- SQLite is the official WebAssembly build, `@sqlite.org/sqlite-wasm` (pinned). `build.mjs` gzips its `.wasm`
  and inlines it in `extension.js` as base64 (Roam Depot allows no code from the network). The page compiles it
  once (`compileSqlite` in `main/index.ts`) and hands the compiled module to each vault's worker in `open`.
  If that fails, the worker uses the in-memory index.
- Each vault has its own database in the origin private file system, in `.roam-vaults/<poolName(id)>`, through
  the `opfs-sahpool` VFS (`sql/db.ts`). A pool can be open in one worker at a time: a second Roam window on the
  same vault gets a database in memory instead. Removing a vault deletes its folder.
- The tables are in `sql/schema.ts`: add a step at the end of `MIGRATIONS`. Step 2 adds the similar-name
  tables (`sql/fuzzy.ts`), which `SqlIndex` writes with each batch of notes. `SqlIndex` (`sql/sql-index.ts`)
  overrides the lookups `VaultIndex` makes (`pathsNamed`, `eachLinker`, `aliasPaths`, ...), so link resolution
  and its tie-break rules are the same code. `test/sql.test.ts` checks both indexes answer every query the same.
- Every scan is `VaultEngine.check()` on the database: it asks once for every file's size and time
  (`stamps()`), and writes the notes it read a batch at a time (`upsertNotes`), since a statement costs far
  more than a row. Writes go into a transaction that is committed every 20,000 rows and by `flush()`. A scan
  that stops part way leaves the notes it wrote, so the next one carries on from there; the database answers
  pages at a start only once a scan has finished into it (`scanned`).
- A scan into an empty database (a first scan) runs without the three indexes only lookups need and with a
  larger page cache, and makes the indexes at the end (`SqlIndex.bulk`): at 100,000 notes that took a first
  scan from 37 s to 28 s in the memory benchmark, against 22 s for the in-memory index.
  The similar-name tables do the same: during such a scan only the names are written, and their trigrams
  and trigram counts are made from them in one pass at the end (`FuzzyTitles.bulk`).

## Real Roam run (GitHub Actions)

`.github/workflows/real-roam.yml` runs `test/real-roam/run.mjs` on pull requests that touch `extension/`
and on demand (Actions > Real Roam > Run workflow). It installs Roam's Linux desktop app, starts it under
Xvfb, signs in to the hosted test graph, loads `dist/` through Roam Depot's developer mode (from a local
URL), and drives it over the DevTools protocol with Playwright. It checks the settings tab, a small vault
on a real page (including a live edit), memory through a 20,000-note vault's first scan and Rescans, and
that a scan which crashed Roam waits for Rescan. RESULTS.md and PNG screenshots are uploaded as the run's
artifact; the memory limits are at the top of `run.mjs`.

It needs the repository secrets `ROAM_EMAIL` and `ROAM_PASSWORD` (a Roam account that can open the test
graph) and is skipped without them, including on pull requests from forks. The repository variable
`ROAM_GRAPH` picks another graph. The script never logs, saves or photographs the credentials: no
screenshot is taken until the graph is open, and Roam's own log and console stay out of the output.

To run it by hand: install the Roam `.deb` and Xvfb, start `Xvfb :99`, then
`DISPLAY=:99 ROAM_EMAIL=… ROAM_PASSWORD=… node test/real-roam/run.mjs` (`NOTES=2000` for a quicker run).
A Roam profile that is already signed in skips the sign-in.

## Profiling (GitHub Actions)

`.github/workflows/profile.yml` runs `test/real-roam/profile.mjs` in the same real Roam as the run above
and records, for each vault size and each build: the first scan's time and memory peak, memory settled
after it, the worker heap, how long a Roam page takes to show its vault panel (and how much of that is
the extension's own lookup and render), a Rescan with nothing changed, and a later start from the cache.
The vault is the generated one from `test/vault-gen.mjs`, written to disk.

It runs on demand: Actions > Profile > Run workflow, with the vault sizes (for example
`10000,100000,1000000`) and the branches, tags or commits to compare (for example
`main,claude/some-branch`; the first is the one the others are compared with).

It also runs on every pull request that changes the extension, at 10,000 notes, with the base branch
against the PR, and fails when the PR is clearly worse: a number that is both a multiple of the base's
and well over it (`test/real-roam/gate.mjs` has the limits, which are wide because one run's numbers move
about). A PR that looks worse is measured a second time, base and all, and only what is over the limit
both times fails the run. The summary names what failed. Larger vaults are not profiled on pull requests.

Each size is its own job; read its summary or download the `profile-<size>` artifact (RESULTS.md,
profile.json, the memory log and screenshots). All builds of a job run one after another on the same
runner, each in a freshly started Roam with none of the extension's state, so compare columns of one
run rather than numbers across runs. The pages it opens are created in the test graph if missing.

How long a job takes, per build: about 3 minutes at 10,000 notes, 5 at 100,000 and 25 at 1,000,000 (a
million notes is 3.4 GB on disk; the job frees space on the runner first and may run for up to 6 hours).

To run it by hand, as for the run above:
`DISPLAY=:99 ROAM_EMAIL=… ROAM_PASSWORD=… SIZES=10000 BUILDS=a=/path/to/dist,b=/other/dist node test/real-roam/profile.mjs`.
`node test/real-roam/genvault.mjs <notes> <folder>` writes just the vault.

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
watcher are the ones a picked folder gets. That run also checks a note whose name is not NFC on disk, and
folders created, moved in, renamed, deleted and moved to `.trash` while the vault is open, without a
walk of the whole vault. Neither is Roam's desktop app, so compare runs of two builds rather
than reading the numbers as what a vault costs there.

Things that made 0.1.0 heavy, to keep out:

- A `FileSystemFileHandle` kept per note. About 10 KB each across the two processes.
- File handles and `File` objects left for the garbage collector during a scan. It can't see what they
  cost, so 40,000 of them piled up before it ran. `madeHandles()` in `walk.ts` brings it forward.
- Walking the vault in the worker that holds the index. `madeHandles()` only works in a worker whose own
  heap is small: with the index of 100,000 notes in the same heap, a walk of those notes left over a
  gigabyte of handles waiting. That is why the walker is a worker of its own, with nothing else in it.
  What it can't help: listing a folder makes a handle for every entry at once, so a single folder of
  80,000 notes still costs most of a gigabyte for a moment.
- Looking a note up twice, once for its size and time and again to read it. Reading it from the `File`
  the walk already has takes about a third off the file access of a first scan.
- An object per link, in several lookup sets. A vault has ten or more links per note.
- Strings read back from IndexedDB. Each is its own copy; `intern()` them when loading.
- Arrays filled with `push()` and kept for good. They hold spare room; `slice()` them once filled.
- Rewriting the whole cache after a change.
