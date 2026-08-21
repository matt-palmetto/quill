import pg from 'pg';

const { Pool } = pg;

/**
 * Postgres access for the ingest pipeline (CONTRACT.md "Postgres schema").
 *
 * Contract addition: `file_state.deleted_at timestamptz` is not in CONTRACT.md's schema
 * table. Scan needs a way to mark rows whose paths vanished from the corpus without
 * losing history (last_seen/indexed_at), so a soft-delete column was added rather than
 * hard-deleting rows. Flagged in the pipeline report as a contract deviation to fold back
 * into CONTRACT.md.
 */

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS file_state (
     path text PRIMARY KEY,
     root text NOT NULL,
     origin text NOT NULL,
     size bigint NOT NULL,
     mtime timestamptz NOT NULL,
     content_hash text,
     status text NOT NULL,
     error text,
     first_seen timestamptz NOT NULL DEFAULT now(),
     last_seen timestamptz NOT NULL DEFAULT now(),
     indexed_at timestamptz,
     deleted_at timestamptz
   )`,
  `CREATE INDEX IF NOT EXISTS file_state_status_idx ON file_state (status)`,
  `CREATE INDEX IF NOT EXISTS file_state_root_idx ON file_state (root)`,
  `CREATE TABLE IF NOT EXISTS sync_state (
     key text PRIMARY KEY,
     value jsonb NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS ingest_log (
     id bigserial PRIMARY KEY,
     run_id text NOT NULL,
     stage text NOT NULL,
     path text,
     detail jsonb,
     at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS ingest_log_run_id_idx ON ingest_log (run_id)`,
  // Additive: records whether a file's chunks were embedded (embed policy,
  // embed-policy.mjs) so a future policy change can re-embed just the
  // affected subset instead of the whole corpus.
  `ALTER TABLE file_state ADD COLUMN IF NOT EXISTS embedded boolean NOT NULL DEFAULT false`,
];

export function createDb(connectionString = process.env.QUILL_PG_URL) {
  if (typeof connectionString !== 'string' || connectionString.length === 0) {
    throw new TypeError('QUILL_PG_URL is required');
  }
  const pool = new Pool({ connectionString });

  async function migrate() {
    const client = await pool.connect();
    try {
      for (const statement of MIGRATIONS) {
        await client.query(statement);
      }
    } finally {
      client.release();
    }
  }

  /** Existing (mtime,size,content_hash,status) for cheap unchanged-file comparison. */
  async function getFileState(path) {
    const { rows } = await pool.query(
      `SELECT path, root, origin, size, mtime, content_hash, status, error,
              first_seen, last_seen, indexed_at, deleted_at
       FROM file_state WHERE path = $1`,
      [path],
    );
    return rows[0] ?? null;
  }

  /** File observed with unchanged (mtime,size): just bump last_seen, clear any deleted_at. */
  async function touchFileSeen(path, mtime) {
    await pool.query(
      `UPDATE file_state SET
         last_seen = now(),
         mtime = $2,
         deleted_at = NULL,
         status = CASE
           WHEN status = 'deleted' AND indexed_at IS NOT NULL THEN 'indexed'
           WHEN status = 'deleted' THEN 'pending'
           ELSE status
         END
       WHERE path = $1`,
      [path, mtime],
    );
  }

  /** New or content-changed file: upsert as pending for the extract+index phase. */
  async function upsertPending({ path, root, origin, size, mtime, contentHash }) {
    await pool.query(
      `INSERT INTO file_state (path, root, origin, size, mtime, content_hash, status,
                                error, first_seen, last_seen, indexed_at, deleted_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', NULL, now(), now(), NULL, NULL)
       ON CONFLICT (path) DO UPDATE SET
         root = EXCLUDED.root,
         origin = EXCLUDED.origin,
         size = EXCLUDED.size,
         mtime = EXCLUDED.mtime,
         content_hash = EXCLUDED.content_hash,
         status = 'pending',
         error = NULL,
         last_seen = now(),
         deleted_at = NULL`,
      [path, root, origin, size, mtime, contentHash],
    );
  }

  /** Skip-list / oversize file: recorded once, not re-logged every run by the caller. */
  async function upsertSkipped({ path, root, origin, size, mtime, reason }) {
    await pool.query(
      `INSERT INTO file_state (path, root, origin, size, mtime, content_hash, status,
                                error, first_seen, last_seen, indexed_at, deleted_at)
       VALUES ($1, $2, $3, $4, $5, NULL, 'skipped', $6, now(), now(), NULL, NULL)
       ON CONFLICT (path) DO UPDATE SET
         root = EXCLUDED.root,
         origin = EXCLUDED.origin,
         size = EXCLUDED.size,
         mtime = EXCLUDED.mtime,
         status = 'skipped',
         error = EXCLUDED.error,
         last_seen = now(),
         deleted_at = NULL`,
      [path, root, origin, size, mtime, reason],
    );
  }

  async function markIndexed(path, embedded = false) {
    await pool.query(
      `UPDATE file_state SET status = 'indexed', error = NULL, indexed_at = now(), last_seen = now(),
              embedded = $2
       WHERE path = $1`,
      [path, embedded],
    );
  }

  async function markError(path, errorText) {
    await pool.query(
      `UPDATE file_state SET status = 'error', error = $2, last_seen = now() WHERE path = $1`,
      [path, String(errorText).slice(0, 4000)],
    );
  }

  /** Paths under a root that were not seen this walk pass are soft-deleted. */
  async function markDeletedNotSeenSince(root, since) {
    const { rows } = await pool.query(
      `UPDATE file_state SET status = 'deleted', deleted_at = now()
       WHERE root = $1 AND last_seen < $2 AND status != 'deleted'
       RETURNING path`,
      [root, since],
    );
    return rows.map((row) => row.path);
  }

  /**
   * Atomically claim a batch of pending files (status -> 'indexing') so a
   * long-running backfill Job and the 30-min cron can drain the same queue
   * without double-processing. SKIP LOCKED keeps concurrent claimers from
   * blocking each other.
   */
  async function getPendingQueue(limit, { priorityRoots = [], priorityExts = [] } = {}) {
    // Documents come first. In pure mtime order the corpus's ~5.5k documents
    // sat at average position 125k of 150k — behind every source file — so
    // the content that actually needs embedding (and that a human searches)
    // would have been indexed last (2026-08-07).
    const { rows } = await pool.query(
      `UPDATE file_state SET status = 'indexing', last_seen = now()
       WHERE path IN (
         SELECT path FROM file_state WHERE status = 'pending'
         ORDER BY (
           root = ANY($2)
           AND lower(substring(path from '\.([A-Za-z0-9]{1,8})$')) = ANY($3)
         ) DESC, mtime DESC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING path, root, origin, size, mtime, content_hash`,
      [limit, priorityRoots, priorityExts],
    );
    return rows;
  }

  /** Crash recovery: rows claimed >30 min ago whose worker never finished. */
  async function requeueStaleClaims() {
    const { rowCount } = await pool.query(
      `UPDATE file_state SET status = 'pending'
       WHERE status = 'indexing' AND last_seen < now() - interval '30 minutes'`,
    );
    return rowCount;
  }

  async function getSyncState(key) {
    const { rows } = await pool.query(`SELECT value FROM sync_state WHERE key = $1`, [key]);
    return rows[0]?.value ?? null;
  }

  async function setSyncState(key, value) {
    await pool.query(
      `INSERT INTO sync_state (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
  }

  async function insertIngestLog({ runId, stage, path = null, detail = null }) {
    await pool.query(
      `INSERT INTO ingest_log (run_id, stage, path, detail, at) VALUES ($1, $2, $3, $4, now())`,
      [runId, stage, path, detail ? JSON.stringify(detail) : null],
    );
  }

  async function close() {
    await pool.end();
  }

  return Object.freeze({
    pool,
    migrate,
    getFileState,
    touchFileSeen,
    upsertPending,
    upsertSkipped,
    markIndexed,
    markError,
    markDeletedNotSeenSince,
    getPendingQueue,
    requeueStaleClaims,
    getSyncState,
    setSyncState,
    insertIngestLog,
    close,
  });
}
