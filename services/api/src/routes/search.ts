import type { FastifyInstance } from 'fastify';
import { searchMeili, type MeiliHit } from '../lib/meili.js';
import { searchQdrant, type QdrantPoint } from '../lib/qdrant.js';
import { embedQuery } from '../lib/embed.js';
import { mergeResults } from '../lib/merge.js';
import type { SearchResponse } from '../types.js';

interface SearchQuery {
  q?: string;
  limit?: string;
  origin?: string;
  root?: string;
  ext?: string;
  fast?: string;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export function clampLimit(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

export function registerSearchRoute(app: FastifyInstance): void {
  app.get<{ Querystring: SearchQuery }>('/search', async (request, reply) => {
    const started = Date.now();
    const q = (request.query.q ?? '').trim();
    if (!q) {
      reply.code(400);
      return { error: 'missing required query param q' };
    }

    const limit = clampLimit(request.query.limit);
    const fast = request.query.fast === '1';
    const { origin, root, ext } = request.query;

    // Meili + (embed -> Qdrant) run in parallel; the keyword leg is
    // load-bearing (502 on failure), the semantic leg degrades to
    // keyword-only on failure or when fast=1 skips it entirely.
    const [keywordResult, semanticResult] = await Promise.allSettled([
      searchMeili(q, { limit, origin, root, ext }),
      fast ? Promise.resolve<QdrantPoint[]>([]) : embedQuery(q).then((vector) => searchQdrant(vector, { limit, origin, root })),
    ]);

    if (keywordResult.status === 'rejected') {
      request.log.error({ err: keywordResult.reason }, 'meili search failed');
      reply.code(502);
      return { error: 'search backend unavailable' };
    }
    const keywordHits: MeiliHit[] = keywordResult.value;

    let semanticHits: QdrantPoint[] = [];
    if (semanticResult.status === 'fulfilled') {
      semanticHits = semanticResult.value;
    } else if (!fast) {
      request.log.warn({ err: semanticResult.reason }, 'semantic leg failed, falling back to keyword-only');
    }

    const hits = mergeResults(q, keywordHits, semanticHits, limit);
    const response: SearchResponse = { hits, took_ms: Date.now() - started };
    return response;
  });
}
