import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { deriveOrigin, enabledRoots, isExcluded, loadSources } from '../src/lib/sources.mjs';

test('deriveOrigin: "path-segment" uses the first relative path segment', () => {
  const root = { name: 'cloud-drives', origin: 'path-segment' };
  assert.equal(deriveOrigin(root, ['matt', 'projects', 'notes.md']), 'matt');
  assert.equal(deriveOrigin(root, ['example-org', 'q1.xlsx']), 'example-org');
  assert.throws(() => deriveOrigin(root, []), /own root/);
});

test('deriveOrigin: a fixed origin string ignores the path entirely', () => {
  assert.equal(deriveOrigin({ name: 'archives', origin: 'archives' }, ['legacy', 'file.txt']), 'archives');
  assert.equal(deriveOrigin({ name: 'mac-sync', origin: 'matt' }, ['Documents', 'a.md']), 'matt');
});

test('isExcluded: anchored prefix rule only excludes the named top-level directory', () => {
  const exclude = ['/sarah'];
  assert.equal(isExcluded(['sarah'], exclude), true);
  assert.equal(isExcluded(['sarah', 'notes.md'], exclude), true);
  assert.equal(isExcluded(['matt', 'sarah', 'notes.md'], exclude), false, 'anchored rule must not match nested "sarah"');
  assert.equal(isExcluded(['sarahsmith'], exclude), false, 'must not prefix-match a longer name');
});

test('isExcluded: basename rule matches the entry itself regardless of depth', () => {
  // isExcluded judges the entry being evaluated (its own basename, the last segment).
  // The walker calls it at every level before descending, so a rule like "objects"
  // excludes that directory -- and everything under it, since the walker never
  // descends past a match -- without isExcluded needing to reason about ancestors.
  const exclude = ['objects', 'refs'];
  assert.equal(isExcluded(['objects'], exclude), true);
  assert.equal(isExcluded(['myrepo.git', 'objects'], exclude), true);
  assert.equal(isExcluded(['myrepo.git', 'HEAD'], exclude), false);
});

test('isExcluded: suffix rule matches bare-repo-style directory names', () => {
  const exclude = ['*.git'];
  assert.equal(isExcluded(['myrepo.git'], exclude), true);
  assert.equal(isExcluded(['nested', 'myrepo.git'], exclude), true);
  assert.equal(isExcluded(['myrepo'], exclude), false);
});

test('isExcluded: no rules or empty path never excludes', () => {
  assert.equal(isExcluded(['anything'], []), false);
  assert.equal(isExcluded([], ['/sarah']), false);
});

test('loadSources: parses roots, defaults exclude/enabled, and matches CONTRACT.md origins', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quill-sources-'));
  try {
    const configPath = join(dir, 'sources.json');
    await writeFile(configPath, JSON.stringify({
      roots: [
        { name: 'cloud-drives', path: '/corpus/cloud-drives', origin: 'path-segment', exclude: ['/sarah'] },
        { name: 'archives', path: '/corpus/archives', origin: 'archives' },
        { name: 'mac-sync', path: '/corpus/mac-sync', origin: 'matt' },
        { name: 'git-mirrors', path: '/corpus/git-mirrors', origin: 'git-mirrors', enabled: false, exclude: ['.git'] },
      ],
    }));

    const config = await loadSources(configPath);
    assert.equal(config.roots.length, 4);

    const cloudDrives = config.roots.find((root) => root.name === 'cloud-drives');
    assert.deepEqual(cloudDrives.exclude, ['/sarah']);
    assert.equal(cloudDrives.enabled, true);

    const archives = config.roots.find((root) => root.name === 'archives');
    assert.deepEqual(archives.exclude, [], 'exclude defaults to an empty array');

    const gitMirrors = config.roots.find((root) => root.name === 'git-mirrors');
    assert.equal(gitMirrors.enabled, false);

    const enabled = enabledRoots(config).map((root) => root.name);
    assert.deepEqual(enabled, ['cloud-drives', 'archives', 'mac-sync']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadSources: the repo sources.json carries the CONTRACT.md roots and policies', async () => {
  const configPath = new URL('../sources.json', import.meta.url);
  const config = await loadSources(configPath);
  const names = config.roots.map((root) => root.name);
  // Required roots must all be present; extra corpus roots may be added
  // (e.g. `inbox`) without breaking this test.
  for (const required of ['archives', 'cloud-drives', 'git-mirrors', 'mac-sync']) {
    assert.ok(names.includes(required), `missing root ${required}`);
  }
  // mac-sync is git-backed source: keyword-only, no embed tokens.
  assert.equal(config.roots.find((r) => r.name === 'mac-sync').embed, 'none');

  const cloudDrives = config.roots.find((root) => root.name === 'cloud-drives');
  assert.equal(cloudDrives.origin, 'path-segment');
  // /sarah was excluded on 2026-08-06 and deliberately UN-excluded on 2026-08-07
  // at Matt's explicit instruction. Her files remain filterable via origin='sarah'
  // because cloud-drives derives origin from the first path segment.
  assert.ok(!cloudDrives.exclude.includes('/sarah'), 'sarah exclusion was lifted 2026-08-07');
  assert.ok(cloudDrives.exclude.includes('node_modules'));

  const macSync = config.roots.find((root) => root.name === 'mac-sync');
  for (const noise of ['node_modules', '.git', 'Library', 'Caches']) {
    assert.ok(macSync.exclude.includes(noise), `mac-sync must exclude ${noise}`);
  }

  const gitMirrors = config.roots.find((root) => root.name === 'git-mirrors');
  assert.equal(gitMirrors.enabled, false);

  await assert.rejects(() => loadSources('/nonexistent/sources.json'), Error);
});

test('loadSources: rejects a config with no roots array', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quill-sources-bad-'));
  try {
    const configPath = join(dir, 'sources.json');
    await writeFile(configPath, JSON.stringify({}));
    await assert.rejects(() => loadSources(configPath), /roots/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- worktrees are never indexed (Matt, 2026-08-07) ---
test('isExcluded: git worktrees are excluded globally, under any name or depth', () => {
  const cases = [
    ['Development', 'quarry', 'worktrees', 'feat-x', 'src', 'a.ts'],
    ['Development', 'm7-navi', '.claude', 'worktrees', 'm7-navi-69', 'b.py'],
    ['pi-maint-worktrees', 'repo', 'c.md'],
    ['Development', 'proj', '.worktrees', 'wt1', 'd.txt'],
    ['Development', 'proj-worktree', 'e.md'],
    ['Development', 'proj', 'WorkTrees', 'f.md'],
  ];
  for (const segs of cases) {
    assert.equal(isExcluded(segs, []), true, `must exclude ${segs.join('/')}`);
  }
  assert.equal(isExcluded(['Development', 'quarry', 'src', 'ok.ts'], []), false);
});
