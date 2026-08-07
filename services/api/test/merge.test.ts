import { describe, expect, it } from 'vitest';
import { mergeResults } from '../src/lib/merge.js';
import type { MeiliHit } from '../src/lib/meili.js';
import type { QdrantPoint } from '../src/lib/qdrant.js';

function meiliHit(overrides: Partial<MeiliHit> = {}): MeiliHit {
  return {
    id: 'kw-1',
    path: '/corpus/a.md',
    root: 'cloud-drives',
    origin: 'matt',
    title: 'Alpha Report',
    ext: 'md',
    mtime_unix: 1000,
    _rankingScore: 0.8,
    ...overrides,
  };
}

function qdrantPoint(overrides: Partial<QdrantPoint> = {}): QdrantPoint {
  const { payload, ...rest } = overrides;
  return {
    id: 'sem-1',
    score: 0.7,
    ...rest,
    payload: {
      path: '/corpus/a.md',
      root: 'cloud-drives',
      origin: 'matt',
      source: 'files',
      chunk_index: 0,
      text: 'chunk text about alpha',
      content_hash: 'hash',
      model: 'bge-m3',
      mtime_unix: 1000,
      ...payload,
    },
  } as QdrantPoint;
}

describe('mergeResults', () => {
  it('marks a keyword-only hit as match=keyword', () => {
    const [hit] = mergeResults('alpha', [meiliHit()], [], 20);
    expect(hit.match).toBe('keyword');
    expect(hit.path).toBe('/corpus/a.md');
    expect(hit.score).toBeGreaterThan(0);
  });

  it('marks a semantic-only hit as match=semantic and derives title from basename', () => {
    const [hit] = mergeResults('alpha', [], [qdrantPoint({ payload: { path: '/corpus/b.md' } as never })], 20);
    expect(hit.match).toBe('semantic');
    expect(hit.title).toBe('b.md');
  });

  it('merges a hit present in both legs into match=both with combined score', () => {
    const [hit] = mergeResults('alpha', [meiliHit()], [qdrantPoint()], 20);
    expect(hit.match).toBe('both');
    // 0.8 * 0.6 (keyword weight) + 0.7 * 0.4 (semantic weight) = 0.76
    expect(hit.score).toBeCloseTo(0.76, 4);
  });

  it('keyword-only score uses just the keyword weight', () => {
    const [hit] = mergeResults('zzz-no-match', [meiliHit({ _rankingScore: 0.5 })], [], 20);
    expect(hit.score).toBeCloseTo(0.3, 4);
  });

  it('boosts an exact title match over a higher-ranked partial match, when it flips the order', () => {
    const exact = meiliHit({ id: 'exact', path: '/corpus/exact.md', title: 'invoice', _rankingScore: 0.7 });
    const higher = meiliHit({ id: 'higher', path: '/corpus/higher.md', title: 'invoice summary q3', _rankingScore: 0.8 });
    const results = mergeResults('invoice', [exact, higher], [], 20);
    // exact: 0.7*0.6 + 0.15 boost = 0.57; higher: 0.8*0.6 = 0.48 -> exact wins
    expect(results[0].id).toBe('exact');
    expect(results[1].id).toBe('higher');
  });

  it('never lets the exact-match boost push score above 1', () => {
    const [hit] = mergeResults('report', [meiliHit({ title: 'report', _rankingScore: 1 })], [qdrantPoint()], 20);
    expect(hit.score).toBeLessThanOrEqual(1);
  });

  it('sorts merged results by score descending', () => {
    const low = meiliHit({ id: 'low', path: '/corpus/low.md', _rankingScore: 0.1 });
    const high = meiliHit({ id: 'high', path: '/corpus/high.md', _rankingScore: 0.9 });
    const results = mergeResults('q', [low, high], [], 20);
    expect(results.map((r) => r.id)).toEqual(['high', 'low']);
  });

  it('respects the limit after merging', () => {
    const hits = Array.from({ length: 5 }, (_, i) =>
      meiliHit({ id: `h${i}`, path: `/corpus/${i}.md`, _rankingScore: i / 10 }),
    );
    const results = mergeResults('q', hits, [], 2);
    expect(results).toHaveLength(2);
  });

  it('falls back to the semantic chunk text as snippet when keyword has none', () => {
    const kw = meiliHit({ id: 'kw', path: '/corpus/a.md' });
    delete kw._formatted;
    const sem = qdrantPoint({ payload: { path: '/corpus/a.md', text: 'chunk snippet body' } as never });
    const [hit] = mergeResults('alpha', [kw], [sem], 20);
    expect(hit.snippet).toBe('chunk snippet body');
  });

  it('takes the max semantic score when multiple chunks match the same path', () => {
    const sem1 = qdrantPoint({ id: 's1', score: 0.3, payload: { path: '/corpus/a.md' } as never });
    const sem2 = qdrantPoint({ id: 's2', score: 0.9, payload: { path: '/corpus/a.md' } as never });
    const [hit] = mergeResults('q', [], [sem1, sem2], 20);
    expect(hit.score).toBeCloseTo(0.9 * 0.4, 4);
  });
});
