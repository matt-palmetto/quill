import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// config.ts reads these lazily and throws if unset.
beforeAll(() => {
  process.env.QUILL_EMBED_URL ??= 'http://embed.test/v1';
  process.env.QUILL_EMBED_MODEL ??= 'voyage-4-large';
});
import { _resetEmbedCache, embedQuery } from '../src/lib/embed.js';

const vector = () => new Array(1024).fill(0.01);

afterEach(() => {
  _resetEmbedCache();
  vi.unstubAllGlobals();
});

describe('query embedding cache', () => {
  it('calls the provider once for a repeated query', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ embedding: vector() }] }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const a = await embedQuery('mortgage closing costs');
    const b = await embedQuery('mortgage closing costs');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(b).toEqual(a);
  });

  it('does not serve one query’s vector for another', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ embedding: vector() }] }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await embedQuery('alpha');
    await embedQuery('beta');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not cache failures', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ embedding: vector() }] }) });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await expect(embedQuery('flaky')).rejects.toThrow(/embed failed/);
    await expect(embedQuery('flaky')).resolves.toHaveLength(1024);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
