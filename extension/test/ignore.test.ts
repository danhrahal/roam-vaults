import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VaultIgnore } from '../src/core/ignore.ts';

test('nothing is left out without rules', () => {
  const r = new VaultIgnore();
  assert.equal(r.ignores('a.md', false), false);
  assert.equal(r.ignoresAnywhere('a/b/c.md', false), false);
});

test('.gitignore rules, root and nested, nearest one decides', () => {
  const r = new VaultIgnore();
  r.addGitignore('', 'artifacts/\n*.log\n/build\n# comment\n\nscratch.md\n');
  r.addGitignore('projects', '!scratch.md\ndrafts\n');
  assert.equal(r.ignores('artifacts', true), true);
  assert.equal(r.ignores('projects/x/artifacts', true), true, 'unanchored folder rule matches at any depth');
  assert.equal(r.ignores('artifacts', false), false, 'a folder-only rule leaves a file of that name alone');
  assert.equal(r.ignores('notes/run.log', false), true);
  assert.equal(r.ignores('build', true), true);
  assert.equal(r.ignores('projects/build', true), false, 'anchored to the root');
  assert.equal(r.ignores('scratch.md', false), true);
  assert.equal(r.ignores('projects/scratch.md', false), false, 'nested ! wins over the root rule');
  assert.equal(r.ignores('projects/drafts', true), true);
  assert.equal(r.ignores('drafts', true), false, 'nested rule applies only below its folder');
  assert.equal(r.ignores('Note.md', false), false);
});

test('ignoresAnywhere checks every folder a path sits in', () => {
  const r = new VaultIgnore();
  r.addGitignore('', 'artifacts/\n');
  assert.equal(r.ignoresAnywhere('projects/a/artifacts/run/out.md', false), true);
  assert.equal(r.ignoresAnywhere('projects/a/notes/out.md', false), false);
});

test('CRLF .gitignore files', () => {
  const r = new VaultIgnore();
  r.addGitignore('', 'tmp/\r\n*.bak\r\n');
  assert.equal(r.ignores('tmp', true), true);
  assert.equal(r.ignores('x.bak', false), true);
});

test("Obsidian's Excluded files: path prefixes and /regex/", () => {
  const r = new VaultIgnore();
  r.setObsidianFilters(['Archive/', 'Templates', '/\\.excalidraw\\.md$/', '/[/', 42, '']);
  assert.equal(r.ignores('Archive', true), true);
  assert.equal(r.ignores('Archived', true), false);
  assert.equal(r.ignores('Templates', true), true);
  assert.equal(r.ignores('Templates.md', false), true, 'a plain entry is a prefix, as in Obsidian');
  assert.equal(r.ignores('Drawings/a.excalidraw.md', false), true);
  assert.equal(r.ignores('Drawings', true), false, 'an expression is tested against files');
  assert.equal(r.ignores('Notes/a.md', false), false);
});

test('a missing or malformed userIgnoreFilters leaves nothing out', () => {
  const r = new VaultIgnore();
  r.setObsidianFilters(undefined);
  r.setObsidianFilters('Archive/');
  assert.equal(r.ignores('Archive', true), false);
});
