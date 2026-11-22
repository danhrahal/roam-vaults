// The built extension next to Roam's own Linked References, in Roam's public help graph (the real
// web app, headless, no sign-in). The same made-up notes are written twice: as pages in the graph
// (the help graph takes writes in memory only, so nothing is saved anywhere) and as a vault of the
// files Roam's Markdown export makes of those pages. Then one page shows both sections, and each
// vault reference is compared with Roam's reference for the same block: text, elements, positions,
// colours and sizes.
//
//   npm run build && node test/help-graph.mjs [out-dir]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const OUT = path.resolve(process.argv[2] || 'help-graph-out');
fs.mkdirSync(OUT, { recursive: true });
const code = fs.readFileSync(new URL('../dist/extension.js', import.meta.url), 'utf8');
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok }); console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : detail); };

// A bakery's notes. Each page is a tree of blocks: [text, children].
const PAGE = 'Sourdough';
export const PAGES = {
  [PAGE]: [['Starter fed at 7 and 19'], ['Bulk at 26°, four folds']],
  Wholesale: [
    ['Week of July 13th–19th, 2026', [
      ['[[July 13th, 2026]]', [
        ['Tasting with [[Harbour Cafe]]', [
          ['~6 standing orders at 20–40 loaves, twice a week ([[Sourdough]], [Rye]([[Dark rye]]), Baguette, [[Focaccia]], #wholesale)', [
            ['{{[[TODO]]}} send the price list by Friday'],
            ['delivery by 7', [['back door, ask for **Inés**']]],
          ]],
        ]],
      ]],
    ]],
    ['Week of July 6th–12th, 2026', [
      ['[[July 8th, 2026]]', [
        ['[[Sourdough]] trial bake with [[Tomás Lindqvist]] — two proofs, ^^18 hours^^ cold, then the stone deck.'],
      ]],
    ]],
  ],
  'July 9th, 2026': [['Oven:: [[Sourdough]] at 250° with steam, __then__ 220° dry'], ['Flour order arrived']],
};
/** A page as Roam's Markdown export writes it: "- " blocks, four spaces a level. */
export const exported = (blocks, depth = 0) => blocks.map(([text, kids = []]) => `${'    '.repeat(depth)}- ${text}\n${exported(kids, depth + 1)}`).join('');
// The vault: the export of those pages, the daily note filed by year as in a vault kept by hand.
const FILES = { 'Wholesale.md': exported(PAGES.Wholesale), 'Days/2026/July 9th, 2026.md': exported(PAGES['July 9th, 2026']), 'Sourdough.md': exported(PAGES[PAGE]) };

const browser = await chromium.launch({ env: { ...process.env, LC_ALL: 'C.UTF-8' } });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 })).newPage();
const errors = [];
page.on('pageerror', (e) => { errors.push(e.message); console.log('[pageerror]', e.message.slice(0, 300)); });
await page.goto('https://roamresearch.com/#/app/help', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.roamAlphaAPI && document.querySelector('.rm-title-display, .roam-log-container'), null, { timeout: 90000 });
await page.waitForTimeout(3000);
await page.addStyleTag({ content: '.bp3-portal .bp3-toast-container{display:none!important}' }); // the help graph's own warning

// the pages, in the graph's memory
await page.evaluate(async (PAGES) => {
  const api = window.roamAlphaAPI;
  let n = 0;
  const add = async (parent, blocks) => {
    for (const [i, [string, kids = []]] of blocks.entries()) {
      const uid = `rvhg${String(++n).padStart(5, '0')}`;
      try { await api.createBlock({ location: { 'parent-uid': parent, order: i }, block: { string, uid, open: true } }); } catch (e) { throw new Error(`block ${string}: ${e?.message ?? e}`); }
      await add(uid, kids);
    }
  };
  for (const [title, blocks] of Object.entries(PAGES)) {
    // a page some block already linked to exists by now; a daily note's uid is its date
    const uid = api.pull('[:block/uid]', [':node/title', title])?.[':block/uid'] ?? `rvhgp${String(++n).padStart(4, '0')}`;
    try { await api.createPage({ page: { title, uid } }); } catch (e) { if (!api.pull('[:block/uid]', [':node/title', title])) throw new Error(`page ${title}: ${e?.message ?? e}`); }
    await add(api.pull('[:block/uid]', [':node/title', title])[':block/uid'], blocks);
  }
}, PAGES);

// the vault, in the browser's private file system, connected through the folder picker (stubbed)
await page.evaluate(async ({ FILES, code }) => {
  const root = await navigator.storage.getDirectory();
  const vault = await root.getDirectoryHandle('Bakery', { create: true });
  for (const [rel, text] of Object.entries(FILES)) {
    const parts = rel.split('/'); let d = vault;
    for (const s of parts.slice(0, -1)) d = await d.getDirectoryHandle(s, { create: true });
    const w = await (await d.getFileHandle(parts.at(-1), { create: true })).createWritable();
    await w.write(text); await w.close();
  }
  window.showDirectoryPicker = async () => vault;
  const ext = (await import(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })))).default;
  window.__ext = ext;
  let cfg; const stored = {};
  await ext.onload({ extensionAPI: { settings: { panel: { create: (c) => { cfg = c; } }, get: (k) => stored[k], set: (k, v) => { stored[k] = v; } } } });
  // The settings tab's component, drawn by Roam's own React in a box of its own.
  const box = document.createElement('div'); box.style.display = 'none'; document.body.append(box);
  window.ReactDOM.render(window.React.createElement(cfg.settings.find((s) => s.action?.component).action.component), box);
  await new Promise((r) => setTimeout(r, 300));
  [...box.querySelectorAll('button')].find((b) => b.textContent === 'Add vault folder').click();
}, { FILES, code });

const open = async (title) => {
  await page.evaluate((title) => window.roamAlphaAPI.ui.mainWindow.openPage({ page: { title } }), title);
  await page.waitForFunction((title) => document.querySelector('.roam-article .rm-title-display')?.textContent === title, title);
};
await open(PAGE);
await page.waitForSelector('.rv-panel .rm-reference-item', { timeout: 30000 });
await page.waitForTimeout(800);
const shot = async (name, sel = '.roam-article') => { await page.locator(sel).first().screenshot({ path: path.join(OUT, name) }); };
await shot('1-both-sections.png');

// ---------- the same reference, drawn by Roam and drawn from the vault ----------
/** What is measured of each reference: where its parts are inside its grey box, and how they are
 *  drawn; and of each group, where its title row and boxes are. */
const measure = () => page.evaluate(() => {
  const GROUP = { caret: '.rm-title-arrow-wrapper > .rm-caret', title: '.rm-ref-page-view-title', item: '.rm-reference-item' };
  const ITEM = {
    crumbs: '.rm-zoom', crumb: '.rm-zoom-item-content', chevron: '.rm-mention-icon', controls: '.rm-block__controls', caret: '.block-expand .rm-caret', bullet: '.rm-bullet__inner',
    text: '.rm-block-text', link: '.rm-block-text .rm-page-ref--link', bracket: '.rm-block-text .rm-page-ref__brackets', tag: '.rm-page-ref--tag', alias: '.rm-alias', bold: '.rm-bold', italic: '.rm-italics',
    highlight: '.rm-highlight', attr: '.rm-attr-ref', checkbox: '.checkmark', kids: '.rm-block-children', multibar: '.rm-multibar',
  };
  const STYLE = ['color', 'backgroundColor', 'fontSize', 'lineHeight', 'fontWeight', 'fontStyle', 'opacity', 'marginTop', 'marginLeft', 'paddingTop', 'paddingLeft', 'borderTopColor', 'borderTopWidth'];
  const r1 = (n) => Math.round(n * 10) / 10;
  const parts = (root, sels) => {
    const o = root.getBoundingClientRect(), out = {};
    for (const [k, sel] of Object.entries(sels)) {
      out[k] = [...root.querySelectorAll(sel)].filter((e) => e.getClientRects().length || k === 'crumbs').map((e) => {
        const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
        return { x: r1(r.left - o.left), y: r1(r.top - o.top), w: r1(r.width), h: r1(r.height), ...Object.fromEntries(STYLE.map((p) => [p, cs[p]])) };
      });
    }
    return out;
  };
  const groups = (root) => Object.fromEntries([...root.querySelectorAll('.rm-ref-page-view')].map((g) => {
    const title = g.querySelector('.rm-page__title').textContent;
    const p = parts(g, GROUP);
    for (const t of p.title) delete t.w; // a vault title has the note's folders before its name
    for (const i of p.item) delete i.y; // Roam's order inside a page is its own
    const items = Object.fromEntries([...g.querySelectorAll('.rm-reference-item')].map((it) => [it.querySelector('.rm-block-text').innerText, { parts: parts(it, ITEM), text: [...it.querySelectorAll('.rm-zoom-item-content, .rm-block-text')].map((e) => e.innerText) }]));
    return [title.slice(title.lastIndexOf('/') + 1), { parts: p, items, height: r1(g.getBoundingClientRect().height) }];
  }));
  const left = (e) => r1(e.getBoundingClientRect().left);
  const roamRoot = document.querySelector('.roam-article .rm-reference-container'), ours = document.querySelector('.roam-article .rv-panel');
  return {
    roam: groups(roamRoot), vault: groups(ours),
    heads: [roamRoot.querySelector('strong'), ours.querySelector('strong')].map((s) => ({ x: left(s), color: getComputedStyle(s).color, weight: getComputedStyle(s).fontWeight, text: s.textContent })),
    groupsLeft: [left(roamRoot.querySelector('.rm-ref-page-view')), left(ours.querySelector('.rm-ref-page-view'))],
  };
});
const differ = (a, b, out, at = '') => {
  for (const k of Object.keys(a)) {
    if (a[k].length !== b[k].length) { out.push(`${at}${k}: ${a[k].length} in Roam, ${b[k].length} from the vault`); continue; }
    a[k].forEach((x, i) => { for (const p of Object.keys(x)) if (x[p] !== b[k][i][p] && !(typeof x[p] === 'number' && Math.abs(x[p] - b[k][i][p]) <= 0.5)) out.push(`${at}${k}[${i}].${p}: ${x[p]} in Roam, ${b[k][i][p]} from the vault`); });
  }
};
const compare = (m, what) => {
  check(`${what}: both headers start at the same place, in the same grey`, m.heads[0].x === m.heads[1].x && m.heads[0].color === m.heads[1].color && m.heads[0].weight === m.heads[1].weight, JSON.stringify(m.heads));
  check(`${what}: note groups start where Roam's page groups do`, m.groupsLeft[0] === m.groupsLeft[1], JSON.stringify(m.groupsLeft));
  for (const [name, r] of Object.entries(m.roam)) {
    const v = m.vault[name];
    if (!v) { check(`${what}: "${name}" is listed from the vault`, false); continue; }
    const texts = (g) => JSON.stringify(Object.values(g.items).map((i) => i.text).sort());
    check(`${what}: "${name}" reads the same`, texts(r) === texts(v), `\n  roam  ${texts(r)}\n  vault ${texts(v)}`);
    const diffs = [];
    differ(r.parts, v.parts, diffs);
    if (r.height !== v.height) diffs.push(`height: ${r.height} in Roam, ${v.height} from the vault`);
    let n = Object.values(r.parts).flat().length;
    for (const [text, item] of Object.entries(r.items)) {
      if (!v.items[text]) continue;
      differ(item.parts, v.items[text].parts, diffs, `"${text.slice(0, 24)}…" `);
      n += Object.values(item.parts).flat().length;
    }
    check(`${what}: "${name}" is drawn the same (place, size and style of ${n} parts)`, !diffs.length, '\n  ' + diffs.slice(0, 40).join('\n  '));
  }
};
compare(await measure(), 'brackets shown');

// Roam's bracket setting (Ctrl-C Ctrl-B): vault lines follow it
const brackets = () => page.evaluate(() => [document.querySelectorAll('.rm-reference-container .rm-page-ref__brackets').length, [...document.querySelectorAll('.rv-panel .rm-page-ref__brackets')].filter((b) => b.getClientRects().length).length]);
const b0 = await brackets();
await page.locator('.rm-title-display').first().click({ position: { x: 600, y: 5 } }).catch(() => {});
await page.keyboard.press('Escape');
await page.keyboard.press('Control+c'); await page.keyboard.press('Control+b');
await page.waitForTimeout(600);
const b1 = await brackets();
check('brackets show in vault lines while Roam shows its own', b0[0] > 0 && b0[1] === b0[0], JSON.stringify(b0));
check('hiding brackets in Roam hides them in vault lines', b1[0] === 0 && b1[1] === 0, JSON.stringify(b1));
compare(await measure(), 'brackets hidden');
await shot('2-brackets-hidden.png');
fs.writeFileSync(path.join(OUT, 'measured.json'), JSON.stringify(await measure(), null, 1));

check('no errors in the page', !errors.length, errors.join(' | ').slice(0, 500));
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length} of ${checks.length} checks pass`);
await browser.close();
process.exit(failed.length ? 1 : 0);
