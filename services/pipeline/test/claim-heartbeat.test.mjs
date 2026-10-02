import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { indexFile, startIndexingHeartbeat } from '../src/lib/index-files.mjs';

function waitUntil(predicate, { timeoutMs = 1000, intervalMs = 15 } = {}) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error('timed out waiting for heartbeat'));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

test('heartbeat refreshes the claim on an interval and stops when asked', async () => {
  const touches = [];
  const db = {
    async touchIndexingClaim(path) {
      touches.push(path);
    },
  };

  const hb = startIndexingHeartbeat(db, '/corpus/inbox/scan.pdf', { intervalMs: 30 });
  await waitUntil(() => touches.length >= 2);
  const countAtStop = touches.length;
  hb.stop();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(touches.length, countAtStop, 'must not tick after stop()');
  assert.ok(touches.every((path) => path === '/corpus/inbox/scan.pdf'));
});

test('heartbeat is a no-op when the db has no touchIndexingClaim', () => {
  const hb = startIndexingHeartbeat({}, '/x', { intervalMs: 10 });
  hb.stop();
});

test('indexFile heartbeats last_seen while a slow index step is in flight', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quill-hb-'));
  const path = join(dir, 'note.md');
  await writeFile(path, 'hello heartbeat world\n');

  const touches = [];
  let releaseUpsert;
  const upsertGate = new Promise((resolve) => {
    releaseUpsert = resolve;
  });

  const db = {
    async touchIndexingClaim(claimedPath) {
      touches.push(claimedPath);
    },
    async markIndexed() {},
    async markError() {},
    async insertIngestLog() {},
    async upsertSkipped() {},
  };

  try {
    const indexing = indexFile({
      path,
      root: 'inbox',
      origin: 'inbox',
      size: 22,
      mtime: new Date(),
      content_hash: 'abc',
    }, {
      db,
      runId: 'hb-run',
      meili: {
        async upsertDoc() {
          await upsertGate;
        },
      },
      qdrant: { async deleteByPath() {}, async upsertPoints() {} },
      embedClient: { model: 'test', modelRevision: 'test', async embedTexts() { return []; } },
      embedPolicy: 'none',
      heartbeatMs: 40,
    });

    await waitUntil(() => touches.length >= 2);
    releaseUpsert();
    const result = await indexing;
    assert.equal(result.status, 'indexed');
    assert.ok(touches.length >= 2, `expected heartbeats during upsert, got ${touches.length}`);
    assert.ok(touches.every((claimed) => claimed === path));

    const countAfter = touches.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(touches.length, countAfter, 'heartbeat must stop after indexFile returns');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
