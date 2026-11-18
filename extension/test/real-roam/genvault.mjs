// Writes the test vault (test/vault-gen.mjs) to a folder, one file at a time.
//   node test/real-roam/genvault.mjs <notes> <folder>
import fs from 'node:fs';
import path from 'node:path';
import { genFiles } from '../vault-gen.mjs';

/** Returns { files, notes, mb, titles }: the number of files and of notes (a few generated titles
 *  repeat in the same folder, so notes can be a little under n), MB of text, and the notes' titles
 *  in generation order (daily notes, as YYYY-MM-DD, first). */
export function genVault(n, out) {
  const info = {}, paths = new Set(), made = new Set();
  let bytes = 0;
  for (const [rel, text] of genFiles(n, 42, info)) {
    const f = path.join(out, rel), d = path.dirname(f);
    if (!made.has(d)) { fs.mkdirSync(d, { recursive: true }); made.add(d); }
    fs.writeFileSync(f, text);
    bytes += text.length; paths.add(rel);
  }
  let notes = 0;
  for (const p of paths) if (p.endsWith('.md')) notes++;
  return { files: paths.size, notes, mb: Math.round(bytes / 1e6), titles: info.titles.map((x) => x.t) };
}

if (process.argv[1] === import.meta.filename) {
  const t0 = Date.now();
  const { files, notes, mb } = genVault(+process.argv[2], process.argv[3]);
  console.log({ files, notes, mb, seconds: Math.round((Date.now() - t0) / 1000) });
}
