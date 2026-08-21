import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';

import { createBudget } from '../src/lib/budget.mjs';
import { readdirFailureCompletesWalk, scanRoot } from '../src/lib/scan.mjs';

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function buildMockFsImpl(tree, corpusRoot, { failReaddir = {} } = {}) {
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
      if (failReaddir[dirPath]) {
        const code = failReaddir[dirPath];
        throw Object.assign(new Error(`${code}: ${dirPath}`), { code });
      }
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
        if (state.status === 'deleted') {
          state.status = state.indexed_at ? 'indexed' : 'pending';
        }
      }
    },
    async upsertPending({ path, root, origin, size, mtime, contentHash }) {
      const prev = fileStates.get(path);
      fileStates.set(path, {
        path, root, origin, size, mtime, content_hash: contentHash,
        status: 'pending', error: null,
        last_seen: new Date(),
        deleted_at: null,
        indexed_at: prev?.indexed_at ?? null,
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
      const sinceMs = new Date(since).getTime();
      const deleted = [];
      for (const [path, state] of fileStates) {
        if (state.root !== root || state.status === 'deleted') continue;
        if (new Date(state.last_seen).getTime() < sinceMs) {
          state.status = 'deleted';
          state.deleted_at = new Date();
          deleted.push(path);
        }
      }
      return deleted;
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

test('readdirFailureCompletesWalk: only a missing directory is a completed walk', () => {
  assert.equal(readdirFailureCompletesWalk({ code: 'ENOENT' }), true);
  assert.equal(readdirFailureCompletesWalk({ code: 'ENOTDIR' }), true);
  assert.equal(readdirFailureCompletesWalk({ code: 'ESTALE' }), false);
  assert.equal(readdirFailureCompletesWalk({ code: 'EIO' }), false);
  assert.equal(readdirFailureCompletesWalk({ code: 'ETIMEDOUT' }), false);
  assert.equal(readdirFailureCompletesWalk({ code: 'EACCES' }), false);
  assert.equal(readdirFailureCompletesWalk({}), false);
});

test('ESTALE mid-walk does not complete the pass or mark live files deleted', async () => {
  const corpusRoot = '/corpus/cloud-drives';
  const tree = {
    matt: { contracts: { 'msa.md': 'vendor agreement' }, 'notes.md': 'hello' },
    'example-org': { 'plan.txt': 'the plan' },
  };
  const db = createFakeDb();
  const root = { name: 'cloud-drives', path: corpusRoot, origin: 'path-segment', exclude: [] };

  // First pass indexes everything.
  await scanRoot({
    root, db, budget: createBudget(60), runId: 'run-1', corpusRoot,
    fsImpl: buildMockFsImpl(tree, corpusRoot),
  });
  const livePath = '/corpus/cloud-drives/matt/contracts/msa.md';
  assert.equal(db.fileStates.get(livePath)?.status, 'pending');
  db.fileStates.get(livePath).status = 'indexed';
  db.fileStates.get(livePath).indexed_at = new Date();
  // Age last_seen so a completed pass would delete anything not re-touched.
  db.fileStates.get(livePath).last_seen = new Date(Date.now() - 60_000);

  const counters = await scanRoot({
    root, db, budget: createBudget(60), runId: 'run-2', corpusRoot,
    fsImpl: buildMockFsImpl(tree, corpusRoot, {
      failReaddir: { '/corpus/cloud-drives/matt/contracts': 'ESTALE' },
    }),
  });

  assert.equal(counters.deleted, 0, 'NFS blip must not fire deletion detection');
  assert.notEqual(db.fileStates.get(livePath).status, 'deleted');
  assert.ok(
    await db.getSyncState('scan_cursor:cloud-drives'),
    'incomplete walk must leave a cursor so the next run retries the same top-level dir',
  );
});

test('ENOENT mid-walk is a real missing directory and allows deletion of unseen files', async () => {
  const corpusRoot = '/corpus/cloud-drives';
  const tree = {
    matt: { 'notes.md': 'hello' },
  };
  const db = createFakeDb();
  const root = { name: 'cloud-drives', path: corpusRoot, origin: 'path-segment', exclude: [] };

  const gone = '/corpus/cloud-drives/matt/old/gone.md';
  db.fileStates.set(gone, {
    path: gone, root: 'cloud-drives', origin: 'matt', size: 4, mtime: new Date(0),
    content_hash: sha256('gone'), status: 'indexed', last_seen: new Date(Date.now() - 60_000),
  });

  const counters = await scanRoot({
    root, db, budget: createBudget(60), runId: 'run-1', corpusRoot,
    fsImpl: buildMockFsImpl(tree, corpusRoot),
  });

  assert.equal(db.fileStates.get(gone).status, 'deleted');
  assert.equal(counters.deleted, 1);
});

test('a deleted file that reappears with the same content is re-queued, not left deleted', async () => {
  const corpusRoot = '/corpus/cloud-drives';
  const body = 'vendor agreement';
  const tree = { matt: { 'msa.md': body } };
  const db = createFakeDb();
  const path = '/corpus/cloud-drives/matt/msa.md';
  db.fileStates.set(path, {
    path, root: 'cloud-drives', origin: 'matt',
    size: Buffer.byteLength(body, 'utf8'), mtime: new Date(0),
    content_hash: sha256(body), status: 'deleted', deleted_at: new Date(),
    last_seen: new Date(Date.now() - 60_000), indexed_at: new Date(),
  });

  await scanRoot({
    root: { name: 'cloud-drives', path: corpusRoot, origin: 'path-segment', exclude: [] },
    db, budget: createBudget(60), runId: 'run-restore', corpusRoot,
    fsImpl: buildMockFsImpl(tree, corpusRoot),
  });

  assert.equal(db.fileStates.get(path).status, 'pending');
  assert.equal(db.fileStates.get(path).deleted_at, null);
  assert.ok(db.logs.some((entry) => entry.detail?.restored === 'deleted'));
});

test('an error file with unchanged size/mtime is re-queued so transient index failures retry', async () => {
  const corpusRoot = '/corpus/cloud-drives';
  const body = 'notes for later';
  const tree = { matt: { 'notes.md': body } };
  const db = createFakeDb();
  const path = '/corpus/cloud-drives/matt/notes.md';
  db.fileStates.set(path, {
    path, root: 'cloud-drives', origin: 'matt',
    size: Buffer.byteLength(body, 'utf8'), mtime: new Date(0),
    content_hash: sha256(body), status: 'error', error: 'embedding service request failed',
    last_seen: new Date(),
  });

  const counters = await scanRoot({
    root: { name: 'cloud-drives', path: corpusRoot, origin: 'path-segment', exclude: [] },
    db, budget: createBudget(60), runId: 'run-retry', corpusRoot,
    fsImpl: buildMockFsImpl(tree, corpusRoot),
  });

  assert.equal(db.fileStates.get(path).status, 'pending');
  assert.equal(counters.changed, 1);
  assert.ok(db.logs.some((entry) => entry.detail?.retried_error === true));
});
