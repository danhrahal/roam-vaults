// Profiles one or more builds of the extension in Roam's real desktop app (Linux, under Xvfb), signed
// in to a hosted test graph, with generated vaults of the given sizes. Drives Roam like run.mjs does.
//
//   DISPLAY=:99 ROAM_EMAIL=… ROAM_PASSWORD=… SIZES=10000,100000 BUILDS=main=/a/dist,pr=/b/dist \
//     node test/real-roam/profile.mjs
//
// For each size it writes the vault (test/vault-gen.mjs) to disk once, then for each build, in a
// freshly started Roam with none of the extension's state:
//   - memory with the extension loaded and no vault (the baseline the other numbers are over)
//   - first scan: time from Add vault folder to the "N notes" status, and the memory peak
//   - settled memory 30-45 s after the scan, and the worker heap (the index) after a collection
//   - page render: opens 20 Roam pages whose titles the vault has notes for and times both "page open
//     to vault panel filled" and "panel added to filled" (the extension's own lookup and render)
//   - Rescan with nothing changed: time and peak
//   - later start: quits and relaunches Roam, times the vault's start from its cache (from the graph
//     opening to the "N notes" status) and the memory it settles at
// then removes the vault, which deletes its cache. Results go to $OUT/profile.json and
// $OUT/RESULTS.md (a table per size with a column per build, and the change against the first
// build). A step that fails or times out is recorded and the run goes on to the next build.
//
// The pages it opens are created in the graph if missing (empty pages, the same titles every run).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { genVault } from './genvault.mjs';
import {
  roam, log, sleep, evalIn, roamMB, serve, stopServing, launchRoam, killRoam, waitFor, signIn, openGraph,
  dismissDialogs, openPage, openVaultsTab, loadDevExtension, statusOf, addVault, clearExtensionState,
  workerHeapMB, shot,
} from './roam.mjs';

const EMAIL = process.env.ROAM_EMAIL, PASSWORD = process.env.ROAM_PASSWORD;
delete process.env.ROAM_EMAIL; delete process.env.ROAM_PASSWORD;

const GRAPH = process.env.ROAM_GRAPH || 'vault-spike-hosted';
const OUT = path.resolve(process.env.OUT || 'profile-out');
const SIZES = (process.env.SIZES || '10000').split(',').map((x) => +x.trim()).filter(Boolean);
const BUILDS = (process.env.BUILDS || `this=${path.join(import.meta.dirname, '../../dist')}`).split(',').map((x) => {
  const i = x.indexOf('=');
  const label = x.slice(0, i).trim();
  return { label, file: label.replace(/[^\w.-]+/g, '-'), dist: path.resolve(x.slice(i + 1).trim()), commit: '' };
});
for (const b of BUILDS) {
  if (!fs.existsSync(path.join(b.dist, 'extension.js'))) throw new Error(`no build in ${b.dist}`);
  try { b.commit = fs.readFileSync(path.join(b.dist, '..', '.profile-commit'), 'utf8').trim(); } catch { /* not recorded */ }
}
const PAGES = +(process.env.PAGES || 20);
const NEUTRAL_PAGE = 'Vaults profile';
const VAULT = 'Profile Vault';

fs.mkdirSync(OUT, { recursive: true });
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-'));
roam.out = OUT; roam.logDir = WORK;

// ---------- memory ----------
const memLog = [];
/** Samples Roam's memory every 0.5 s until stop() and returns { peak, mean of the samples from settleFrom ms }. */
function sampler(label, settleFrom = 0) {
  let peak = 0, sum = 0, n = 0, on = true;
  const t0 = Date.now();
  const done = (async () => {
    while (on) {
      const m = roamMB(), t = Date.now() - t0;
      if (m > 0) { peak = Math.max(peak, m); if (t >= settleFrom) { sum += m; n++; } }
      memLog.push(`${label}\t${(t / 1000).toFixed(1)}\t${m.toFixed(0)}`);
      await sleep(500);
    }
    return { peak, mean: n ? sum / n : NaN };
  })();
  return { stop: () => { on = false; return done; } };
}
async function sampleFor(label, ms, settleFrom) { const s = sampler(label, settleFrom); await sleep(ms); return s.stop(); }

// ---------- timing in the page ----------
/** Clicks a settings button (in the vault's row if `row`) and resolves with the ms until the vault's
 *  status, watched in the page, has left `ready` and come back to it. */
const timeStatus = (button, ready, row, timeout) => evalIn(async ([button, ready, row, timeout, vault]) => {
  const rowEl = () => [...document.querySelectorAll('.rv-settings-row')].find((r) => r.querySelector('.rv-settings-name')?.firstChild?.textContent.trim() === vault);
  const status = () => rowEl()?.querySelector('.rv-settings-status')?.textContent.trim() ?? '';
  const scope = row ? rowEl() : document.querySelector('.rv-settings-actions');
  const b = [...(scope?.querySelectorAll('button') ?? [])].find((b) => b.innerText.trim() === button);
  if (!b) throw new Error(`no "${button}" button`);
  let left = false;
  const t0 = performance.now();
  const end = new Promise((res) => {
    const look = () => { const s = status(); if (s !== ready) left = true; else if (left) { mo.disconnect(); res(performance.now() - t0); } };
    const mo = new MutationObserver(look);
    mo.observe(document.querySelector('.rv-settings') ?? document.body, { childList: true, subtree: true, characterData: true });
    // a status that never changes means the button did nothing (or the change was too quick to draw)
    setTimeout(() => { if (!left) { mo.disconnect(); res(-1); } }, 10000);
    setTimeout(() => { mo.disconnect(); res(null); }, timeout);
    queueMicrotask(look);
  });
  b.click();
  return end;
}, [button, ready, row, timeout, VAULT]);

/** Opens the Roam page `title` and returns { total, fill, head }: ms from opening it to the vault
 *  panel for that title being filled, ms from the panel getting that title to being filled, and the
 *  panel's heading. */
const timePage = (title) => evalIn(async (title) => {
  const t0 = performance.now();
  let tagged = null;
  const done = new Promise((res) => {
    const mo = new MutationObserver((records) => {
      for (const r of records) {
        const el = r.target;
        if (!(el instanceof HTMLElement) || !el.classList?.contains('rv-panel')) {
          if (tagged === null) { const p = document.querySelector('.roam-article .rv-panel'); if (p?.dataset.title === title) tagged = performance.now(); }
          continue;
        }
        if (el.dataset.title !== title) continue;
        if (tagged === null) tagged = performance.now();
        if (r.type === 'childList' && el.querySelector('.rv-sec-head')) { mo.disconnect(); return res(performance.now()); }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-title'] });
    setTimeout(() => { mo.disconnect(); res(null); }, 30000);
  });
  await window.roamAlphaAPI.ui.mainWindow.openPage({ page: { title } });
  const t1 = await done;
  const head = document.querySelector('.roam-article .rv-panel .rv-sec-head strong')?.textContent ?? '';
  return { total: t1 === null ? null : t1 - t0, fill: t1 === null || tagged === null ? null : t1 - tagged, head };
}, title);

// ---------- results ----------
const results = []; // { size, notes, files, mb, build, commit, metrics: {}, errors: [] }
const roamVersion = (() => { try { return execFileSync('dpkg-query', ['-W', '-f=${Version}', 'roam-research'], { encoding: 'utf8' }); } catch { return '?'; } })();
const METRICS = [
  ['baselineMB', 'Roam with the extension and no vault (MB, absolute)'],
  ['scanS', 'First scan (s)'],
  ['scanPeakMB', 'First scan, memory peak (MB over baseline)'],
  ['settledMB', 'Settled after the first scan (MB over baseline)'],
  ['workerHeapMB', 'Worker heap after a collection (MB)'],
  ['pageMedianMs', 'Page open to vault panel, median (ms)'],
  ['pageP95Ms', 'Page open to vault panel, p95 (ms)'],
  ['fillMedianMs', 'Vault panel lookup and render, median (ms)'],
  ['fillP95Ms', 'Vault panel lookup and render, p95 (ms)'],
  ['fillMaxMs', 'Vault panel lookup and render, max (ms)'],
  ['rescanS', 'Rescan, nothing changed (s)'],
  ['rescanPeakMB', 'Rescan, memory peak (MB over baseline)'],
  ['startS', 'Later start from the cache (s after the graph opens)'],
  ['startPeakMB', 'Later start, memory peak (MB over baseline)'],
  ['startSettledMB', 'Later start, settled (MB over baseline)'],
];
const fmt = (v) => v == null || Number.isNaN(v) ? '–' : Math.abs(v) >= 100 ? Math.round(v).toLocaleString('en-US') : (Math.round(v * 10) / 10).toString();
function writeResults() {
  const md = [`# Vaults profile`, '',
    `Roam desktop ${roamVersion} (Linux, Xvfb), hosted graph \`${GRAPH}\`. Commit ${process.env.GITHUB_SHA?.slice(0, 7) ?? 'local'}.`,
    `Builds: ${BUILDS.map((b) => `**${b.label}**${b.commit ? ` (${b.commit.slice(0, 7)})` : ''}`).join(', ')}.`, ''];
  for (const size of SIZES) {
    const rows = results.filter((r) => r.size === size);
    if (!rows.length) continue;
    const r0 = rows[0];
    md.push(`## ${size.toLocaleString('en-US')} notes`, '', `${r0.notes.toLocaleString('en-US')} notes, ${r0.files.toLocaleString('en-US')} files, ${r0.mb.toLocaleString('en-US')} MB of text on disk.`, '');
    const delta = rows.length > 1;
    md.push(`| Metric | ${rows.map((r) => r.build).join(' | ')} |${delta ? rows.slice(1).map((r) => ` ${r.build} vs ${r0.build} |`).join('') : ''}`);
    md.push(`|---|${rows.map(() => '---:|').join('')}${delta ? rows.slice(1).map(() => '---:|').join('') : ''}`);
    for (const [k, name] of METRICS) {
      const vals = rows.map((r) => r.metrics[k]);
      const deltas = delta ? rows.slice(1).map((r) => {
        const a = r0.metrics[k], b = r.metrics[k];
        return a == null || b == null || !a ? '–' : `${b >= a ? '+' : ''}${Math.round((b - a) / a * 100)}%`;
      }) : [];
      md.push(`| ${name} | ${vals.map(fmt).join(' | ')} |${deltas.map((d) => ` ${d} |`).join('')}`);
    }
    for (const r of rows) for (const e of r.errors) md.push('', `**${r.build}:** ${e}`);
    md.push('');
  }
  md.push('Memory is the private memory (dirty + clean + swap) of every Roam process from /proc, sampled every 0.5 s, ' +
    'over Roam with the extension loaded and no vault. Timings come from one run each: compare builds measured in the same run.');
  fs.writeFileSync(path.join(OUT, 'RESULTS.md'), md.join('\n') + '\n');
  fs.writeFileSync(path.join(OUT, 'profile.json'), JSON.stringify({ roam: roamVersion, graph: GRAPH, commit: process.env.GITHUB_SHA ?? null, builds: BUILDS, results }, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT, 'memory.log'), memLog.join('\n') + '\n');
}

// ---------- steps ----------
const quantile = (xs, q) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null; };
let devLoaded = false;
/** A fresh Roam running `build`, with none of the extension's state, on the neutral page. */
async function freshRoam(build) {
  await killRoam('SIGTERM');
  serve(build.dist);
  await launchRoam();
  await signIn(EMAIL, PASSWORD);
  await openGraph(GRAPH);
  if (!devLoaded) { await loadDevExtension(); devLoaded = true; }
  await clearExtensionState();
  // start again, so the baseline doesn't carry anything an earlier build left in memory
  await killRoam('SIGTERM');
  await launchRoam();
  await signIn(EMAIL, PASSWORD);
  await openGraph(GRAPH);
  await openPage(NEUTRAL_PAGE);
}

async function profileBuild(size, vault, gen, titles, build, r) {
  const m = r.metrics, ready = `${gen.notes} notes`;
  const scanTimeout = Math.max(300000, size * 6);
  log(`--- ${size} notes, build ${build.label} ---`);
  await freshRoam(build);
  await waitFor('the extension to load', async () => { await openVaultsTab(); return true; }, 60000);
  await dismissDialogs();
  await sleep(5000);
  m.baselineMB = (await sampleFor(`${size}/${build.label}/baseline`, 15000, 5000)).mean;
  const base = m.baselineMB;

  // first scan
  const s1 = sampler(`${size}/${build.label}/scan`);
  const t0 = await addVault(vault);
  await waitFor(`the first scan (${ready})`, async () => (await statusOf(VAULT)) === ready, scanTimeout, 250)
    .catch(async (e) => { await s1.stop(); throw new Error(`${e.message}; status "${await statusOf(VAULT).catch(() => '?')}"`); });
  m.scanS = (Date.now() - t0) / 1000;
  const scanMem = await s1.stop();
  log(`first scan ${m.scanS.toFixed(1)} s`);
  const settled = await sampleFor(`${size}/${build.label}/settle`, 45000, 30000);
  m.scanPeakMB = Math.max(scanMem.peak, settled.peak) - base;
  m.settledMB = settled.mean - base;
  m.workerHeapMB = await workerHeapMB().catch(() => null);
  await shot(`${size}-${build.file}-settings`);
  await dismissDialogs();

  // page render
  const totals = [], fills = [];
  for (const t of titles) {
    const x = await timePage(t);
    totals.push(x.total); fills.push(x.fill);
    if (x.total === null) r.errors.push(`no vault panel within 30 s on "${t}"`);
    await sleep(300);
  }
  log(`pages: ${totals.map((x) => x == null ? '–' : Math.round(x)).join(' ')}`);
  m.pageMedianMs = quantile(totals, 0.5); m.pageP95Ms = quantile(totals, 0.95);
  m.fillMedianMs = quantile(fills, 0.5); m.fillP95Ms = quantile(fills, 0.95); m.fillMaxMs = quantile(fills, 1);
  await shot(`${size}-${build.file}-page`);
  await openPage(NEUTRAL_PAGE);

  // Rescan, nothing changed
  await openVaultsTab();
  const s2 = sampler(`${size}/${build.label}/rescan`);
  const ms = await timeStatus('Rescan', ready, false, scanTimeout);
  const rescanMem = await s2.stop();
  if (ms === null) throw new Error('Rescan did not finish');
  if (ms < 0) throw new Error('Rescan did not change the vault\'s status within 10 s');
  m.rescanS = ms / 1000;
  m.rescanPeakMB = rescanMem.peak - base;
  log(`rescan ${m.rescanS.toFixed(1)} s`);
  await dismissDialogs();
  await sleep(10000); // let the cache settle before quitting

  // later start, from the cache
  await killRoam('SIGTERM');
  const s3 = sampler(`${size}/${build.label}/start`);
  await launchRoam();
  await signIn(EMAIL, PASSWORD);
  await openGraph(GRAPH);
  const tg = Date.now();
  await waitFor('the extension to load', async () => { await openVaultsTab(); return true; }, 60000);
  await waitFor(`the start from the cache (${ready})`, async () => (await statusOf(VAULT)) === ready, scanTimeout, 250);
  m.startS = (Date.now() - tg) / 1000;
  const startMem = await s3.stop();
  log(`later start ${m.startS.toFixed(1)} s`);
  await dismissDialogs();
  const settled2 = await sampleFor(`${size}/${build.label}/start-settle`, 30000, 15000);
  m.startPeakMB = Math.max(startMem.peak, settled2.peak) - base;
  m.startSettledMB = settled2.mean - base;
}

async function main() {
  for (const size of SIZES) {
    const vault = path.join(WORK, VAULT);
    fs.rmSync(vault, { recursive: true, force: true });
    const t0 = Date.now();
    const gen = genVault(size, vault);
    log(`generated ${size}: ${gen.files} files, ${gen.notes} notes, ${gen.mb} MB in ${Math.round((Date.now() - t0) / 1000)} s`);
    // the pages to open: notes the vault has many links to (the first daily notes, the first other
    // notes) and a few spread through it
    const daily = Math.floor(size * 0.15), half = Math.floor(PAGES / 2);
    const picks = [];
    for (let i = 0; i < Math.min(half, daily); i++) picks.push(gen.titles[i]);
    for (let i = 0; picks.length < PAGES - 3 && daily + i < gen.titles.length; i++) picks.push(gen.titles[daily + i]);
    for (let i = 1; picks.length < PAGES; i++) picks.push(gen.titles[Math.floor(gen.titles.length * i / 4)]);
    const titles = picks.map((t) => /^\d{4}-\d\d-\d\d$/.test(t) ? roamDate(t) : t);
    gen.titles = null;

    for (const build of BUILDS) {
      const r = { size, notes: gen.notes, files: gen.files, mb: gen.mb, build: build.label, commit: build.commit, metrics: {}, errors: [] };
      results.push(r);
      try {
        if (build === BUILDS[0]) await ensurePages([NEUTRAL_PAGE, ...titles]);
        await profileBuild(size, vault, gen, titles, build, r);
      } catch (e) {
        r.errors.push(e.message.split('\n')[0].replace(EMAIL || '\0', '***'));
        log('ERROR', r.errors.at(-1));
        await shot(`${size}-${build.file}-error`);
        await killRoam('SIGKILL');
      }
      // remove the vault and its cache before the next build, and leave a fresh profile for it
      try {
        if (!roam.page) { await launchRoam(); await signIn(EMAIL, PASSWORD); await openGraph(GRAPH); }
        await clearExtensionState();
      } catch (e) { log('could not clear the extension state:', e.message.split('\n')[0]); }
      writeResults();
    }
    fs.rmSync(vault, { recursive: true, force: true });
  }
}
/** Creates the pages the graph doesn't have yet. */
async function ensurePages(titles) {
  if (!roam.page) { serve(BUILDS[0].dist); await launchRoam(); await signIn(EMAIL, PASSWORD); await openGraph(GRAPH); }
  const made = await evalIn(async (titles) => {
    const api = window.roamAlphaAPI, made = [];
    for (const title of titles) {
      if (api.data.q('[:find ?u . :in $ ?t :where [?p :node/title ?t] [?p :block/uid ?u]]', title)) continue;
      await api.data.page.create({ page: { title } }); made.push(title);
    }
    return made;
  }, titles);
  if (made.length) log(`created ${made.length} pages: ${made.join(', ')}`);
}
/** 2020-01-02 as Roam titles its daily page: January 2nd, 2020. */
function roamDate(iso) {
  const d = new Date(iso + 'T00:00:00Z'), n = d.getUTCDate();
  const ord = n % 100 > 10 && n % 100 < 14 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${d.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' })} ${n}${ord}, ${d.getUTCFullYear()}`;
}

let failed = false;
try { await main(); }
catch (e) { failed = true; log('ERROR', e.message.split('\n')[0].replace(EMAIL || '\0', '***')); }
finally {
  writeResults();
  log('\n' + fs.readFileSync(path.join(OUT, 'RESULTS.md'), 'utf8'));
  await killRoam('SIGTERM').catch(() => {});
  stopServing();
  fs.rmSync(WORK, { recursive: true, force: true });
  process.exit(failed || results.some((r) => r.errors.length) ? 1 : 0);
}
