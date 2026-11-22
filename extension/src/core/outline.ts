// The outline around a line of a note: the block the line is in, the blocks above it (its parents,
// outermost first) and the blocks under it. This is what Roam shows for a linked reference: the path
// of parent blocks, the block, its children. In Markdown a block is a list item ("- text", with the
// lines that continue it), nested by indentation, as Roam, Logseq and Obsidian's outliners write it;
// a heading is a parent of what follows it, up to the next heading of its level. No Node APIs.

export interface OutlineBlock {
  /** The block's text without its list marker; the lines of a block of several lines, joined by \n. */
  text: string;
  /** 0-based line of the file the block starts on. */
  line: number;
  /** Blocks nested under it. */
  kids: OutlineBlock[];
  /** It has blocks under it that were left out (see MAX_KIDS). */
  cut?: true;
}
export interface LineContext extends OutlineBlock {
  /** Parent blocks, outermost first: headings, then the list items the block is nested in. */
  up: { text: string; line: number }[];
}

/** Blocks under one line that come with it. A block that has more is marked `cut`. */
export const MAX_KIDS = 200;
/** Characters of one block that are kept. */
export const MAX_BLOCK = 2000;

const RE_ITEM = /^([ \t]*)(?:[-*+]|\d+[.)])(?:[ \t]+(.*))?$/;
const RE_RULE = /^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const RE_HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const RE_FENCE = /^[ \t]*(?:[-*+][ \t]+)?(`{3,}|~{3,})/;

interface Row {
  /** Width of the leading white space, a tab reaching the next multiple of 4. -1 for a blank line. */
  indent: number;
  kind: 'item' | 'heading' | 'text' | 'blank' | 'code';
  text: string;
  level: number; // of a heading
}

function width(ws: string): number {
  let w = 0;
  for (let i = 0; i < ws.length; i++) w = ws.charCodeAt(i) === 9 ? (w - (w % 4)) + 4 : w + 1;
  return w;
}

function rows(text: string): Row[] {
  const out: Row[] = [];
  let fence: string | null = null;
  let i = 0;
  // frontmatter is not outline
  const lines = text.split('\n');
  if (lines[0]?.replace(/\r$/, '') === '---') {
    const end = lines.findIndex((l, k) => k > 0 && /^(---|\.\.\.)\s*$/.test(l));
    if (end > 0) for (; i <= end; i++) out.push({ indent: -1, kind: 'blank', text: '', level: 0 });
  }
  for (; i < lines.length; i++) {
    const raw = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
    const ws = /^[ \t]*/.exec(raw)![0];
    const indent = width(ws);
    const f = RE_FENCE.exec(raw);
    if (fence !== null) {
      // inside a code block: never a block of its own
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && raw.trim() === f[1]) fence = null;
      out.push({ indent, kind: 'code', text: raw.slice(ws.length), level: 0 });
      continue;
    }
    let m: RegExpExecArray | null;
    if (!raw.trim()) { out.push({ indent: -1, kind: 'blank', text: '', level: 0 }); continue; }
    const item = RE_RULE.test(raw) ? null : RE_ITEM.exec(raw);
    if (f) {
      // a fence that opens and closes on its own line (```x```) is not a block of code
      const rest = raw.slice(raw.indexOf(f[1]) + f[1].length);
      if (!rest.includes(f[1])) fence = f[1];
    }
    if (item) out.push({ indent, kind: 'item', text: item[2] ?? '', level: 0 });
    else if ((m = RE_HEADING.exec(raw))) out.push({ indent: 0, kind: 'heading', text: m[2], level: m[1].length });
    else out.push({ indent, kind: f ? 'code' : 'text', text: raw.slice(ws.length), level: 0 });
  }
  return out;
}

const clip = (s: string) => (s.length > MAX_BLOCK ? s.slice(0, MAX_BLOCK - 1) + '…' : s);

/** The outline around some lines of a note. A line that is on no block of its own (a paragraph, a
 *  line of a block's code) gives the block it belongs to, or itself. */
export function contextOf(text: string, lines: number[]): LineContext[] {
  const r = rows(text);
  return lines.map((n) => context(r, Math.max(0, Math.min(n, r.length - 1))));
}

/** The first line of the block a line is in. */
function ownerOf(r: Row[], n: number): number {
  const row = r[n];
  if (!row || row.kind === 'item' || row.kind === 'heading') return n;
  // a continuation: lines further in than a list item above, with nothing less indented between
  let least = row.indent < 0 ? Infinity : row.indent;
  for (let i = n - 1; i >= 0; i--) {
    const p = r[i];
    if (p.kind === 'blank') continue;
    if (p.kind === 'heading') break;
    if (p.kind === 'item') { if (p.indent < least) return i; continue; }
    if (p.indent === 0 && p.kind === 'text') break; // a paragraph at the margin: no list above
    least = Math.min(least, p.indent);
  }
  return n;
}

/** The lines after a list item's first that are still its own text: one past the last. */
function ownEnd(r: Row[], n: number): number {
  const at = r[n].indent;
  let end = n + 1, i = n + 1;
  for (; i < r.length; i++) {
    const p = r[i];
    if (p.kind === 'blank') continue;
    if (p.kind === 'item' || p.kind === 'heading' || p.indent <= at) break;
    end = i + 1;
  }
  return end;
}

function blockText(r: Row[], n: number): string {
  const row = r[n];
  if (row.kind !== 'item') return clip(row.text);
  const end = ownEnd(r, n);
  if (end === n + 1) return clip(row.text);
  // lines that continue the item, less the indentation they share
  const more = r.slice(n + 1, end);
  const base = Math.min(...more.filter((p) => p.kind !== 'blank').map((p) => p.indent));
  return clip([row.text, ...more.map((p) => (p.kind === 'blank' ? '' : ' '.repeat(Math.max(0, p.indent - base)) + p.text))].join('\n').trimEnd());
}

function context(r: Row[], n: number): LineContext {
  if (!r.length) return { text: '', line: 0, kids: [], up: [] };
  const at = ownerOf(r, n);
  const row = r[at];
  const up: { text: string; line: number }[] = [];
  if (row.kind === 'item') {
    let least = row.indent;
    for (let i = at - 1; i >= 0 && least > 0; i--) {
      const p = r[i];
      if (p.kind === 'blank' || p.kind === 'code') continue;
      if (p.kind === 'heading') break;
      if (p.kind === 'item') { if (p.indent < least) { up.unshift({ text: firstLine(p.text), line: i }); least = p.indent; } continue; }
      if (p.indent === 0) break; // a paragraph at the margin ends the list above it
    }
  }
  // headings above: each one of a lower level than the last found
  let level = row.kind === 'heading' ? row.level : 7;
  const heads: { text: string; line: number }[] = [];
  for (let i = (up[0]?.line ?? at) - 1; i >= 0 && level > 1; i--) {
    const p = r[i];
    if (p.kind === 'heading' && p.level < level) { heads.unshift({ text: p.text, line: i }); level = p.level; }
  }
  const budget = { n: MAX_KIDS };
  const b: LineContext = { text: blockText(r, at), line: at, kids: [], up: [...heads, ...up] };
  if (row.kind === 'item') kidsOf(r, at, b, budget);
  return b;
}

const firstLine = (s: string) => clip(s);

/** Fill a list item's nested items in; returns the line after the last one. */
function kidsOf(r: Row[], n: number, into: OutlineBlock, budget: { n: number }): number {
  const at = r[n].indent;
  let i = ownEnd(r, n);
  while (i < r.length) {
    const p = r[i];
    if (p.kind === 'blank') { i++; continue; }
    if (p.kind !== 'item' || p.indent <= at) break;
    if (budget.n <= 0) { into.cut = true; return skip(r, i, at); }
    budget.n--;
    const kid: OutlineBlock = { text: blockText(r, i), line: i, kids: [] };
    into.kids.push(kid);
    i = kidsOf(r, i, kid, budget);
  }
  return i;
}

/** The first line at or after `i` that is no longer under an item indented `at`. */
function skip(r: Row[], i: number, at: number): number {
  for (; i < r.length; i++) {
    const p = r[i];
    if (p.kind === 'blank' || p.kind === 'code') continue;
    if (p.kind === 'heading' || p.indent <= at) break;
  }
  return i;
}

/** Every block under one block of a note, for a block that came `cut`. */
export function kidsAt(text: string, line: number): OutlineBlock[] {
  const r = rows(text);
  if (r[line]?.kind !== 'item') return [];
  const b: OutlineBlock = { text: '', line, kids: [] };
  kidsOf(r, line, b, { n: Infinity });
  return b.kids;
}

/** What a vault gives for one line of a note that it read: the block the line is in. */
export type LineRead = Pick<LineContext, 'text' | 'line' | 'up' | 'kids' | 'cut'>;
/** A line of a page result, once read. `at` is the line its block starts on. */
export interface ReadLine { text: string; at?: number; up?: LineRead['up']; kids?: OutlineBlock[]; cut?: true }
/** Put what was read for a line into the line a page result has for it. */
export function putLine(l: ReadLine, t: LineRead) {
  l.text = t.text; l.at = t.line; l.up = t.up; l.kids = t.kids;
  if (t.cut) l.cut = true; else delete l.cut;
}
