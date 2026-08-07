import { describe, expect, it } from 'vitest';
import { KNOWN_ORIGINS, originRank } from '../lib/origins';

describe('originRank', () => {
  it('ranks known origins by their declared order', () => {
    const ranks = KNOWN_ORIGINS.map(originRank);
    expect(ranks).toEqual([0, 1, 2, 3, 4]);
  });

  it('ranks an unknown origin after every known one', () => {
    expect(originRank('some-new-origin')).toBe(KNOWN_ORIGINS.length);
  });
});
