import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { createBudget } from '../src/lib/budget.mjs';
import { classifyDirent, scanRoot } from '../src/lib/scan.mjs';

function unknownDirent(name) {
  return {
    name,
    isDirectory: () => false,
    isFile: () => false,
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

function typedDirent(name, kind) {
  return {
    name,
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file',
    isSymbolicLink: () => kind === 'symlink',
  };
}

function buildMockFsImpl(tree, corpusRoot, { unknownTypes = false } = {}) {
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
        if (unknownTypes) return unknownDirent(name);
        return typedDirent(name, isDir ? 'directory' : 'file');
      });
    },
    async lstat(filePath) {
      const node = resolveNode(filePath);
      const isDir = node !== null && typeof node === 'object';
      return {
        size: isDir ? 0 : Buffer.byteLength(node, 'utf8'),
        mtime: new Date(0),
        isFile: () => !isDir,
        isDirectory: () => isDir,
        isSymbolicLink: () => false,
      };
    },
    createReadStream(filePath) {
      const node = resolveNode(filePath);
      return Readable.from([Buffer.from(node, 'utf8')]);
    },
  };
}

function createFakeDb(initialFiles = []) {
  const fileStates = new Map();
  const syncState = new Map();
  for (const row of initialFiles) {
    fileStates.set(row.path, { ...row });
  }
  return {
    fileStates,
    syncState,
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
    async insertIngestLog() {},
  };
}

test('classifyDirent falls back to lstat when every is*() is false (DT_UNKNOWN)', async () => {
  const lstatCalls = [];
  const fsImpl = {
    async lstat(path) {
      lstatCalls.push(path);
      return {
        isDirectory: () => path.endsWith('/dir'),
        isFile: () => path.endsWith('.md'),
        isSymbolicLink: () => false,
      };
    },
  };
  const unknown = unknownDirent('notes.md');
  assert.equal(await classifyDirent(unknown, '/corpus/notes.md', fsImpl), 'file');
  assert.equal(await classifyDirent(unknownDirent('dir'), '/corpus/dir', fsImpl), 'directory');
  assert.deepEqual(lstatCalls, ['/corpus/notes.md', '/corpus/dir']);
});

test('classifyDirent trusts dirent when d_type is present', async () => {
  const fsImpl = {
    async lstat() { throw new Error('lstat should not run when dirent type is known'); },
  };
  assert.equal(await classifyDirent(typedDirent('a', 'directory'), '/a', fsImpl), 'directory');
  assert.equal(await classifyDirent(typedDirent('b', 'file'), '/b', fsImpl), 'file');
  assert.equal(await classifyDirent(typedDirent('c', 'symlink'), '/c', fsImpl), 'symlink');
});

test('empty root listing does not mass-delete previously indexed files', async () => {
  const corpusRoot = '/corpus/cloud-drives';
  const existingPath = `${corpusRoot}/matt/contracts/msa.pdf`;
  const db = createFakeDb([{
    path: existingPath,
    root: 'cloud-drives',
    origin: 'matt',
    status: 'indexed',
    last_seen: new Date('2026-01-01T00:00:00Z'),
    indexed_at: new Date('2026-01-01T00:00:00Z'),
  }]);
  const fsImpl = buildMockFsImpl({}, corpusRoot);
  const root = { name: 'cloud-drives', path: corpusRoot, origin: 'path-segment', exclude: [] };
  const counters = await scanRoot({ root, db, budget: createBudget(60), runId: 'empty-root', corpusRoot, fsImpl });

  assert.equal(db.fileStates.get(existingPath).status, 'indexed', 'empty listing must not fire deletion detection');
  assert.equal(counters.deleted, 0);
  assert.equal(db.syncState.get('scan_cursor:cloud-drives'), undefined, 'pass must not be marked complete');
});

test('NFS DT_UNKNOWN dirents are still walked via lstat; files are not false-deleted', async () => {
  const corpusRoot = '/corpus/cloud-drives';
  const notesPath = `${corpusRoot}/matt/notes.md`;
  const db = createFakeDb([{
    path: notesPath,
    root: 'cloud-drives',
    origin: 'matt',
    status: 'indexed',
    size: 5,
    mtime: new Date(0),
    content_hash: 'old',
    last_seen: new Date('2026-01-01T00:00:00Z'),
    indexed_at: new Date('2026-01-01T00:00:00Z'),
  }]);
  const tree = { matt: { 'notes.md': 'hello' } };
  const fsImpl = buildMockFsImpl(tree, corpusRoot, { unknownTypes: true });
  const root = { name: 'cloud-drives', path: corpusRoot, origin: 'path-segment', exclude: [] };
  const counters = await scanRoot({ root, db, budget: createBudget(60), runId: 'dt-unknown', corpusRoot, fsImpl });

  const state = db.fileStates.get(notesPath);
  assert.notEqual(state.status, 'deleted', 'unread DT_UNKNOWN files must not be marked deleted');
  assert.ok(state.status === 'pending' || state.status === 'indexed');
  assert.equal(counters.deleted, 0);
  assert.ok(counters.scanned >= 1, 'DT_UNKNOWN file must be scanned');
});
