import { uuid5 } from './uuid5.mjs';

/** Thin fetch wrapper for Qdrant (CONTRACT.md "Qdrant"). */

export const QDRANT_COLLECTION = 'quill_chunks';
export const QDRANT_VECTOR_SIZE = Number(process.env.QUILL_EMBED_DIM ?? 1024);

/** Point id = uuid5(path + chunk_index + content_hash), per CONTRACT.md. */
export function qdrantPointId({ path, chunkIndex, contentHash }) {
  return uuid5([path, chunkIndex, contentHash].join('\0'));
}

export function createQdrantClient({
  baseUrl = process.env.QUILL_QDRANT_URL,
  apiKey = process.env.QUILL_QDRANT_API_KEY,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    throw new TypeError('QUILL_QDRANT_URL is required');
  }
  const normalizedBaseUrl = baseUrl.replace(/\/$/u, '');

  async function request(path, options = {}, { allow404 = false } = {}) {
    const response = await fetchImpl(`${normalizedBaseUrl}${path}`, {
      ...options,
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { 'api-key': apiKey } : {}),
        ...(options.headers ?? {}),
      },
    });
    // 404 is success only for existence checks and idempotent deletes.
    // A missing collection on upsert used to look like success, and
    // indexFile then marked the file indexed with no vectors stored.
    if (response.status === 404 && allow404) return response;
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`qdrant ${options.method ?? 'GET'} ${path} -> HTTP ${response.status}: ${body.slice(0, 500)}`);
    }
    return response;
  }

  /** Idempotent: create the collection only if it does not already exist. */
  async function ensureCollection() {
    const existing = await request(`/collections/${QDRANT_COLLECTION}`, {}, { allow404: true });
    if (existing.status !== 404) return;
    await request(`/collections/${QDRANT_COLLECTION}`, {
      method: 'PUT',
      body: JSON.stringify({
        vectors: { size: QDRANT_VECTOR_SIZE, distance: 'Cosine' },
        on_disk_payload: true,
      }),
    });
  }

  async function upsertPoints(points) {
    if (points.length === 0) return;
    await request(`/collections/${QDRANT_COLLECTION}/points?wait=true`, {
      method: 'PUT',
      body: JSON.stringify({ points }),
    });
  }

  /** Delete every point for a path -- used before re-indexing changed/removed content. */
  async function deleteByPath(path) {
    await request(`/collections/${QDRANT_COLLECTION}/points/delete?wait=true`, {
      method: 'POST',
      body: JSON.stringify({
        filter: { must: [{ key: 'path', match: { value: path } }] },
      }),
    }, { allow404: true });
  }

  return Object.freeze({ ensureCollection, upsertPoints, deleteByPath });
}
