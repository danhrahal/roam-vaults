// Builds dist/extension.js for Roam Depot (developer mode: load the dist folder).
// The indexer worker is bundled first and inlined as a string, then started from a Blob URL.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import zlib from 'node:zlib';

const common = { bundle: true, minify: false, target: 'es2022', legalComments: 'none', logLevel: 'warning' };
// SQLite's wasm build has no import.meta in a classic worker; it is never asked to find its .wasm
// file, because the page hands it a compiled module.
const worker = await esbuild.build({ ...common, entryPoints: ['src/worker.ts'], format: 'iife', write: false, define: { 'import.meta.url': '""' } });
// SQLite's .wasm, gzipped and inlined: Roam Depot allows no code from the network.
const wasm = zlib.gzipSync(fs.readFileSync('node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm'), { level: 9 }).toString('base64');
await esbuild.build({
  ...common,
  entryPoints: ['src/main/index.ts'],
  format: 'esm',
  outfile: 'dist/extension.js',
  define: { WORKER_SOURCE: JSON.stringify(worker.outputFiles[0].text), SQLITE_WASM: JSON.stringify(wasm) },
});
// RahalOS: the same extension for a `roam/js` block (a classic script, no Roam Depot): see src/roam-js.ts.
await esbuild.build({
  ...common,
  minify: true,
  entryPoints: ['src/roam-js.ts'],
  format: 'iife',
  outfile: 'dist/roam-js.js',
  define: { WORKER_SOURCE: JSON.stringify(worker.outputFiles[0].text), SQLITE_WASM: JSON.stringify(wasm) },
});
console.log('built dist/roam-js.js', fs.statSync('dist/roam-js.js').size, 'bytes');
// The roam/js block holds no backtick (RahalOS rule for code blocks): the script is gzipped and
// base64-encoded, and a short loader unpacks and runs it.
const packed = zlib.gzipSync(fs.readFileSync('dist/roam-js.js'), { level: 9 }).toString('base64');
const loader = [
  '// RahalOS: Roam Vaults Fork (sweenzor/roam-vaults + RahalOS layer), gzipped and base64-encoded.',
  '// Source: ~/Code/roam-vaults branch rahalos, extension/src/roam-js.ts; built by extension/build.mjs.',
  '(function () {',
  '  var b64 = "' + packed + '";',
  '  var bin = atob(b64), bytes = new Uint8Array(bin.length);',
  '  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);',
  '  new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text()',
  '    .then(function (code) { new Function(code)(); })',
  '    .catch(function (e) { console.error("[Vaults fork] unpack failed", e); });',
  '})();',
  '',
].join('\n');
fs.writeFileSync('dist/roam-js.block.js', loader);
console.log('built dist/roam-js.block.js', loader.length, 'bytes');
for (const f of ['README.md', 'CHANGELOG.md']) fs.copyFileSync(f, `dist/${f}`);
console.log('built dist/extension.js', fs.statSync('dist/extension.js').size, 'bytes');
