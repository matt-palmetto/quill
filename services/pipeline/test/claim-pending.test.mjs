import assert from 'node:assert/strict';
import test from 'node:test';

import { CLAIM_PENDING_BATCH_SQL } from '../src/lib/db.mjs';

test('claim SQL materializes the LIMIT/SKIP LOCKED select once (not an IN-subquery)', () => {
  const sql = CLAIM_PENDING_BATCH_SQL;

  assert.match(sql, /WITH claimed AS MATERIALIZED/u,
    'Postgres must materialize the candidate set once; an inlined IN-subquery can ignore LIMIT');
  assert.match(sql, /FOR UPDATE SKIP LOCKED/u,
    'concurrent cron + backfill rely on SKIP LOCKED to pick disjoint batches');
  assert.match(sql, /FROM claimed/u);
  assert.match(sql, /WHERE file_state\.path = claimed\.path/u);

  // The broken form `UPDATE ... WHERE path IN (SELECT ... LIMIT n FOR UPDATE)`
  // is what let the planner re-run the subquery after each status flip.
  assert.equal(/\bpath IN\s*\(/iu.test(sql), false,
    'must not use UPDATE ... WHERE path IN (SELECT ...); that pattern drops LIMIT under nested-loop plans');

  assert.match(sql, /status = 'pending'/u);
  assert.match(sql, /SET status = 'indexing'/u);
  assert.match(sql, /LIMIT \$1/u);
});
