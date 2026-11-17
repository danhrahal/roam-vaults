// Which paths in a vault are left out of the index: those matched by the vault's .gitignore files
// (root and nested, with git's rules) and by Obsidian's Excluded files (`userIgnoreFilters` in
// .obsidian/app.json). No DOM, no Node APIs, so it runs in the Web Worker and in Node tests alike.
import ignore, { type Ignore } from 'ignore';

export const GITIGNORE = '.gitignore';

/** One Excluded files entry: `/regex/` is a regular expression, anything else a path prefix. */
type Filter = { prefix: string } | { re: RegExp };

export class VaultIgnore {
  /** .gitignore rules by the folder they were found in ('' is the vault itself). */
  private git = new Map<string, Ignore>();
  private filters: Filter[] = [];

  /** Obsidian's Excluded files, as stored in `userIgnoreFilters`. Entries that can't be used are skipped. */
  setObsidianFilters(list: unknown) {
    this.filters = [];
    if (!Array.isArray(list)) return;
    for (const f of list) {
      if (typeof f !== 'string' || !f) continue;
      const s = f.normalize('NFC');
      if (s.length > 2 && s.startsWith('/') && s.endsWith('/')) {
        try { this.filters.push({ re: new RegExp(s.slice(1, -1)) }); } catch { /* not a valid expression */ }
      } else this.filters.push({ prefix: s });
    }
  }

  /** The text of the .gitignore file in folder `dir` ('' for the vault's own). */
  addGitignore(dir: string, text: string) {
    const rules = text.normalize('NFC').split(/\r?\n/);
    const ig = this.git.get(dir) ?? ignore();
    this.git.set(dir, ig.add(rules));
  }

  get empty() { return !this.git.size && !this.filters.length; }

  /**
   * Is this path left out, given that none of the folders it sits in is? This is the check the
   * scan makes, since it doesn't go into a folder that is left out.
   */
  ignores(path: string, isDir: boolean): boolean {
    if (this.empty) return false;
    for (const f of this.filters) {
      // A prefix leaves out a folder whose path with a slash starts with it ("Archive/"), and so
      // everything in it. An expression is tested against files only, as Obsidian does.
      if ('prefix' in f ? (isDir ? `${path}/` : path).startsWith(f.prefix) : !isDir && f.re.test(path)) return true;
    }
    // The nearest .gitignore with a rule for the path decides, as in git.
    let dir = path;
    for (;;) {
      const i = dir.lastIndexOf('/');
      dir = i < 0 ? '' : dir.slice(0, i);
      const ig = this.git.get(dir);
      if (ig) {
        const rel = (dir ? path.slice(dir.length + 1) : path) + (isDir ? '/' : '');
        let r;
        try { r = ig.test(rel); } catch { r = { ignored: false, unignored: false }; } // a name it can't check
        if (r.ignored) return true;
        if (r.unignored) return false;
      }
      if (!dir) return false;
    }
  }

  /** Is this path left out, or any folder it sits in? This is the check the file watcher makes. */
  ignoresAnywhere(path: string, isDir: boolean): boolean {
    if (this.empty) return false;
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) if (this.ignores(parts.slice(0, i).join('/'), true)) return true;
    return this.ignores(path, isDir);
  }
}
