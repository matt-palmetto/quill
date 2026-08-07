import { createHash } from 'node:crypto';

/** Thin fetch wrapper for Meilisearch (CONTRACT.md "Meilisearch"). */

export const MEILI_INDEX = 'quill_files';
export const MEILI_TEXT_CAP_BYTES = 100 * 1024;

export function meiliDocId(path) {
  return createHash('sha256').update(path, 'utf8').digest('hex');
}

function capText(text) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= MEILI_TEXT_CAP_BYTES) return text;
  // Slice on the byte cap then trim any partial trailing UTF-8 sequence.
  return buf.subarray(0, MEILI_TEXT_CAP_BYTES).toString('utf8').replace(/�+$/u, '');
}

export function createMeiliClient({
  baseUrl = process.env.QUILL_MEILI_URL,
  apiKey = process.env.QUILL_MEILI_KEY,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    throw new TypeError('QUILL_MEILI_URL is required');
  }
  const normalizedBaseUrl = baseUrl.replace(/\/$/u, '');

  async function request(path, options = {}) {
    const response = await fetchImpl(`${normalizedBaseUrl}${path}`, {
      ...options,
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...(options.headers ?? {}),
      },
    });
    if (!response.ok && response.status !== 404) {
      const body = await response.text().catch(() => '');
      throw new Error(`meili ${options.method ?? 'GET'} ${path} -> HTTP ${response.status}: ${body.slice(0, 500)}`);
    }
    return response;
  }

  /** Idempotent: create the index if missing, then (re)apply filterable/sortable settings. */
  async function ensureIndex() {
    const existing = await request(`/indexes/${MEILI_INDEX}`);
    if (existing.status === 404) {
      await request('/indexes', {
        method: 'POST',
        body: JSON.stringify({ uid: MEILI_INDEX, primaryKey: 'id' }),
      });
    }
    await request(`/indexes/${MEILI_INDEX}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({
        filterableAttributes: ['origin', 'root', 'ext', 'source'],
        sortableAttributes: ['mtime_unix'],
      }),
    });
  }

  async function upsertDoc({ path, root, origin, title, ext, mtimeUnix, size, text }) {
    const doc = {
      id: meiliDocId(path),
      path,
      root,
      origin,
      source: 'files',
      title,
      ext,
      mtime_unix: mtimeUnix,
      size,
      text: capText(text ?? ''),
    };
    await request(`/indexes/${MEILI_INDEX}/documents`, {
      method: 'POST',
      body: JSON.stringify([doc]),
    });
    return doc.id;
  }

  async function deleteDoc(path) {
    await request(`/indexes/${MEILI_INDEX}/documents/${meiliDocId(path)}`, { method: 'DELETE' });
  }

  return Object.freeze({ ensureIndex, upsertDoc, deleteDoc });
}
