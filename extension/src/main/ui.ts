// DOM pieces: styles, toasts, the "External Vault References" panel and the read-only note viewer.
// Plain DOM with Blueprint 3 class names (Roam ships Blueprint), so no bundled UI library.
import type { PageResult, Backlink } from '../engine.ts';
import { renderMarkdown, inline } from './markdown.ts';
import { contextOf, kidsAt, type OutlineBlock, type LineContext } from '../core/outline.ts';

export const ATTR = 'data-roam-vaults';

const STYLES = `
.rv-panel{padding-top:12px;margin:0 -4px 0 -16px}
.rv-counts{display:flex;flex-wrap:wrap;gap:4px 20px;margin:-20px 0 22px}
.rv-counts:empty{display:none}
.rv-counts strong{color:rgb(206,217,224);cursor:pointer}
.rv-panel:empty{display:none}
.rv-sec{margin-bottom:12px}
.rv-sec-head{display:flex;align-items:center;height:24px;gap:2px;cursor:pointer;user-select:none}
.rv-sec-head strong{color:rgb(206,217,224)}
.rv-sec-head .rv-head-caret{visibility:hidden}
.rv-sec-head:hover .rv-head-caret{visibility:visible;opacity:1}
.rv-spacer{flex:1}
.rv-sec.rv-collapsed .rv-sec-body{display:none}
.rv-sec-body{margin-top:4px}
.rv-more{height:1px}
.rv-group-title{margin-right:8px}
.rv-fuzzy .rv-note{opacity:.55}
.rv-fuzzy .rv-group-caret{opacity:.55}
.rv-note .rm-highlight{margin:0;padding:0}
.rv-vault{color:#8a9ba8}
.rv-tagref{color:rgb(167,182,194);font-size:14px;margin-right:8px}
.rv-content{margin-left:4px}
.rv-panel .rm-block-text{cursor:pointer}
.rv-panel .rm-block-main:hover>.controls .rv-kids-caret{opacity:.7}
.rv-checkbox{pointer-events:none}
.rv-viewer [data-rv-target]{cursor:pointer}
.rv-viewer .rm-page-ref--link:hover,.rv-viewer .rm-page-ref--tag:hover{text-decoration:underline}
.rv-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:30000;max-width:560px;padding:10px 14px;border-radius:6px;background:#30404d;color:#fff;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.25)}
.rv-toast.rv-error{background:#a82a2a}
.rv-overlay{position:fixed;inset:0;z-index:20000;background:rgba(16,22,26,.45);display:flex;align-items:center;justify-content:center}
.rv-viewer{background:#fff;color:#182026;width:min(760px,92vw);max-height:86vh;display:flex;flex-direction:column;border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,.3)}
.rv-viewer-head{flex:none;display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid #e5e5ea}
.rv-viewer-head h3{margin:0;font-size:18px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rv-viewer-path{flex:none;padding:4px 16px 0;color:#8a8a99;font-size:12px}
.rv-viewer-body{min-height:0;padding:8px 20px 20px;overflow:auto;font-size:14px;line-height:1.55}
.rv-viewer-body h1,.rv-viewer-body h2,.rv-viewer-body h3,.rv-viewer-body h4{margin:14px 0 6px}
.rv-viewer-body p{margin:4px 0}
.rv-viewer-body pre{background:#f5f8fa;padding:8px;border-radius:4px;overflow:auto;font-size:12px}
.rv-viewer-body code{background:#f5f8fa;padding:0 3px;border-radius:3px;font-size:12px}
.rv-viewer-body .rv-li{padding-left:calc(var(--d,0) * 18px + 14px);position:relative}
.rv-viewer-body .rv-li::before{content:'•';position:absolute;left:calc(var(--d,0) * 18px + 2px);color:#8a8a99}
.rv-viewer-body .rv-missing,.rv-viewer-body .rv-missing .rm-page-ref{color:#8a8a99;cursor:default}
.rv-viewer-body .rv-props{font-size:12px;color:#5c7080;background:#f5f8fa;border-radius:4px;padding:6px 10px;margin:8px 0}
.rv-viewer-body .rv-hl{background:#fff3b0;border-radius:3px}
.rv-viewer-body blockquote{border-left:3px solid #d8e1e8;margin:4px 0;padding-left:10px;color:#5c7080}
.rv-viewer-body.rv-preview{padding:4px 12px 6px 20px;max-height:480px;overflow:auto}
.rv-viewer-body h2{font-size:20px}.rv-viewer-body h3{font-size:17px}.rv-viewer-body h4,.rv-viewer-body h5,.rv-viewer-body h6{font-size:15px}
.rv-preview h2,.rv-preview h3,.rv-preview h4{margin:8px 0 4px;font-weight:600}
.bp3-dark .rv-viewer-body.rv-preview{color:inherit}
.rv-settings{display:flex;flex-direction:column;gap:10px;width:280px;max-width:100%;min-width:0}
.rv-settings-list{display:flex;flex-direction:column;gap:6px}
.rv-settings-actions,.rv-settings-btns{display:flex;flex-wrap:wrap;gap:4px 8px}
.rv-settings-row{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px}
.rv-settings-name{flex:1 1 100px;min-width:0;font-weight:500;overflow-wrap:anywhere}
.rv-settings .bp3-button{flex:0 1 auto;white-space:normal;text-align:left}
.rv-settings-status{font-weight:400;font-size:12px;color:#8a9ba8}
.rv-settings .bp3-progress-bar{margin:5px 0 3px}
.bp3-dark .rv-sec-head strong{color:#5c7080}
`;

export function installStyles(): () => void {
  const el = document.createElement('style');
  el.setAttribute(ATTR, 'style');
  el.textContent = STYLES;
  document.head.append(el);
  return () => el.remove();
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, any> = {}, ...kids: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of kids) if (c != null && c !== false) el.append(c);
  return el;
}

// ---------- toast ----------
let toastEl: HTMLElement | null = null;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function notify(text: string, kind: 'info' | 'error' = 'info', ms = 5000) {
  toastEl?.remove();
  clearTimeout(toastTimer);
  toastEl = h('div', { class: `rv-toast${kind === 'error' ? ' rv-error' : ''}`, [ATTR]: 'toast', onclick: () => toastEl?.remove() }, text);
  document.body.append(toastEl);
  toastTimer = setTimeout(() => toastEl?.remove(), ms);
}
export function removeToast() { toastEl?.remove(); clearTimeout(toastTimer); }

// ---------- panel ----------
// One panel per Roam reference area: a single "External Vault References" fold covering every
// connected vault. Laid out like Roam's own Linked References: a grey bold header with a
// caret, then one group per note (caret + vault/path title), and the note's lines as bullets.
export type SectionState =
  | { kind: 'permission' }
  | { kind: 'unfinished' } // the last scan never finished: it waits for Rescan
  | { kind: 'indexing'; detail: string }
  | { kind: 'error'; detail: string }
  | { kind: 'ready'; result: PageResult | null; live: boolean };

export interface SectionActions {
  reconnect(): void;
  remove(): void;
  view(path: string, line?: number): void;
  openOutside(path: string): void;
  openLabel(): string;
  read(path: string): Promise<string>;
  resolve(target: string, from: string): Promise<string | null>;
  /** Read the lines of linking notes that came without their text (`unread`), and put it in them. */
  lines(notes: Backlink[]): Promise<void>;
  /** A click on a link in a line: open the page it names in Roam, in the sidebar with shift held.
   *  False when the graph has no such page. */
  go(title: string, sidebar: boolean): boolean;
}
export interface PanelVault { id: string; name: string; state: SectionState; act: SectionActions }

const COLLAPSE_KEY = 'roam-vaults:collapsed';
const isCollapsed = () => { try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; } };
/** Note groups the user opened or closed, overriding the default. Kept across re-renders. */
const groupOpen = new Map<string, boolean>();

const caret = (open: boolean, extra = '') =>
  h('span', { class: `bp3-icon-standard bp3-icon-caret-down rm-caret ${open ? 'rm-caret-open' : 'rm-caret-closed'} ${extra}` });

/** Draws the panel and returns how many notes it lists. */
export function renderPanel(el: HTMLElement, vaults: PanelVault[]): number {
  el.className = 'rv-panel';
  drawing.get(el)?.disconnect(); drawing.delete(el);
  // With no vaults connected the page shows nothing; vaults are added in the extension's settings.
  if (!vaults.length) { el.replaceChildren(); return 0; }
  // Like Roam's own reference sections, nothing explains itself: no matches means no section,
  // and vaults that are indexing, unreadable or waiting for permission are shown only in settings.
  const ready: { v: PanelVault; r: PageResult }[] = [];
  let n = 0;
  for (const v of vaults) {
    const s = v.state;
    if (s.kind !== 'ready' || !s.result) continue;
    ready.push({ v, r: s.result });
    n += new Set([...s.result.counterparts, ...s.result.backlinks, ...s.result.tagged, ...(s.result.fuzzy ?? [])].map((x) => x.path)).size;
  }
  if (!n) { el.replaceChildren(); return 0; }
  const collapsed = isCollapsed();
  el.replaceChildren(h('div', { class: 'rv-sec' + (collapsed ? ' rv-collapsed' : '') },
    sectionHead(`${n} External Vault References`, !collapsed),
    h('div', { class: 'rv-sec-body' }, resultBody(el, ready, vaults.length > 1))));
  return n;
}

// ---------- counts under the page title ----------
// One line under the title with the page's reference counts, worded and styled like Roam's own
// section headers, so what is further down shows without scrolling. A click jumps to that section.
export interface Count { label: string; jump(): void }
export function renderCounts(el: HTMLElement, counts: Count[]) {
  const key = counts.map((c) => c.label).join('\n');
  if (el.dataset.key === key) return; // unchanged: leave the DOM alone, so this doesn't feed the page observer
  el.dataset.key = key;
  el.replaceChildren(...counts.map((c) => h('strong', { onclick: c.jump }, c.label)));
}

// A page named like a common tag can have thousands of notes to list, and drawing them all at once
// holds Roam up (4,000 notes: over half a second; 40,000: 20 seconds). So a panel draws its first
// notes and adds the rest as the end of the list comes near the window, as the page is scrolled.
const ROWS_AT_ONCE = 60;
const NEAR = '800px'; // how far below the window the end of the list may be before more is drawn
/** The observer watching the end of each panel's list, while there are notes left to draw. */
const drawing = new WeakMap<HTMLElement, IntersectionObserver>();
/** How many notes each panel has drawn, and for which page. */
const reached = new WeakMap<HTMLElement, { title: string; n: number }>();
/** How many notes a panel has drawn for the page it is on: drawn again, it draws as many. */
export function drawnRows(panel: HTMLElement): number {
  const r = reached.get(panel);
  return r && r.title === (panel.dataset.title ?? '') ? r.n : 0;
}

function sectionHead(label: string, open = true, tools: HTMLElement[] = []) {
  const head = h('div', { class: 'rv-sec-head' },
    caret(open, 'rv-head-caret'),
    h('strong', {}, label),
    h('span', { class: 'rv-spacer' }),
    ...tools);
  head.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const now = !isCollapsed();
    try { localStorage.setItem(COLLAPSE_KEY, now ? '1' : '0'); } catch { /* private mode */ }
    document.querySelectorAll<HTMLElement>(`.rv-panel[${ATTR}] .rv-sec`).forEach((s) => {
      s.classList.toggle('rv-collapsed', now);
      s.querySelector('.rv-head-caret')?.classList.replace(now ? 'rm-caret-open' : 'rm-caret-closed', now ? 'rm-caret-closed' : 'rm-caret-open');
    });
  });
  return head;
}

/** Notes from every ready vault: the notes that are this page first, then notes linking here,
 *  then notes only tagged here. With more than one vault, each title starts with its vault name. */
function resultBody(panel: HTMLElement, list: { v: PanelVault; r: PageResult }[], showVault: boolean): HTMLElement {
  const out = h('div', { class: 'rv-groups rm-mentions refs-by-page-view' }); // Roam's own list classes: its style sheet lays the groups out
  /** One note: caret + (vault/)path as a namespaced title (+ tag); content shows when open. The open-in-editor button lives in the viewer. */
  const group = (v: PanelVault, key: string, path: string, defOpen: boolean, tag: string | undefined, content: () => HTMLElement, cls = '', marks: number[] = []) => {
    const k = `${v.id}\n${key}\n${path}`;
    const box = h('div', { class: 'rv-content' });
    const c = caret(false, 'rm-caret-showing rv-group-caret dont-focus-block');
    const set = (open: boolean) => {
      c.classList.toggle('rm-caret-open', open); c.classList.toggle('rm-caret-closed', !open);
      box.hidden = !open;
      if (open && !box.childNodes.length) box.append(content());
    };
    c.addEventListener('click', () => {
      const open = box.hidden;
      groupOpen.delete(k); groupOpen.set(k, open);
      if (groupOpen.size > 500) groupOpen.delete(groupOpen.keys().next().value!);
      set(open);
    });
    set(groupOpen.get(k) ?? defOpen);
    // The folders a note is in, in the grey a vault's name has, so the title reads as the note's name.
    const name = path.lastIndexOf('/') + 1;
    return h('div', { class: 'rm-ref-page-view rv-group' + cls },
      h('div', { class: 'flex-h-box rm-title-arrow-wrapper rv-group-head' }, c,
        h('div', { class: 'rm-ref-page-view-title rv-group-title' },
          h('a', { onclick: () => v.act.view(path) },
            h('span', { class: 'rm-page__title rv-note', style: 'cursor: pointer; text-decoration: none;' },
              showVault || name ? h('span', { class: 'rv-vault' }, (showVault ? `${v.name}/` : '') + path.slice(0, name)) : null,
              ...marked(path.slice(name).replace(/\.md$/i, ''), 0, marks)))),
        tag ? h('span', { class: 'rv-tagref' }, `#${tag}`) : null),
      box);
  };
  // rm-reference-item: Roam's own grey reference background.
  const preview = (v: PanelVault, path: string) => () => { const el = h('div', { class: 'rv-viewer-body rv-preview rm-reference-item' }); loadPreview(el, path, v.act); return el; };

  // The list is worked out whole, as one small function per note, and drawn a part at a time.
  // A note shows once: a tagged note that also links here gets the tag next to its title.
  const rows: (() => HTMLElement)[] = [];
  /** The linking note a row is, where its lines are still to be read, by row. */
  const unread = new Map<number, { v: PanelVault; b: Backlink }>();
  const tagsOf = new Map(list.map(({ v, r }) => [v, new Map(r.tagged.map((t) => [t.path, t.tag]))]));
  const tagOnce = (v: PanelVault, path: string) => {
    const tags = tagsOf.get(v)!, t = tags.get(path); tags.delete(path);
    return t;
  };
  for (const { v, r } of list) for (const c of r.counterparts) {
    const tag = tagOnce(v, c.path);
    rows.push(() => group(v, 'page', c.path, false, tag, preview(v, c.path)));
  }
  for (const { v, r } of list) for (const b of r.backlinks) {
    const tag = tagOnce(v, b.path);
    if (b.unread) unread.set(rows.length, { v, b });
    rows.push(() => group(v, 'links', b.path, true, tag, () => {
      const box = h('div', {});
      // Two links in one block are one reference, as in Roam.
      const draw = () => box.replaceChildren(...b.lines.filter((l, i) => !b.lines.slice(0, i).some((x) => (x.at ?? x.line) === (l.at ?? l.line)))
        .map((l) => referenceEl({ text: l.text, line: l.at ?? l.line, up: l.up ?? [], kids: l.kids ?? [], cut: l.cut }, b.path, v.act)));
      draw();
      // Its lines are read before it is drawn (see `ahead`); if that failed, they are filled in here.
      if (b.unread) v.act.lines([b]).then(draw, () => {});
      return box;
    }));
  }
  for (const { v, r } of list) for (const t of r.tagged) {
    const tag = tagOnce(v, t.path);
    if (tag !== undefined) rows.push(() => group(v, 'tag', t.path, false, tag, preview(v, t.path)));
  }
  // Notes with a name close to the title: last, faded, the letters that differ highlighted.
  for (const { v, r } of list) for (const f of r.fuzzy ?? [])
    rows.push(() => group(v, 'fuzzy', f.path, false, undefined, preview(v, f.path), ' rv-fuzzy', f.marks));

  // Drawn again for the same page (a note changed, a vault finished scanning), the list is as long
  // as it had got, so the page doesn't jump under a reader who had scrolled down it.
  const title = panel.dataset.title ?? '', before = reached.get(panel);
  let drawn = 0;
  const more = (n: number) => {
    const part = rows.slice(drawn, drawn + n).map((row) => row());
    drawn += part.length;
    reached.set(panel, { title, n: drawn });
    return part;
  };
  /** Read the lines of the next `n` notes, a vault at a time, so they are drawn with their text. */
  const ahead = async (n: number) => {
    const by = new Map<PanelVault, Backlink[]>();
    for (let i = drawn; i < drawn + n; i++) {
      const u = unread.get(i);
      if (u?.b.unread) by.set(u.v, [...(by.get(u.v) ?? []), u.b]);
    }
    await Promise.all([...by].map(([v, notes]) => v.act.lines(notes).catch(() => {})));
  };
  out.append(...more(Math.max(ROWS_AT_ONCE, before?.title === title ? before.n : 0)));
  if (drawn < rows.length && typeof IntersectionObserver !== 'undefined') {
    const end = h('div', { class: 'rv-more' });
    out.append(end);
    let reading = false;
    // scrollMargin: Roam's page scrolls inside the window, and rootMargin alone stops at that box
    const io = new IntersectionObserver(async (entries) => {
      if (!end.isConnected) { io.disconnect(); return; } // the panel was drawn again or removed
      if (reading || !entries.some((e) => e.isIntersecting)) return;
      reading = true;
      try { await ahead(ROWS_AT_ONCE); } finally { reading = false; }
      if (!end.isConnected) { io.disconnect(); return; }
      end.before(...more(ROWS_AT_ONCE));
      io.unobserve(end);
      if (drawn < rows.length) io.observe(end); // looked at afresh: it may still be near the window
      else { end.remove(); io.disconnect(); drawing.delete(panel); }
    }, { rootMargin: `0px 0px ${NEAR} 0px`, scrollMargin: `0px 0px ${NEAR} 0px` } as IntersectionObserverInit);
    io.observe(end);
    drawing.set(panel, io);
  } else if (drawn < rows.length) out.append(...more(rows.length));
  return out;
}

/** Text with some ranges (flat [start, end) pairs, counted from `from`) in Roam's ^^highlight^^. */
function marked(text: string, from: number, marks: number[]): (string | HTMLElement)[] {
  const out: (string | HTMLElement)[] = [];
  let at = 0;
  for (let i = 0; i < marks.length; i += 2) {
    const a = from + marks[i], b = from + marks[i + 1];
    if (a > at) out.push(text.slice(at, a));
    out.push(h('span', { class: 'rm-highlight' }, text.slice(a, b)));
    at = b;
  }
  out.push(text.slice(at));
  return out;
}

// A reference is drawn with the elements and class names of Roam's own Linked References (measured
// in Roam, 2026-11-22): the grey box, the path of parent blocks, the block with its bullet, and its
// children under it. Roam's style sheet does the rest, and so does a theme.

/** One reference: a block of a note with the blocks above it as a path. A click on a part of the
 *  path shows that block in its place, with everything under it, as in Roam. */
function referenceEl(block: LineContext, path: string, act: SectionActions): HTMLElement {
  const inner = h('div', {});
  const show = (b: LineContext) => {
    const zoom = h('div', { class: 'rm-zoom zoom-mentions-view' }, ...b.up.map((u, i) => {
      const text = h('span', {});
      inline(text, u.text.split('\n')[0].replace(/^#{1,6}\s+/, ''));
      return h('div', { class: 'rm-zoom-item', onclick: async (e: MouseEvent) => {
        if (linkClick(e, path, act)) return;
        try { show(contextOf(await act.read(path), [u.line])[0]); } catch { /* the note is gone: the panel is drawn again when the vault notices */ }
      } },
        h('span', { class: 'rm-zoom-item-content' }, h('div', { class: 'parent-path-wrapper' }, text)),
        i < b.up.length - 1 ? h('span', { class: 'bp3-icon-standard bp3-icon-chevron-right rm-mention-icon' }) : null);
    }));
    inner.replaceChildren(zoom, blockEl(b, 1, path, act));
  };
  show(block);
  return h('div', { class: 'flex-h-box flex-align-start' }, h('div', { class: 'rm-reference-item dont-focus-block' }, inner));
}

/** A block as Roam draws one: caret (when it has children), bullet, text, and its children nested
 *  under it. A click on the bullet or the text opens the note at that line. */
function blockEl(b: OutlineBlock, level: number, path: string, act: SectionActions): HTMLElement {
  const heading = /^(#{1,6})\s+/.exec(b.text);
  const text = h('span', {});
  inline(text, heading ? b.text.slice(heading[0].length) : b.text);
  const has = b.kids.length > 0 || !!b.cut;
  let open = false; // as in Roam's Linked References: a reference's children show when asked for
  const kidsBox = h('div', { class: `rm-block-children rm-block__children rm-level-${level + 1}` });
  const c = h('span', { class: `bp3-icon-standard bp3-icon-caret-down rm-caret rm-caret-hidden${has ? ' rv-kids-caret' : ''}` });
  const bullet = h('span', { class: 'rm-bullet', onclick: () => act.view(path, b.line) },
    h('span', { class: 'bp3-popover-wrapper' }, h('span', { class: 'bp3-popover-target' }, h('span', { class: 'rm-bullet__inner' })))); // Roam's wrappers: they set the line the dot sits on
  const box = h('div', { class: 'roam-block-container rm-block rm-not-focused block-bullet-view' + (heading ? ` rm-heading-level-${Math.min(heading[1].length, 3)}` : '') },
    h('div', { class: 'rm-block-main rm-block__self' },
      h('div', { class: 'controls rm-block__controls noselect' }, h('span', { class: 'block-expand' }, c), bullet),
      h('div', { class: 'rm-block__input rm-block__input--view roam-block dont-unfocus-block hoverparent rm-block-text',
        onclick: (e: MouseEvent) => { if (!linkClick(e, path, act) && !getSelection()?.toString()) act.view(path, b.line); } }, text),
      h('div', { class: 'rm-block-separator' }),
      h('div', { style: 'min-width: 24px;' })),
    kidsBox);
  let kids = b.kids, whole = !b.cut;
  const set = async () => {
    box.classList.toggle('rm-block--open', open || !has); box.classList.toggle('rm-block--closed', has && !open);
    c.classList.toggle('rm-caret-open', open); c.classList.toggle('rm-caret-closed', !open);
    bullet.classList.toggle('rm-bullet--closed', has && !open);
    if (!open) { kidsBox.replaceChildren(bar()); return; }
    if (!whole) { try { kids = kidsAt(await act.read(path), b.line); whole = true; } catch { /* drawn with what came */ } }
    kidsBox.replaceChildren(bar(), ...kids.map((k) => blockEl(k, level + 1, path, act)));
  };
  const toggle = (e: Event) => { e.stopPropagation(); if (has) { open = !open; set(); } };
  const bar = () => h('div', { class: 'rm-multibar', onclick: toggle });
  c.addEventListener('click', toggle);
  set();
  return box;
}

/** A click that landed on a link in a line: the page it names opens in Roam (in the sidebar with
 *  shift held); when the graph has no such page, the note it names opens in the viewer. Returns
 *  whether the click was on a link. */
function linkClick(e: MouseEvent, from: string, act: SectionActions): boolean {
  const t = e.target as Element;
  if (t.closest?.('a[href]')) { e.stopPropagation(); return true; } // a web link: the browser opens it
  const a = t.closest?.<HTMLElement>('[data-rv-target]');
  if (!a) return false;
  e.stopPropagation(); e.preventDefault();
  const target = a.dataset.rvTarget!;
  const name = target.slice(target.lastIndexOf('/') + 1).replace(/\.md$/i, '');
  if (act.go(target, e.shiftKey) || (name !== target && act.go(name, e.shiftKey))) return true;
  act.resolve(target, from).then((to) => { if (to) act.view(to); }, () => {});
  return true;
}

async function loadPreview(el: HTMLElement, path: string, act: SectionActions) {
  try {
    el.replaceChildren(renderMarkdown(await act.read(path)));
    wireLinks(el, path, (to) => act.view(to), act.resolve);
  } catch (e) {
    el.replaceChildren(`Couldn't read this note: ${(e as Error).message}`);
  }
}

/** Make [[links]] in rendered note text open their target note (in the viewer). */
function wireLinks(el: HTMLElement, from: string, open: (to: string) => void, resolve: (t: string, f: string) => Promise<string | null>) {
  el.querySelectorAll<HTMLElement>('[data-rv-target]').forEach((a) => {
    a.addEventListener('click', async (e) => {
      e.stopPropagation();
      const to = await resolve(a.dataset.rvTarget!, from);
      if (to) open(to); else a.classList.add('rv-missing');
    });
  });
}

// ---------- viewer ----------
export interface ViewerActions {
  read(path: string): Promise<string>;
  resolve(target: string, from: string): Promise<string | null>;
  /** Open the note in Obsidian or the editor set in "Open notes with". */
  openOutside(path: string): void;
  openLabel(): string;
}
let overlay: HTMLElement | null = null;
const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); closeViewer(); } };
export function closeViewer() { overlay?.remove(); overlay = null; document.removeEventListener('keydown', onKey, true); }

export async function openViewer(path: string, line: number | undefined, act: ViewerActions) {
  closeViewer();
  const title = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
  const body = h('div', { class: 'rv-viewer-body' });
  overlay = h('div', { class: 'rv-overlay', [ATTR]: 'viewer', onclick: (e: Event) => { if (e.target === overlay) closeViewer(); } },
    h('div', { class: 'rv-viewer', role: 'dialog', 'aria-label': title },
      h('div', { class: 'rv-viewer-head' },
        h('h3', {}, title),
        h('button', { class: 'bp3-button bp3-small', onclick: () => act.openOutside(path) }, act.openLabel()),
        h('button', { class: 'bp3-button bp3-small bp3-minimal', 'aria-label': 'Close', onclick: closeViewer }, '✕')),
      h('div', { class: 'rv-viewer-path' }, path),
      body));
  document.body.append(overlay);
  document.addEventListener('keydown', onKey, true);
  try {
    const text = await act.read(path);
    body.replaceChildren(renderMarkdown(text, line));
    wireLinks(body, path, (to) => openViewer(to, undefined, act), act.resolve);
  } catch (e) {
    body.replaceChildren(`Couldn't read this note: ${(e as Error).message}`);
  }
}
