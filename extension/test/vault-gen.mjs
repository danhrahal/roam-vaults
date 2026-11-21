// The deterministic test vault used by the memory bench, the real-Roam run and the profiler: folders,
// frontmatter, links (some unresolved), tags, daily notes, about 3 KB a note with a few of 50 KB, and
// one empty attachment per ten notes. The same `n` and `seed` always give the same files.
//
// genFiles() yields [path, text] one note at a time, so a vault of a million notes (about 3 GB of
// text) can be written without holding it in memory. Both functions are self-contained: the memory
// bench stringifies them into a browser worker.

/** Yields [path, text] for every file. If `info` is given, `info.titles` gets the notes' titles in
 *  generation order (daily notes first) before the first file is yielded. */
export function* genFiles(n, seed = 42, info = null) {
  let s = seed >>> 0;
  const rnd = () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const W = 'alpha beta gamma delta project meeting notes design review plan budget hiring research market customer product roadmap quarterly retro idea draft system memory index graph vault link neural garden reading book paper summary people team launch metric growth strategy pricing interview onboarding weekly daily journal travel recipe health finance music film history science math physics biology language writing essay thread question answer source quote concept model theory practice habit goal value'.split(' ');
  const cap = (w) => w[0].toUpperCase() + w.slice(1);
  const folders = [''];
  for (let i = 0; i < 150; i++) folders.push((rnd() < 0.5 ? cap(pick(W)) : cap(pick(W)) + '/' + cap(pick(W))) + (rnd() < 0.3 ? '/' + cap(pick(W)) : ''));
  const titles = [], seen = new Set();
  for (let i = 0; i < Math.floor(n * 0.15); i++) titles.push({ dir: 'Daily', t: new Date(Date.UTC(2020, 0, 1) + i * 86400000).toISOString().slice(0, 10) });
  while (titles.length < n) {
    const k = 1 + Math.floor(rnd() * 4); let t = cap(pick(W)); for (let j = 1; j < k; j++) t += ' ' + pick(W);
    if (rnd() < 0.5) t += ' ' + Math.floor(rnd() * 1000);
    if (seen.has(t.toLowerCase()) && rnd() < 0.97) continue;
    seen.add(t.toLowerCase());
    titles.push({ dir: pick(folders), t });
  }
  seen.clear();
  if (info) info.titles = titles;
  const sentence = () => { const k = 6 + Math.floor(rnd() * 14); let o = cap(pick(W)); for (let j = 1; j < k; j++) o += ' ' + pick(W); return o + '.'; };
  const link = () => {
    const r = rnd();
    if (r < 0.1) return `[[${cap(pick(W))} ${pick(W)} ${pick(W)} unwritten]]`;
    const t = titles[Math.floor(Math.pow(rnd(), 3) * titles.length)].t; // a few notes get most of the links
    return r < 0.2 ? `[[${t}|${pick(W)} ${pick(W)}]]` : r < 0.25 ? `[[${t}#${cap(pick(W))}]]` : `[[${t}]]`;
  };
  for (const { dir, t } of titles) {
    let o = '';
    if (rnd() < 0.7) {
      o += '---\n';
      if (rnd() < 0.15) o += `aliases: [${cap(pick(W))} ${pick(W)}, ${pick(W)}]\n`;
      o += `tags: [${pick(W)}, ${pick(W)}/${pick(W)}]\n`;
      o += `created: 2024-0${1 + Math.floor(rnd() * 9)}-1${Math.floor(rnd() * 9)}T10:00:00\nupdated: 2025-0${1 + Math.floor(rnd() * 9)}-1${Math.floor(rnd() * 9)}T10:00:00\n`;
      o += `status: ${pick(['draft', 'done', 'evergreen', 'seedling'])}\nsource: https://example.com/${pick(W)}/${pick(W)}-${Math.floor(rnd() * 1e6)}\nauthor: "${cap(pick(W))} ${cap(pick(W))}"\n`;
      if (rnd() < 0.3) o += `related:\n  - "${link()}"\n  - "${link()}"\n`;
      if (rnd() < 0.3) o += `summary: ${sentence()} ${sentence()}\n`;
      o += '---\n';
    }
    o += `# ${t}\n\n`;
    const paras = Math.max(1, Math.floor(Math.exp(0.8 + rnd() * 2.2 + (rnd() < 0.03 ? 2 : 0)))); // about 3 KB a note, a few of 50 KB
    for (let p = 0; p < paras; p++) {
      if (p % 5 === 4) o += `## ${cap(pick(W))} ${pick(W)}\n\n`;
      if (rnd() < 0.5) { const k = 2 + Math.floor(rnd() * 5); for (let j = 0; j < k; j++) o += `- ${sentence()}${rnd() < 0.45 ? ' ' + link() : ''}${rnd() < 0.08 ? ' #' + pick(W) : ''}${rnd() < 0.03 ? ' ^blk' + Math.floor(rnd() * 1e5) : ''}\n`; o += '\n'; }
      else o += `${sentence()} ${rnd() < 0.5 ? link() + ' ' : ''}${sentence()} ${sentence()}${rnd() < 0.2 ? ' [' + pick(W) + '](https://example.com/' + pick(W) + ')' : ''}\n\n`;
    }
    yield [`${dir ? dir + '/' : ''}${t}.md`, o];
  }
  for (let i = 0; i < Math.floor(n / 10); i++) yield [`Attachments/${pick(W)}-${i}.png`, ''];
}

/** The whole vault as a Map of path to text (a later file with the same path replaces an earlier one). */
export function gen(n, seed = 42) {
  return new Map(genFiles(n, seed));
}
