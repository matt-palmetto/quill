import type { FastifyInstance } from 'fastify';
import { getPool } from '../lib/pg.js';

// GET /ops — per-root aggregates over file_state plus recent ingest_log
// summary rows (CONTRACT.md: file_state/ingest_log schema).

interface RootErrorRow {
  path: string;
  error: string;
  last_seen: string;
}

interface RootSummary {
  root: string;
  origin: string;
  last_run: string | null;
  files_seen: number;
  files_indexed: number;
  pending: number;
  errors: RootErrorRow[];
}

interface IngestLogRow {
  id: string;
  run_id: string;
  stage: string;
  path: string | null;
  detail: unknown;
  at: string;
}

const MAX_ERRORS_PER_ROOT = 10;
const MAX_LOG_ROWS = 20;

export function registerOpsRoute(app: FastifyInstance): void {
  app.get('/ops', async () => {
    const pool = getPool();

    const aggRes = await pool.query<{
      root: string;
      origin: string;
      files_seen: string;
      files_indexed: string;
      pending: string;
      last_indexed_at: string | null;
    }>(`
      select root, origin,
        count(*) as files_seen,
        count(*) filter (where status = 'indexed') as files_indexed,
        count(*) filter (where status = 'pending') as pending,
        max(indexed_at) as last_indexed_at
      from file_state
      group by root, origin
      order by root, origin
    `);

    const errRes = await pool.query<{
      root: string;
      origin: string;
      path: string;
      error: string | null;
      last_seen: string;
    }>(`
      select root, origin, path, error, last_seen
      from file_state
      where status = 'error'
      order by last_seen desc
    `);

    const errorsByRoot = new Map<string, RootErrorRow[]>();
    for (const row of errRes.rows) {
      const key = `${row.root}::${row.origin}`;
      const list = errorsByRoot.get(key) ?? [];
      if (list.length < MAX_ERRORS_PER_ROOT) {
        list.push({ path: row.path, error: row.error ?? '', last_seen: row.last_seen });
        errorsByRoot.set(key, list);
      }
    }

    const sources: RootSummary[] = aggRes.rows.map((row) => ({
      root: row.root,
      origin: row.origin,
      last_run: row.last_indexed_at,
      files_seen: Number(row.files_seen),
      files_indexed: Number(row.files_indexed),
      pending: Number(row.pending),
      errors: errorsByRoot.get(`${row.root}::${row.origin}`) ?? [],
    }));

    const logRes = await pool.query<IngestLogRow>(`
      select id, run_id, stage, path, detail, at
      from ingest_log
      order by at desc
      limit ${MAX_LOG_ROWS}
    `);

    return { sources, ingest_log: logRes.rows };
  });
}
