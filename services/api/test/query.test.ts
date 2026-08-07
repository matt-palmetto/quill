import { describe, expect, it } from 'vitest';
import { buildMeiliFilter, buildMeiliSearchBody } from '../src/lib/meili.js';
import { buildQdrantFilter, buildQdrantSearchBody } from '../src/lib/qdrant.js';
import { clampLimit } from '../src/routes/search.js';

describe('buildMeiliFilter', () => {
  it('returns undefined when no filters given', () => {
    expect(buildMeiliFilter({})).toBeUndefined();
  });

  it('builds a single equality clause', () => {
    expect(buildMeiliFilter({ origin: 'matt' })).toBe('origin = "matt"');
  });

  it('ORs comma-separated values for one field', () => {
    expect(buildMeiliFilter({ origin: 'matt, example-org' })).toBe(
      '(origin = "matt" OR origin = "example-org")',
    );
  });

  it('ANDs multiple fields', () => {
    expect(buildMeiliFilter({ origin: 'matt', root: 'cloud-drives', ext: 'md' })).toBe(
      'origin = "matt" AND root = "cloud-drives" AND ext = "md"',
    );
  });

  it('escapes embedded quotes', () => {
    expect(buildMeiliFilter({ origin: 'weird"value' })).toBe('origin = "weird\\"value"');
  });
});

describe('buildMeiliSearchBody', () => {
  it('carries q, limit, filter, and scoring/highlight options', () => {
    const body = buildMeiliSearchBody('invoice', { limit: 10, origin: 'matt' });
    expect(body).toMatchObject({
      q: 'invoice',
      limit: 10,
      filter: 'origin = "matt"',
      showRankingScore: true,
      attributesToCrop: ['text'],
      attributesToHighlight: ['title', 'text'],
    });
  });
});

describe('buildQdrantFilter', () => {
  it('returns undefined when no filters given', () => {
    expect(buildQdrantFilter({})).toBeUndefined();
  });

  it('builds a single match clause', () => {
    expect(buildQdrantFilter({ root: 'archives' })).toEqual({
      must: [{ key: 'root', match: { value: 'archives' } }],
    });
  });

  it('builds a match-any clause for comma-separated values', () => {
    expect(buildQdrantFilter({ origin: 'matt,meridian7' })).toEqual({
      must: [{ key: 'origin', match: { any: ['matt', 'meridian7'] } }],
    });
  });
});

describe('buildQdrantSearchBody', () => {
  it('carries the vector, limit, and filter', () => {
    const vector = [0.1, 0.2];
    const body = buildQdrantSearchBody(vector, { limit: 5, root: 'archives' });
    expect(body).toEqual({
      vector,
      limit: 5,
      with_payload: true,
      filter: { must: [{ key: 'root', match: { value: 'archives' } }] },
    });
  });
});

describe('clampLimit', () => {
  it('defaults to 20 when missing or invalid', () => {
    expect(clampLimit(undefined)).toBe(20);
    expect(clampLimit('not-a-number')).toBe(20);
    expect(clampLimit('-5')).toBe(20);
    expect(clampLimit('0')).toBe(20);
  });

  it('floors fractional values', () => {
    expect(clampLimit('7.9')).toBe(7);
  });

  it('caps at 100', () => {
    expect(clampLimit('500')).toBe(100);
  });

  it('passes through valid values', () => {
    expect(clampLimit('35')).toBe(35);
  });
});
