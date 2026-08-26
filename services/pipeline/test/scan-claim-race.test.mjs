import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';

import { createBudget } from '../src/lib/budget.mjs';
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
        state.deleted_at = null;
      }
    },
    async upsertPending({ path, root, origin, size, mtime, contentHash }) {
      const prev = fileStates.get(path);
      // Mirror db.mjs: a live claim must not be reset to pending.
      if (prev?.status === 'indexing') return;
      fileStates.set(path, {
        path, root, origin, size, mtime, content_hash: contentHash,
        status: 'pending', error: null,
        last_seen: new Date(), deleted_at: null,
      });
    },
    async upsertSkipped({ path, root, origin, size, mtime, reason }) {
      fileStates.set(path, {
        path, root, origin, size, mtime, content_hash: null, status: 'skipped', error: reason,
      });
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

test('scan does not steal an in-flight indexing claim when the file changed on disk', async () => {
  const corpusRoot = '/corpus/cloud-drives';
  const oldBody = 'version one of the contract';
  const newBody = 'version two — rewritten while backfill is still embedding v1';
  const tree = { matt: { 'msa.md': newBody } };
  const db = createFakeDb();
  const path = '/corpus/cloud-drives/matt/msa.md';
  const claimTime = new Date('2026-01-01T00:00:00.000Z');
  db.fileStates.set(path, {
    path, root: 'cloud-drives', origin: 'matt',
    size: Buffer.byteLength(oldBody, 'utf8'),
    mtime: new Date(0),
    content_hash: sha256(oldBody),
    status: 'indexing',
    last_seen: claimTime,
  });

  const counters = await scanRoot({
    root: { name: 'cloud-drives', path: corpusRoot, origin: 'path-segment', exclude: [] },
    db, budget: createBudget(60), runId: 'run-race', corpusRoot,
    fsImpl: buildMockFsImpl(tree, corpusRoot),
  });

  const state = db.fileStates.get(path);
  assert.equal(state.status, 'indexing', 'scan must not reset a live claim to pending');
  assert.equal(state.content_hash, sha256(oldBody), 'claimed worker still owns the original hash');
  assert.equal(state.last_seen.toISOString(), claimTime.toISOString());
  assert.equal(counters.changed, 0);
  assert.equal(
    db.logs.some((entry) => entry.detail?.status === 'pending'),
    false,
    'must not log a pending re-queue that a second worker could claim',
  );
});

test('scan still re-queues a changed file that is not currently claimed', async () => {
  const corpusRoot = '/corpus/cloud-drives';
  const oldBody = 'old';
  const newBody = 'new contents';
  const tree = { matt: { 'notes.md': newBody } };
  const db = createFakeDb();
  const path = '/corpus/cloud-drives/matt/notes.md';
  db.fileStates.set(path, {
    path, root: 'cloud-drives', origin: 'matt',
    size: Buffer.byteLength(oldBody, 'utf8'),
    mtime: new Date(0),
    content_hash: sha256(oldBody),
    status: 'indexed',
    last_seen: new Date('2026-01-01T00:00:00.000Z'),
  });

  const counters = await scanRoot({
    root: { name: 'cloud-drives', path: corpusRoot, origin: 'path-segment', exclude: [] },
    db, budget: createBudget(60), runId: 'run-requeue', corpusRoot,
    fsImpl: buildMockFsImpl(tree, corpusRoot),
  });

  const state = db.fileStates.get(path);
  assert.equal(state.status, 'pending');
  assert.equal(state.content_hash, sha256(newBody));
  assert.equal(counters.changed, 1);
});
