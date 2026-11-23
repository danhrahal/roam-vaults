// RahalOS: runs the extension from a `roam/js` block instead of Roam Depot, so it loads on every
// Roam start without Developer mode. Roam Depot hands an extension an `extensionAPI`; this file
// stands in for it: settings are kept in localStorage, and the settings page Roam Depot would show
// opens from the command palette ("Vaults: configurar") in a dialog.
import ext from './main/index.ts';

type Setting = { id: string; name: string; description?: string; action: any };
const KEY = 'rahalos-vaults-fork:';
const GLOBAL = 'rahalosVaultsFork';
// RahalOS keeps one vault, the Dropbox folder: notes open through RahalOS Portal by default.
const DEFAULTS: Record<string, unknown> = { 'open-with': 'rahalos://open/{file}' };

const w = window as any;
w[GLOBAL]?.unload?.(); // the block ran again (edited or reloaded): drop the previous copy first

let panel: { tabTitle: string; settings: Setting[] } | null = null;
const settings = {
  get(id: string): unknown {
    try { const v = localStorage.getItem(KEY + id); return v === null ? DEFAULTS[id] : JSON.parse(v); } catch { return DEFAULTS[id]; }
  },
  set(id: string, v: unknown) { try { localStorage.setItem(KEY + id, JSON.stringify(v)); } catch { /* private mode */ } },
  getAll() { return {}; },
  panel: { create(p: { tabTitle: string; settings: Setting[] }) { panel = p; } },
};

let overlay: HTMLElement | null = null;
function closeDialog() {
  if (!overlay) return;
  try { w.ReactDOM?.unmountComponentAtNode?.(overlay.querySelector('.rvf-react')); } catch { /* not mounted */ }
  overlay.remove(); overlay = null;
}
function el(tag: string, props: Record<string, any> = {}, ...kids: (Node | string | null)[]) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') e.className = v;
    else e.setAttribute(k, String(v));
  }
  for (const c of kids) if (c != null) e.append(c);
  return e;
}
function openDialog() {
  closeDialog();
  if (!panel) return;
  const rows = panel.settings.map((s) => {
    const a = s.action;
    let control: HTMLElement;
    if (a.type === 'reactComponent') {
      control = el('div', { class: 'rvf-react' });
      w.ReactDOM?.render?.(w.React.createElement(a.component), control);
    } else if (a.type === 'switch') {
      const input = el('input', { type: 'checkbox', 'aria-label': s.name }) as HTMLInputElement;
      input.checked = settings.get(s.id) === true;
      input.addEventListener('change', () => { settings.set(s.id, input.checked); a.onChange?.({ target: { checked: input.checked } }); });
      control = el('label', { class: 'bp3-control bp3-switch' }, input, el('span', { class: 'bp3-control-indicator' }));
    } else if (a.type === 'input') {
      const input = el('input', { class: 'bp3-input', type: 'text', placeholder: a.placeholder ?? '', 'aria-label': s.name, style: 'width:100%' }) as HTMLInputElement;
      input.value = String(settings.get(s.id) ?? '');
      input.addEventListener('change', () => settings.set(s.id, input.value.trim()));
      control = input;
    } else if (a.type === 'button') {
      control = el('button', { class: 'bp3-button', onclick: a.onClick }, a.content ?? s.name);
    } else return null;
    return el('div', { class: 'rvf-row' }, el('div', { class: 'rvf-name' }, s.name), s.description ? el('div', { class: 'rvf-desc' }, s.description) : null, control);
  });
  const close = el('button', { class: 'bp3-button bp3-minimal bp3-icon-cross', title: 'Fechar', 'aria-label': 'Fechar', onclick: closeDialog });
  overlay = el('div', { class: 'rvf-overlay', onclick: (e: MouseEvent) => { if (e.target === overlay) closeDialog(); } },
    el('div', { class: 'rvf-dialog bp3-card', role: 'dialog', 'aria-label': 'Vaults' },
      el('div', { class: 'rvf-head' }, el('strong', {}, 'Vaults'), close), ...rows));
  document.body.append(overlay);
}

const style = el('style', {}, `
.rvf-overlay{position:fixed;inset:0;z-index:20000;background:rgba(16,22,26,.45);display:flex;align-items:center;justify-content:center}
.rvf-dialog{width:min(460px,92vw);max-height:86vh;overflow:auto;display:flex;flex-direction:column;gap:14px;padding:16px 18px}
.rvf-head{display:flex;align-items:center;justify-content:space-between;font-size:16px}
.rvf-name{font-weight:600;margin-bottom:2px}
.rvf-desc{font-size:12px;color:#8a9ba8;margin-bottom:6px}
`);

const LABEL = 'Vaults: configurar';
async function load() {
  document.head.append(style);
  w.roamAlphaAPI?.ui?.commandPalette?.addCommand?.({ label: LABEL, callback: openDialog });
  await ext.onload({ extensionAPI: { settings } });
}
function unload() {
  closeDialog();
  style.remove();
  try { w.roamAlphaAPI?.ui?.commandPalette?.removeCommand?.({ label: LABEL }); } catch { /* gone */ }
  ext.onunload();
  if (w[GLOBAL]?.unload === unload) delete w[GLOBAL];
}
w[GLOBAL] = { unload, openSettings: openDialog, version: 'rahalos' };
load().catch((e) => console.error('[Vaults fork] load failed', e));
