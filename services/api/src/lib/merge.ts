import type { MeiliHit } from './meili.js';
import type { QdrantPoint } from './qdrant.js';
import type { SearchHit } from '../types.js';

// Score-merge: combine the Meili (keyword) and Qdrant (semantic) legs on a
// single normalized score per CONTRACT.md — "merged on normalized score,
// keyword rank boosted for exact matches". Meili's `_rankingScore` and
// Qdrant's cosine `score` are both already ~0-1, so we weight and sum them
// rather than re-ranking each leg independently.

const KEYWORD_WEIGHT = 0.6;
const SEMANTIC_WEIGHT = 0.4;
const EXACT_MATCH_BOOST = 0.15;
const SNIPPET_FALLBACK_LENGTH = 240;

interface MergeEntry extends SearchHit {
  keywordScore: number;
  semanticScore: number;
}

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function mergeResults(
  query: string,
  keywordHits: MeiliHit[],
  semanticHits: QdrantPoint[],
  limit: number,
): SearchHit[] {
  const q = query.trim().toLowerCase();
  const byPath = new Map<string, MergeEntry>();

  for (const hit of keywordHits) {
    byPath.set(hit.path, {
      id: hit.id,
      kind: 'file',
      path: hit.path,
      origin: hit.origin,
      root: hit.root,
      title: hit._formatted?.title || hit.title,
      snippet: hit._formatted?.text ?? '',
      score: 0,
      mtime_unix: hit.mtime_unix,
      match: 'keyword',
      keywordScore: clamp01(hit._rankingScore ?? 0),
      semanticScore: 0,
    });
  }

  for (const point of semanticHits) {
    const semanticScore = clamp01(point.score);
    const existing = byPath.get(point.payload.path);
    if (existing) {
      existing.semanticScore = Math.max(existing.semanticScore, semanticScore);
      existing.match = 'both';
      if (!existing.snippet) {
        existing.snippet = point.payload.text.slice(0, SNIPPET_FALLBACK_LENGTH);
      }
    } else {
      byPath.set(point.payload.path, {
        id: point.id,
        kind: 'file',
        path: point.payload.path,
        origin: point.payload.origin,
        root: point.payload.root,
        title: basename(point.payload.path),
        snippet: point.payload.text.slice(0, SNIPPET_FALLBACK_LENGTH),
        score: 0,
        mtime_unix: point.payload.mtime_unix,
        match: 'semantic',
        keywordScore: 0,
        semanticScore,
      });
    }
  }

  const results: SearchHit[] = [];
  for (const entry of byPath.values()) {
    let score = entry.keywordScore * KEYWORD_WEIGHT + entry.semanticScore * SEMANTIC_WEIGHT;
    if (q && (entry.title.toLowerCase() === q || basename(entry.path).toLowerCase() === q)) {
      score = Math.min(1, score + EXACT_MATCH_BOOST);
    }
    const { keywordScore: _keywordScore, semanticScore: _semanticScore, ...hit } = entry;
    results.push({ ...hit, score: round(score) });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
