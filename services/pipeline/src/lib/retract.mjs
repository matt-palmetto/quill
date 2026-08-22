import { logError } from './log.mjs';

/**
 * Drop search-index documents for files scan has already marked deleted.
 *
 * markDeletedNotSeenSince only updates file_state. Leaving Meili/Qdrant
 * untouched means a removed (or excluded) corpus file stays fully searchable
 * — including snippet text — after /ops reports it gone. Deletes are
 * idempotent (both clients treat HTTP 404 as success) so this is safe to
 * run every ingest, including retries after a previous retract failure.
 */
export async function retractDeletedFromIndexes({ db, meili, qdrant }) {
  const paths = await db.listDeletedPaths();
  const counters = { retracted: 0, errors: 0, candidates: paths.length };
  for (const path of paths) {
    try {
      await meili.deleteDoc(path);
      await qdrant.deleteByPath(path);
      counters.retracted += 1;
    } catch (err) {
      logError('retract: failed', { path, error: String(err?.message ?? err) });
      counters.errors += 1;
    }
  }
  return counters;
}
