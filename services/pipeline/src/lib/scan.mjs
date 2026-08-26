import { readdir as readdirReal, lstat as lstatReal } from 'node:fs/promises';
import { createReadStream as createReadStreamReal } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { isExcluded, deriveOrigin } from './sources.mjs';
import { shouldSkipExtension } from './skip-extensions.mjs';
import { extname } from './extract.mjs';
import { logWarn, logError } from './log.mjs';

/**
 * Time-budgeted corpus walk (CONTRACT.md "Sources config" + pipeline report's
 * per-root, last-completed-top-level-subdir cursor).
 *
 * Exclusions are checked against each entry BEFORE it is opened -- an excluded
 * directory is never readdir'd, an excluded file is never lstat'd (the parent's
 * `readdir` result already gave us the entry name, so no further syscall is needed
 * to decide to skip it).
 */

export const MAX_FILE_BYTES = 50 * 1024 * 1024;

const TRANSIENT_FS_CODES = new Set(['ESTALE', 'EIO', 'ETIMEDOUT', 'ENOTCONN', 'ECONNRESET']);

export function defaultFsImpl() {
  return { readdir: readdirReal, lstat: lstatReal, createReadStream: createReadStreamReal };
}

function sha256File(absPath, fsImpl) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    let stream;
    try {
      stream = fsImpl.createReadStream(absPath);
    } catch (err) {
      reject(err);
      return;
    }
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function sortByName(entries) {
  return [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function fsErrorMessage(err) {
  return TRANSIENT_FS_CODES.has(err?.code) ? `NFS error: ${err.code}` : String(err?.message ?? err);
}

async function processFile({ root, absPath, relSegments, db, fsImpl, runId, counters }) {
  const origin = deriveOrigin(root, relSegments);
  const ext = extname(absPath);

  let existing;
  try {
    existing = await db.getFileState(absPath);
  } catch (err) {
    logError('scan: file_state lookup failed', { path: absPath, error: String(err) });
    counters.errors += 1;
    return;
  }

  let stats;
  try {
    stats = await fsImpl.lstat(absPath);
  } catch (err) {
    logWarn('scan: lstat failed', { path: absPath, code: err?.code, error: fsErrorMessage(err) });
    counters.errors += 1;
    return;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) return;

  if (shouldSkipExtension(ext) || stats.size > MAX_FILE_BYTES) {
    const reason = stats.size > MAX_FILE_BYTES ? 'file exceeds 50MB cap' : `skip-list extension .${ext || '(none)'}`;
    const alreadyLogged = existing && existing.status === 'skipped' && existing.error === reason;
    await db.upsertSkipped({
      path: absPath, root: root.name, origin, size: Number(stats.size), mtime: stats.mtime, reason,
    });
    if (!alreadyLogged) {
      await db.insertIngestLog({ runId, stage: 'scan', path: absPath, detail: { status: 'skipped', reason } });
    }
    counters.skipped += 1;
    return;
  }

  const unchanged = existing
    && existing.status !== 'deleted'
    && Number(existing.size) === Number(stats.size)
    && new Date(existing.mtime).getTime() === stats.mtime.getTime();
  if (unchanged) {
    await db.touchFileSeen(absPath, stats.mtime);
    return;
  }

  let contentHash;
  try {
    contentHash = await sha256File(absPath, fsImpl);
  } catch (err) {
    const message = fsErrorMessage(err);
    logWarn('scan: hash failed', { path: absPath, code: err?.code, error: message });
    await db.markError(absPath, message).catch(() => {});
    await db.insertIngestLog({ runId, stage: 'scan', path: absPath, detail: { status: 'error', error: message } });
    counters.errors += 1;
    return;
  }

  if (existing && existing.content_hash === contentHash) {
    await db.touchFileSeen(absPath, stats.mtime);
    return;
  }

  // Backfill + the 30-min cron are designed to share the queue (SKIP LOCKED).
  // Re-queuing a live claim as pending lets a second worker run indexFile on
  // the same path: both call qdrant.deleteByPath then upsertPoints, so the
  // earlier worker can wipe the later one's vectors (or restore stale ones)
  // after Meili already has the new text.
  if (existing?.status === 'indexing') {
    return;
  }

  await db.upsertPending({
    path: absPath, root: root.name, origin, size: Number(stats.size), mtime: stats.mtime, contentHash,
  });
  await db.insertIngestLog({
    runId, stage: 'scan', path: absPath, detail: { status: 'pending', changed: Boolean(existing) },
  });
  counters.changed += 1;
}

async function walkDir({ root, absDirPath, relSegments, db, fsImpl, budget, runId, counters }) {
  let entries;
  try {
    entries = await fsImpl.readdir(absDirPath, { withFileTypes: true });
  } catch (err) {
    logWarn('scan: readdir failed', { path: absDirPath, code: err?.code, error: fsErrorMessage(err) });
    return { completed: true };
  }

  for (const entry of sortByName(entries)) {
    if (budget.exhausted()) return { completed: false };
    const entryRelSegments = [...relSegments, entry.name];
    if (isExcluded(entryRelSegments, root.exclude)) continue;
    const absPath = join(absDirPath, entry.name);
    if (entry.isDirectory()) {
      const result = await walkDir({ root, absDirPath: absPath, relSegments: entryRelSegments, db, fsImpl, budget, runId, counters });
      if (!result.completed) return { completed: false };
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      counters.scanned += 1;
      await processFile({ root, absPath, relSegments: entryRelSegments, db, fsImpl, runId, counters });
    }
  }
  return { completed: true };
}

/**
 * Walk one enabled source root, resuming from its persisted top-level cursor and
 * detecting deletions once a full pass completes.
 */
export async function scanRoot({ root, db, budget, runId, corpusRoot = root.path, fsImpl = defaultFsImpl() }) {
  const cursorKey = `scan_cursor:${root.name}`;
  const passKey = `scan_pass:${root.name}`;
  const counters = { scanned: 0, changed: 0, skipped: 0, errors: 0, deleted: 0 };

  let cursor = await db.getSyncState(cursorKey);
  let pass = await db.getSyncState(passKey);
  if (!cursor) {
    pass = { startedAt: new Date().toISOString() };
    await db.setSyncState(passKey, pass);
  } else if (!pass) {
    logWarn('scan: resuming with no recorded pass start; deletion detection skipped this pass', { root: root.name });
    pass = { startedAt: null };
  }

  let entries;
  try {
    entries = await fsImpl.readdir(corpusRoot, { withFileTypes: true });
  } catch (err) {
    logError('scan: root readdir failed', { root: root.name, path: corpusRoot, error: String(err) });
    return counters;
  }
  const sorted = sortByName(entries);
  const startIndex = cursor?.lastCompleted
    ? sorted.findIndex((entry) => entry.name > cursor.lastCompleted)
    : 0;
  const pending = startIndex === -1 ? [] : sorted.slice(startIndex);

  for (const entry of pending) {
    if (budget.exhausted()) return counters;
    const relSegments = [entry.name];
    if (!isExcluded(relSegments, root.exclude)) {
      const absPath = join(corpusRoot, entry.name);
      if (entry.isDirectory()) {
        const result = await walkDir({ root, absDirPath: absPath, relSegments, db, fsImpl, budget, runId, counters });
        if (!result.completed) return counters;
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        counters.scanned += 1;
        await processFile({ root, absPath, relSegments, db, fsImpl, runId, counters });
      }
    }
    cursor = { lastCompleted: entry.name };
    await db.setSyncState(cursorKey, cursor);
  }

  if (pass.startedAt) {
    const deletedPaths = await db.markDeletedNotSeenSince(root.name, pass.startedAt);
    for (const path of deletedPaths) {
      await db.insertIngestLog({ runId, stage: 'scan', path, detail: { status: 'deleted' } });
    }
    counters.deleted = deletedPaths.length;
  }
  await db.setSyncState(cursorKey, null);
  await db.setSyncState(passKey, null);
  return counters;
}
