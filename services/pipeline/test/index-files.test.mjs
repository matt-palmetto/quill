import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { indexFile } from '../src/lib/index-files.mjs';

function createMocks() {
  const events = [];
  const db = {
    async upsertSkipped() { events.push('upsertSkipped'); },
    async markIndexed() { events.push('markIndexed'); },
    async markError() { events.push('markError'); },
    async insertIngestLog() {},
  };
  const meili = {
    async upsertDoc() { events.push('meili.upsert'); },
  };
  const qdrant = {
    async deleteByPath() { events.push('qdrant.delete'); },
    async upsertPoints() { events.push('qdrant.upsert'); },
  };
  return { events, db, meili, qdrant };
}

test('a failed embed does not delete existing Qdrant points', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quill-index-'));
  const path = join(dir, 'notes.md');
  await writeFile(path, 'hello from the archive\n');
  const { events, db, meili, qdrant } = createMocks();
  const embedClient = {
    model: 'bge-m3',
    modelRevision: 'test',
    async embedTexts() {
      events.push('embed');
      throw new Error('embedding service request failed');
    },
  };

  try {
    const result = await indexFile(
      {
        path, root: 'cloud-drives', origin: 'matt',
        size: 22, mtime: new Date(), content_hash: 'abc',
      },
      { db, runId: 'run-1', meili, qdrant, embedClient, embedPolicy: 'all' },
    );
    assert.equal(result.status, 'error');
    assert.deepEqual(events, ['meili.upsert', 'embed', 'markError']);
    assert.ok(!events.includes('qdrant.delete'), 'stale-point delete must wait until embed succeeds');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('successful embed deletes stale points only after vectors are in hand', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quill-index-'));
  const path = join(dir, 'notes.md');
  await writeFile(path, 'hello from the archive\n');
  const { events, db, meili, qdrant } = createMocks();
  const embedClient = {
    model: 'bge-m3',
    modelRevision: 'test',
    async embedTexts(inputs) {
      events.push('embed');
      return inputs.map(() => Array.from({ length: 1024 }, () => 0.1));
    },
  };

  try {
    const result = await indexFile(
      {
        path, root: 'cloud-drives', origin: 'matt',
        size: 22, mtime: new Date(), content_hash: 'abc',
      },
      { db, runId: 'run-1', meili, qdrant, embedClient, embedPolicy: 'all' },
    );
    assert.equal(result.status, 'indexed');
    const embedAt = events.indexOf('embed');
    const deleteAt = events.indexOf('qdrant.delete');
    const upsertAt = events.indexOf('qdrant.upsert');
    assert.ok(embedAt >= 0 && deleteAt >= 0 && upsertAt >= 0);
    assert.ok(embedAt < deleteAt, 'embed must complete before deleteByPath');
    assert.ok(deleteAt < upsertAt);
    assert.ok(events.includes('markIndexed'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
