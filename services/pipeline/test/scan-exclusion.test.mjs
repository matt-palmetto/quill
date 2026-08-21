import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { scanRoot } from '../src/lib/scan.mjs';
import { createBudget } from '../src/lib/budget.mjs';

/**
 * Exclusion enforcement is the load-bearing safety property from CONTRACT.md/DECISIONS.md:
 * `cloud-drives/sarah` must never be read, not merely filtered out after the fact. This
 * test proves it with a mock filesystem that records every path any fs call touches and
 * asserts none of them fall under the excluded directory.
 */

function buildMockFsImpl(tree, corpusRoot, openedPaths) {
  function resolveNode(absPath) {
    if (absPath === corpusRoot) return tree;
    const rel = absPath.slice(corpusRoot.length + 1);
    let node = tree;
    for (const seg of rel.split('/')) {
      if (node === null || typeof node !== 'object') {
        throw Object.assign(new Error(`ENOTDIR: ${absPath}`), { code: 'ENOTDIR' });
      }
      node = node[seg];
      if (node === undefined) {
        throw Object.assign(new Error(`ENOENT: ${absPath}`), { code: 'ENOENT' });
      }
    }
    return node;
  }

  return {
    async readdir(dirPath) {
      openedPaths.push(dirPath);
      const node = resolveNode(dirPath);
      return Object.keys(node).map((name) => {
        const isDir = node[name] !== null && typeof node[name] === 'object';
        return {
          name,
          isDirectory: () => isDir,
          isFile: () => !isDir,
          isSymbolicLink: () => false,
        };
      });
    },
    async lstat(filePath) {
      openedPaths.push(filePath);
      const node = resolveNode(filePath);
      if (typeof node !== 'string') {
        throw Object.assign(new Error(`EISDIR: ${filePath}`), { code: 'EISDIR' });
      }
      return {
        size: Buffer.byteLength(node, 'utf8'),
        mtime: new Date(0),
        isFile: () => true,
        isSymbolicLink: () => false,
      };
    },
    createReadStream(filePath) {
      openedPaths.push(filePath);
      const node = resolveNode(filePath);
      return Readable.from([Buffer.from(node, 'utf8')]);
    },
  };
}

function createFakeDb() {
  const fileStates = new Map();
  const syncState = new Map();
  const logs = [];
  return {
    fileStates,
    logs,
    async getFileState(path) {
      return fileStates.get(path) ?? null;
    },
    async touchFileSeen(path, mtime) {
      const state = fileStates.get(path);
      if (state) {
        state.last_seen = new Date();
        state.mtime = mtime;
      }
    },
    async upsertPending({ path, root, origin, size, mtime, contentHash }) {
      fileStates.set(path, {
        path, root, origin, size, mtime, content_hash: contentHash, status: 'pending', error: null,
      });
    },
    async upsertSkipped({ path, root, origin, size, mtime, reason }) {
      fileStates.set(path, {
        path, root, origin, size, mtime, content_hash: null, status: 'skipped', error: reason,
      });
    },
    async markIndexed(path) {
      const state = fileStates.get(path);
      if (state) state.status = 'indexed';
    },
    async markError(path, error) {
      const state = fileStates.get(path) ?? { path };
      state.status = 'error';
      state.error = String(error);
      fileStates.set(path, state);
    },
    async markDeletedNotSeenSince() {
      return [];
    },
    async getPendingQueue(limit) {
      return [...fileStates.values()].filter((state) => state.status === 'pending').slice(0, limit);
    },
    async getSyncState(key) {
      return syncState.get(key) ?? null;
    },
    async setSyncState(key, value) {
      syncState.set(key, value);
    },
    async insertIngestLog(entry) {
      logs.push(entry);
    },
  };
}

test('a file under an excluded top-level directory (cloud-drives/sarah) is never opened', async () => {
  const corpusRoot = '/corpus/cloud-drives';
  const tree = {
    matt: { 'notes.md': 'hello world' },
    sarah: { 'secret.md': 'must never be read' },
    'example-org': { 'plan.txt': 'the plan' },
  };
  const openedPaths = [];
  const fsImpl = buildMockFsImpl(tree, corpusRoot, openedPaths);
  const db = createFakeDb();
  const root = { name: 'cloud-drives', path: corpusRoot, origin: 'path-segment', exclude: ['/sarah'] };
  const budget = createBudget(60);

  await scanRoot({ root, db, budget, runId: 'test-run', corpusRoot, fsImpl });

  const sarahPathsOpened = openedPaths.filter((path) => path.includes('/sarah'));
  assert.deepEqual(sarahPathsOpened, [], `excluded path was opened: ${sarahPathsOpened.join(', ')}`);

  assert.ok(db.fileStates.has('/corpus/cloud-drives/matt/notes.md'));
  assert.ok(db.fileStates.has('/corpus/cloud-drives/example-org/plan.txt'));
  assert.equal(db.fileStates.has('/corpus/cloud-drives/sarah/secret.md'), false);

  assert.equal(db.fileStates.get('/corpus/cloud-drives/matt/notes.md').origin, 'matt');
  assert.equal(db.fileStates.get('/corpus/cloud-drives/example-org/plan.txt').origin, 'example-org');

  const loggedPaths = db.logs.map((entry) => entry.path);
  assert.ok(!loggedPaths.some((path) => path && path.includes('/sarah')));
});

test('git-mirrors bare-repo internals are never opened once the root is enabled', async () => {
  const corpusRoot = '/corpus/git-mirrors';
  const tree = {
    'myrepo.git': {
      HEAD: 'ref: refs/heads/main',
      objects: { pack: { 'pack-abc.pack': 'binary garbage' } },
      refs: { heads: { main: 'deadbeef' } },
    },
  };
  const openedPaths = [];
  const fsImpl = buildMockFsImpl(tree, corpusRoot, openedPaths);
  const db = createFakeDb();
  const root = {
    name: 'git-mirrors',
    path: corpusRoot,
    origin: 'git-mirrors',
    exclude: ['.git', '*.git', 'objects', 'refs', 'hooks', 'info', 'branches', 'logs'],
  };
  const budget = createBudget(60);

  await scanRoot({ root, db, budget, runId: 'test-run', corpusRoot, fsImpl });

  const gitInternalsOpened = openedPaths.filter((path) => /\/(objects|refs)(\/|$)/u.test(path));
  assert.deepEqual(gitInternalsOpened, [], `git internals opened: ${gitInternalsOpened.join(', ')}`);
  assert.equal(db.fileStates.size, 0, 'the bare-repo dir itself matches *.git and is fully excluded');
});
