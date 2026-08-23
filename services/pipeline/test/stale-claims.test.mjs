import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';

import { createBudget } from '../src/lib/budget.mjs';
import { indexPendingQueue } from '../src/lib/index-files.mjs';
import { scanRoot } from '../src/lib/scan.mjs';

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function buildMockFsImpl(tree, corpusRoot) {
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
      const node = resolveNode(filePath);
      return Readable.from([Buffer.from(node, 'utf8')]);
    },
  };
}

function createFakeDb() {
  const fileStates = new Map();
  const syncState = new Map();
  const logs = [];
  const released = [];
  return {
    fileStates,
    logs,
    released,
    async getFileState(path) {
      return fileStates.get(path) ?? null;
    },
    async touchFileSeen(path, mtime) {
      const state = fileStates.get(path);
      if (state) {
        state.last_seen = new Date();
        state.mtime = mtime;
        state.deleted_at = null;
      }
    },
    async upsertPending({ path, root, origin, size, mtime, contentHash }) {
      fileStates.set(path, {
        path, root, origin, size, mtime, content_hash: contentHash,
        status: 'pending', error: null, last_seen: new Date(), deleted_at: null,
      });
    },
    async upsertSkipped({ path, root, origin, size, mtime, reason }) {
      fileStates.set(path, {
        path, root, origin, size, mtime, content_hash: null, status: 'skipped',
        error: reason, last_seen: new Date(),
      });
    },
    async markError(path, error) {
      const state = fileStates.get(path) ?? { path };
      state.status = 'error';
      state.error = String(error);
      state.last_seen = new Date();
      fileStates.set(path, state);
    },
    async markDeletedNotSeenSince(root, since) {
      // Mirrors db.mjs: indexing claims are not deletion candidates.
      const sinceMs = new Date(since).getTime();
      const deleted = [];
      for (const [path, state] of fileStates) {
        if (state.root !== root) continue;
        if (state.status === 'deleted' || state.status === 'indexing') continue;
        if (new Date(state.last_seen).getTime() < sinceMs) {
          state.status = 'deleted';
          state.deleted_at = new Date();
          deleted.push(path);
        }
      }
      return deleted;
    },
    async releaseClaims(paths) {
      for (const path of paths) {
        const state = fileStates.get(path);
        if (state?.status === 'indexing') state.status = 'pending';
        released.push(path);
      }
      return paths.length;
    },
    async getSyncState(key) {
      return syncState.get(key) ?? null;
    },
    async setSyncState(key, value) {
      if (value === null) syncState.delete(key);
      else syncState.set(key, value);
    },
    async insertIngestLog(entry) {
      logs.push(entry);
    },
  };
}

test('scan still bumps last_seen on an unchanged indexed file', async () => {
  const corpusRoot = '/corpus/cloud-drives';
  const body = 'already indexed';
  const tree = { matt: { 'done.md': body } };
  const db = createFakeDb();
  const path = '/corpus/cloud-drives/matt/done.md';
  const oldSeen = new Date('2026-01-01T00:00:00.000Z');
  db.fileStates.set(path, {
    path, root: 'cloud-drives', origin: 'matt',
    size: Buffer.byteLength(body, 'utf8'), mtime: new Date(0),
    content_hash: sha256(body), status: 'indexed',
    last_seen: oldSeen,
  });

  await scanRoot({
    root: { name: 'cloud-drives', path: corpusRoot, origin: 'path-segment', exclude: [] },
    db, budget: createBudget(60), runId: 'run-touch', corpusRoot,
    fsImpl: buildMockFsImpl(tree, corpusRoot),
  });

  const state = db.fileStates.get(path);
  assert.equal(state.status, 'indexed');
  assert.ok(state.last_seen.getTime() > oldSeen.getTime());
});

test('scan does not bump last_seen on an unchanged indexing claim', async () => {
  const corpusRoot = '/corpus/cloud-drives';
  const body = 'vendor agreement';
  const tree = { matt: { 'msa.md': body } };
  const db = createFakeDb();
  const path = '/corpus/cloud-drives/matt/msa.md';
  const claimTime = new Date('2026-01-01T00:00:00.000Z');
  db.fileStates.set(path, {
    path, root: 'cloud-drives', origin: 'matt',
    size: Buffer.byteLength(body, 'utf8'), mtime: new Date(0),
    content_hash: sha256(body), status: 'indexing',
    last_seen: claimTime,
  });

  await scanRoot({
    root: { name: 'cloud-drives', path: corpusRoot, origin: 'path-segment', exclude: [] },
    db, budget: createBudget(60), runId: 'run-claim', corpusRoot,
    fsImpl: buildMockFsImpl(tree, corpusRoot),
  });

  const state = db.fileStates.get(path);
  assert.equal(state.status, 'indexing', 'scan must not steal a live/crashed claim');
  assert.equal(state.last_seen.toISOString(), claimTime.toISOString(),
    'last_seen must stay at claim time so requeueStaleClaims can fire');
});

test('a completed scan does not false-delete an on-disk indexing claim', async () => {
  const corpusRoot = '/corpus/cloud-drives';
  const body = 'still here';
  const tree = { matt: { 'notes.md': body } };
  const db = createFakeDb();
  const path = '/corpus/cloud-drives/matt/notes.md';
  db.fileStates.set(path, {
    path, root: 'cloud-drives', origin: 'matt',
    size: Buffer.byteLength(body, 'utf8'), mtime: new Date(0),
    content_hash: sha256(body), status: 'indexing',
    last_seen: new Date(Date.now() - 60_000),
  });

  const counters = await scanRoot({
    root: { name: 'cloud-drives', path: corpusRoot, origin: 'path-segment', exclude: [] },
    db, budget: createBudget(60), runId: 'run-keep', corpusRoot,
    fsImpl: buildMockFsImpl(tree, corpusRoot),
  });

  assert.equal(db.fileStates.get(path).status, 'indexing');
  assert.equal(counters.deleted, 0);
});

test('budget expiry releases claimed-but-never-started files back to pending', async () => {
  const files = [
    { path: '/a.md', root: 'cloud-drives', origin: 'matt', size: 1, mtime: new Date(), content_hash: 'aa' },
    { path: '/b.md', root: 'cloud-drives', origin: 'matt', size: 1, mtime: new Date(), content_hash: 'bb' },
    { path: '/c.md', root: 'cloud-drives', origin: 'matt', size: 1, mtime: new Date(), content_hash: 'cc' },
  ];

  let claimed = false;
  let finishedOne = false;
  const db = {
    async getPendingQueue(limit) {
      if (claimed) return [];
      claimed = true;
      return files.slice(0, limit);
    },
    released: [],
    async releaseClaims(paths) {
      this.released.push(...paths);
    },
    async markIndexed() {},
    async markError() {},
    async insertIngestLog() {
      // indexFile logs once per started file (success, skip, or extract error).
      finishedOne = true;
    },
    async upsertSkipped() {},
  };

  const budget = {
    exhausted() { return finishedOne; },
    remainingSeconds() { return finishedOne ? 0 : 10; },
  };

  await indexPendingQueue({
    db,
    budget,
    runId: 'run-budget',
    meili: { async upsertDoc() {} },
    qdrant: { async deleteByPath() {}, async upsertPoints() {} },
    embedClient: { model: 'test', modelRevision: 'test', async embedTexts() { return []; } },
    concurrency: 1,
    policyForRoot: () => 'none',
  });

  // First path is started (extract fails on the fake path; still "started").
  // The rest of the claim batch must return to pending.
  assert.ok(db.released.includes('/b.md'));
  assert.ok(db.released.includes('/c.md'));
  assert.ok(!db.released.includes('/a.md'), 'started file must not be released');
});
