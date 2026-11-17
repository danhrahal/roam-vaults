// Where the note viewer's open button sends a note. By default that's Obsidian. The "Open notes with"
// setting holds a link for another editor instead, with {vault} (the vault folder's name) and {file}
// (the note's path inside the vault) in it, e.g. vscode://file/Users/me/Notes/{vault}/{file}.
// The extension can't learn a folder's full path (Roam's Electron no longer exposes it), so the
// person types the part before {vault} once.

export const OPEN_WITH_SETTING = 'open-with';

/** Encode each path segment, so spaces, # and ? in names can't break the link. */
const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

export function obsidianLink(vault: string, path: string): string {
  return `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(path.replace(/\.md$/i, ''))}`;
}

/** The link to open a note with: the setting's template filled in, or Obsidian when it's empty. */
export function openLink(template: unknown, vault: string, path: string): string {
  const t = typeof template === 'string' ? template.trim() : '';
  if (!t) return obsidianLink(vault, path);
  // Spaces typed in the template (e.g. "/Users/me/My Notes/") aren't valid in a link either.
  return t.replace(/ /g, '%20').replace(/\{vault\}/g, encodePath(vault)).replace(/\{file\}/g, encodePath(path));
}

export const openLabel = (template: unknown) =>
  typeof template === 'string' && template.trim() ? 'Open in editor' : 'Open in Obsidian';
