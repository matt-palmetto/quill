import { basename } from 'node:path';
import { extractText, extname } from './extract.mjs';
import { chunkDocument } from './chunk.mjs';
import { qdrantPointId } from './qdrant.mjs';
import { logError } from './log.mjs';
import { shouldEmbed } from './embed-policy.mjs';

/** Extract + chunk + embed + index one pending file (CONTRACT.md Meili + Qdrant). */
export async function indexFile(file, { db, runId, meili, qdrant, embedClient, embedPolicy = 'documents', extractOpts = {} }) {
  try {
    const extracted = await extractText(file.path, extractOpts);

    if (extracted.unsupported) {
      await db.upsertSkipped({
        path: file.path, root: file.root, origin: file.origin,
        size: Number(file.size), mtime: file.mtime, reason: 'unrecognized extension, no extractor',
      });
      await db.insertIngestLog({
        runId, stage: 'index', path: file.path, detail: { status: 'skipped', reason: 'unrecognized extension' },
      });
      return { status: 'skipped' };
    }

    const title = basename(file.path);
    const ext = extname(file.path);
    const mtimeUnix = Math.floor(new Date(file.mtime).getTime() / 1000);

    await meili.upsertDoc({
      path: file.path, root: file.root, origin: file.origin,
      title, ext, mtimeUnix, size: Number(file.size), text: extracted.text,
    });

    const embedThisFile = shouldEmbed(file.path, embedPolicy);
    let points = [];
    if (embedThisFile && extracted.text && extracted.text.trim().length > 0) {
      const chunks = chunkDocument({ rawText: extracted.text, sourcePath: file.path })
        // Minified/single-line blobs can put >64KiB in one "500-token" chunk
        // (whitespace-run tokens); truncate rather than fail the file — a
        // 64KiB unbroken line carries no retrievable semantics past its head.
        .map((chunk) => (Buffer.byteLength(chunk.text, 'utf8') > 60000
          ? { ...chunk, text: Buffer.from(chunk.text, 'utf8').subarray(0, 60000).toString('utf8').replace(/�+$/, '') }
          : chunk));
      if (chunks.length > 0) {
        const vectors = await embedClient.embedTexts(
          chunks.map((chunk) => ({ text: chunk.text, chunk_text_hash: chunk.chunk_text_hash })),
        );
        points = chunks.map((chunk, i) => ({
          id: qdrantPointId({ path: file.path, chunkIndex: chunk.chunk_index, contentHash: file.content_hash }),
          vector: vectors[i],
          payload: {
            path: file.path,
            root: file.root,
            origin: file.origin,
            source: 'files',
            chunk_index: chunk.chunk_index,
            text: chunk.text,
            content_hash: file.content_hash,
            model: embedClient.model,
            model_revision: embedClient.modelRevision,
            mtime_unix: mtimeUnix,
          },
        }));
      }
    }

    // Drop stale points only after embeddings succeed. Deleting first meant a
    // failed embed left the path with no vectors and status=error, which scan
    // previously treated as unchanged and never retried.
    await qdrant.deleteByPath(file.path);
    if (points.length > 0) {
      await qdrant.upsertPoints(points);
    }

    await db.markIndexed(file.path, embedThisFile);
    await db.insertIngestLog({ runId, stage: 'index', path: file.path, detail: { status: 'indexed', embedded: embedThisFile } });
    return { status: 'indexed' };
  } catch (err) {
    const message = String(err?.message ?? err);
    logError('index: failed', { path: file.path, error: message });
    await db.markError(file.path, message).catch(() => {});
    await db.insertIngestLog({ runId, stage: 'index', path: file.path, detail: { status: 'error', error: message } });
    return { status: 'error' };
  }
}

/**
 * Drain file_state's pending queue (newest mtime first) until the run budget
 * is spent. Files are processed by a worker pool (QUILL_INDEX_CONCURRENCY,
 * default 16) — the per-file work is dominated by extract/Meili/embed/Qdrant
 * round-trips, so sequential draining left the node idle (839 files in the
 * first ~45 min of a 372k backlog, 2026-08-06).
 */
export async function indexPendingQueue({ db, budget, runId, meili, qdrant, embedClient, concurrency, policyForRoot = () => 'documents', queuePriority = {} }) {
  const poolSize = Math.max(1, Number(concurrency ?? process.env.QUILL_INDEX_CONCURRENCY ?? 16));
  const counters = { indexed: 0, skipped: 0, errors: 0 };
  let sinceLog = 0;
  while (!budget.exhausted()) {
    const queue = await db.getPendingQueue(poolSize * 3, queuePriority);
    if (queue.length === 0) break;
    let next = 0;
    const worker = async () => {
      while (next < queue.length && !budget.exhausted()) {
        const file = queue[next++];
        const result = await indexFile(file, { db, runId, meili, qdrant, embedClient, embedPolicy: policyForRoot(file.root) });
        if (result.status === 'indexed') counters.indexed += 1;
        else if (result.status === 'error') counters.errors += 1;
        else counters.skipped += 1;
      }
    };
    await Promise.all(Array.from({ length: Math.min(poolSize, queue.length) }, worker));
    sinceLog += queue.length;
    if (sinceLog >= 500) {
      logProgress(counters, budget);
      sinceLog = 0;
    }
  }
  return counters;
}

function logProgress(counters, budget) {
  process.stderr.write(`${JSON.stringify({
    ts: new Date().toISOString(), level: 'info', msg: 'index: progress',
    ...counters, remaining_budget_s: Math.round(budget.remainingSeconds()),
  })}\n`);
}
