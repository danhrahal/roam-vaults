import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openLink, openLabel } from '../src/main/open-with.ts';

test('empty setting opens Obsidian, as before', () => {
  const want = 'obsidian://open?vault=My%20Vault&file=Projects%2FKernel%20sync';
  assert.equal(openLink(undefined, 'My Vault', 'Projects/Kernel sync.md'), want);
  assert.equal(openLink('', 'My Vault', 'Projects/Kernel sync.md'), want);
  assert.equal(openLink('   ', 'My Vault', 'Projects/Kernel sync.md'), want);
  assert.equal(openLabel(undefined), 'Open in Obsidian');
  assert.equal(openLabel(' '), 'Open in Obsidian');
});

test('a template fills in {vault} and {file}', () => {
  assert.equal(openLink('vscode://file/Users/me/Notes/{vault}/{file}', 'work', 'Projects/a.md'),
    'vscode://file/Users/me/Notes/work/Projects/a.md');
  assert.equal(openLink('zed://file/Users/me/{vault}/{file}', 'v', 'a.md'), 'zed://file/Users/me/v/a.md');
  assert.equal(openLink('x-bbedit://open?url=file:///Users/me/{vault}/{file}', 'v', 'a.md'), 'x-bbedit://open?url=file:///Users/me/v/a.md');
  assert.equal(openLabel('vscode://file/x/{vault}/{file}'), 'Open in editor');
});

test('spaces, # and ? in names and in the typed path are encoded', () => {
  assert.equal(openLink(' vscode://file/Users/me/My Notes/{vault}/{file} ', 'Work Vault', 'Q&A/Is #1 done?.md'),
    'vscode://file/Users/me/My%20Notes/Work%20Vault/Q%26A/Is%20%231%20done%3F.md');
  assert.equal(openLink('vscode://file/x/{file}', 'v', 'Café/ü.md'), 'vscode://file/x/Caf%C3%A9/%C3%BC.md');
});
