import assert from 'node:assert/strict';
import test from 'node:test';

import { retractDeletedFromIndexes } from '../src/lib/retract.mjs';

test('retracts every soft-deleted path from Meili and Qdrant', async () => {
  const deleted = ['/corpus/a.md', '/corpus/b.pdf'];
  const meiliDeleted = [];
  const qdrantDeleted = [];
  const result = await retractDeletedFromIndexes({
    db: { async listDeletedPaths() { return deleted; } },
    meili: { async deleteDoc(path) { meiliDeleted.push(path); } },
    qdrant: { async deleteByPath(path) { qdrantDeleted.push(path); } },
  });

  assert.deepEqual(meiliDeleted, deleted);
  assert.deepEqual(qdrantDeleted, deleted);
  assert.deepEqual(result, { retracted: 2, errors: 0, candidates: 2 });
});

test('a vanished file that scan marked deleted is dropped from both indexes', async () => {
  // Concrete trigger: contract.pdf is removed from the NAS, a complete scan
  // pass sets file_state.status='deleted', and without this retract the next
  // /search?q=contract still returns the full document plus snippet.
  const path = '/corpus/cloud-drives/matt/contracts/msa.pdf';
  const meiliDeleted = [];
  const qdrantDeleted = [];
  await retractDeletedFromIndexes({
    db: { async listDeletedPaths() { return [path]; } },
    meili: { async deleteDoc(p) { meiliDeleted.push(p); } },
    qdrant: { async deleteByPath(p) { qdrantDeleted.push(p); } },
  });
  assert.deepEqual(meiliDeleted, [path]);
  assert.deepEqual(qdrantDeleted, [path]);
});

test('continues retracting after one path fails so a single 5xx cannot leave the rest searchable', async () => {
  const deleted = ['/corpus/ok.md', '/corpus/fail.md', '/corpus/also.md'];
  const meiliDeleted = [];
  const qdrantDeleted = [];
  const result = await retractDeletedFromIndexes({
    db: { async listDeletedPaths() { return deleted; } },
    meili: {
      async deleteDoc(path) {
        if (path.endsWith('fail.md')) throw new Error('meili HTTP 503');
        meiliDeleted.push(path);
      },
    },
    qdrant: { async deleteByPath(path) { qdrantDeleted.push(path); } },
  });

  assert.deepEqual(meiliDeleted, ['/corpus/ok.md', '/corpus/also.md']);
  assert.deepEqual(qdrantDeleted, ['/corpus/ok.md', '/corpus/also.md']);
  assert.deepEqual(result, { retracted: 2, errors: 1, candidates: 3 });
});

test('is a no-op when nothing is deleted', async () => {
  let meiliCalls = 0;
  const result = await retractDeletedFromIndexes({
    db: { async listDeletedPaths() { return []; } },
    meili: { async deleteDoc() { meiliCalls += 1; } },
    qdrant: { async deleteByPath() { meiliCalls += 1; } },
  });
  assert.equal(meiliCalls, 0);
  assert.deepEqual(result, { retracted: 0, errors: 0, candidates: 0 });
});
