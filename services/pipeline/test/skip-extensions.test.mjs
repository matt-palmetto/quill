import assert from 'node:assert/strict';
import test from 'node:test';

import { SKIP_EXTENSIONS, shouldSkipExtension } from '../src/lib/skip-extensions.mjs';

test('shouldSkipExtension matches known media/binary/archive/db extensions case-insensitively', () => {
  for (const ext of ['jpg', 'PNG', 'Mp4', 'zip', 'DMG', 'sqlite', 'exe', 'dylib', 'photoslibrary']) {
    assert.equal(shouldSkipExtension(ext), true, `expected .${ext} to be skipped`);
  }
});

test('shouldSkipExtension accepts a leading dot or a bare extension', () => {
  assert.equal(shouldSkipExtension('.png'), true);
  assert.equal(shouldSkipExtension('png'), true);
});

test('shouldSkipExtension does not skip common text/document extensions', () => {
  for (const ext of ['md', 'txt', 'json', 'yaml', 'csv', 'html', 'pdf', 'docx', 'pptx', 'xlsx']) {
    assert.equal(shouldSkipExtension(ext), false, `.${ext} must remain extractable, not skip-listed`);
  }
});

test('shouldSkipExtension rejects non-string input instead of throwing', () => {
  assert.equal(shouldSkipExtension(undefined), false);
  assert.equal(shouldSkipExtension(null), false);
});

test('SKIP_EXTENSIONS covers every media/binary/archive category named in CONTRACT.md', () => {
  const requiredExamples = [
    'jpg', 'png', 'gif', 'heic', 'mp4', 'mov', 'mp3', 'wav', 'zip', 'dmg', 'iso', 'pkg',
    'app', 'exe', 'dll', 'so', 'dylib', 'sqlite', 'db', 'photoslibrary',
  ];
  for (const ext of requiredExamples) {
    assert.ok(SKIP_EXTENSIONS.has(ext), `CONTRACT.md-named extension .${ext} missing from skip list`);
  }
});

// --- embed policy: tokens only for prose/documents ---
import { shouldEmbed } from '../src/lib/embed-policy.mjs';

test('shouldEmbed: documents policy embeds prose, not source code', () => {
  for (const p of ['/c/a.pdf', '/c/b.docx', '/c/notes.md', '/c/x.txt', '/c/s.pptx', '/c/t.xlsx']) {
    assert.equal(shouldEmbed(p, 'documents'), true, `${p} should embed`);
  }
  for (const p of ['/c/a.ts', '/c/b.py', '/c/c.json', '/c/d.yaml', '/c/e.sh', '/c/f.h', '/c/Dockerfile']) {
    assert.equal(shouldEmbed(p, 'documents'), false, `${p} must not spend embed tokens`);
  }
});

test('shouldEmbed: none policy never embeds, all policy always embeds', () => {
  assert.equal(shouldEmbed('/c/notes.md', 'none'), false);
  assert.equal(shouldEmbed('/c/a.pdf', 'none'), false);
  assert.equal(shouldEmbed('/c/a.ts', 'all'), true);
});
