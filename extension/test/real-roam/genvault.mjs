// Writes the memory benchmark's deterministic vault (test/memory-bench.mjs, function gen) to a folder.
//   node test/real-roam/genvault.mjs <notes> <folder>
import fs from 'node:fs';
import path from 'node:path';

export function genVault(n, out) {
  const src = fs.readFileSync(path.join(import.meta.dirname, '../memory-bench.mjs'), 'utf8');
  const start = src.indexOf('function gen(');
  const end = src.indexOf('\n}\n', start) + 3;
  if (start < 0 || end < 3) throw new Error('gen() not found in memory-bench.mjs');
  const gen = new Function(`${src.slice(start, end)}\nreturn gen;`)();
  let bytes = 0;
  const files = gen(n);
  for (const [rel, text] of files) {
    const f = path.join(out, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text); bytes += text.length;
  }
  return { files: files.size, mb: Math.round(bytes / 1e6) };
}

if (process.argv[1] === import.meta.filename) console.log(genVault(+process.argv[2], process.argv[3]));
