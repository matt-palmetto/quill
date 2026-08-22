import { randomBytes } from 'node:crypto';
import { createDb } from './lib/db.mjs';
import { loadSources, enabledRoots } from './lib/sources.mjs';
import { EMBEDDABLE_EXTENSIONS } from './lib/embed-policy.mjs';
import { scanRoot } from './lib/scan.mjs';
import { indexPendingQueue } from './lib/index-files.mjs';
import { retractDeletedFromIndexes } from './lib/retract.mjs';
import { createMeiliClient } from './lib/meili.mjs';
import { createQdrantClient } from './lib/qdrant.mjs';
import { createEmbeddingClient } from './lib/embeddings.mjs';
import { createBudget } from './lib/budget.mjs';
import { logInfo, logError } from './lib/log.mjs';

function makeRunId() {
  return `run_${Date.now()}_${randomBytes(4).toString('hex')}`;
}

async function runIngest() {
  const budgetSeconds = Number(process.env.QUILL_INGEST_BUDGET_SECONDS ?? 1500);
  const budget = createBudget(budgetSeconds);
  const sourcesPath = process.env.QUILL_SOURCES_PATH ?? '/app/sources.json';
  const runId = makeRunId();

  const db = createDb();
  await db.migrate();
  const requeued = await db.requeueStaleClaims();
  logInfo('migrate: complete', { run_id: runId, stale_claims_requeued: requeued });

  const sourcesConfig = await loadSources(sourcesPath);
  const roots = enabledRoots(sourcesConfig);
  logInfo('scan: starting', { run_id: runId, roots: roots.map((r) => r.name) });

  const scanTotals = { scanned: 0, changed: 0, skipped: 0, errors: 0, deleted: 0 };
  // Backfill jobs set QUILL_SKIP_SCAN=1: the 30-min cron owns discovery of
  // new/changed files; the backfill spends its entire budget draining the
  // already-scanned queue.
  if (process.env.QUILL_SKIP_SCAN !== '1') {
    for (const root of roots) {
      if (budget.exhausted()) break;
      const counters = await scanRoot({ root, db, budget, runId });
      for (const key of Object.keys(scanTotals)) scanTotals[key] += counters[key] ?? 0;
      logInfo('scan: root done', { run_id: runId, root: root.name, ...counters });
    }
  } else {
    logInfo('scan: skipped (QUILL_SKIP_SCAN=1)', { run_id: runId });
  }

  const meili = createMeiliClient();
  const qdrant = createQdrantClient();
  const embedClient = createEmbeddingClient();
  await meili.ensureIndex();
  await qdrant.ensureCollection();

  // Scan only flips file_state to deleted. Retract search docs here so a
  // removed file cannot keep serving keyword/semantic hits (and so a failed
  // retract is retried on the next run).
  const retractTotals = await retractDeletedFromIndexes({ db, meili, qdrant });
  if (retractTotals.candidates > 0) {
    logInfo('retract: deleted files removed from search indexes', { run_id: runId, ...retractTotals });
  }

  logInfo('index: starting', { run_id: runId, remaining_budget_s: Math.round(budget.remainingSeconds()) });
  const policyByRoot = new Map(sourcesConfig.roots.map((root) => [root.name, root.embed]));
  const indexTotals = await indexPendingQueue({
    db, budget, runId, meili, qdrant, embedClient,
    policyForRoot: (name) => policyByRoot.get(name) ?? 'documents',
    queuePriority: {
      priorityRoots: sourcesConfig.roots.filter((r) => r.embed !== 'none').map((r) => r.name),
      priorityExts: [...EMBEDDABLE_EXTENSIONS],
    },
  });

  // Embedding tokens are a real budget (Voyage's free pool is shared and
  // finite) — carry a running total so /ops can show spend without asking
  // the provider.
  const priorTokens = (await db.getSyncState('embed_tokens_total'))?.tokens ?? 0;
  const totalTokens = priorTokens + embedClient.tokensUsed;
  await db.setSyncState('embed_tokens_total', { tokens: totalTokens });

  const summary = {
    run_id: runId,
    scanned: scanTotals.scanned,
    changed: scanTotals.changed,
    indexed: indexTotals.indexed,
    skipped: scanTotals.skipped + indexTotals.skipped,
    errors: scanTotals.errors + indexTotals.errors,
    deleted: scanTotals.deleted,
    retracted: retractTotals.retracted,
    retract_errors: retractTotals.errors,
    budget_used_s: Math.round(budget.elapsedSeconds()),
    embed_tokens_run: embedClient.tokensUsed,
    embed_tokens_total: totalTokens,
  };

  await db.insertIngestLog({ runId, stage: 'report', detail: summary });
  await db.close();

  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

async function main() {
  const command = process.argv[2];
  if (command !== 'ingest') {
    process.stderr.write('usage: node src/run.mjs ingest\n');
    process.exit(1);
    return;
  }
  await runIngest();
}

main().catch((err) => {
  logError('run: fatal', { error: String(err?.stack ?? err) });
  process.exitCode = 1;
});
