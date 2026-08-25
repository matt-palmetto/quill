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

  async function request(path, options = {}, { allow404 = false } = {}) {
    const response = await fetchImpl(`${normalizedBaseUrl}${path}`, {
      ...options,
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...(options.headers ?? {}),
      },
    });
    // 404 is success only for existence checks and idempotent deletes.
    // Write 404s (missing index during async create, wiped volume) used to
    // return here as if the document landed — indexFile then marked the
    // file indexed and scan never retried it.
    if (response.status === 404 && allow404) return response;
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`meili ${options.method ?? 'GET'} ${path} -> HTTP ${response.status}: ${body.slice(0, 500)}`);
    }
    return response;
  }

  /**
   * Meilisearch writes are tasks (202 + taskUid). Returning before the task
   * succeeds is how a fresh index's first document POSTs 404'd: create was
   * still enqueued. Poll until succeeded/failed.
   */
  async function waitForTask(response, { timeoutMs = 60_000 } = {}) {
    let payload = {};
    try {
      payload = await response.json();
    } catch {
      return;
    }
    const taskUid = payload?.taskUid;
    if (taskUid == null) return;

    const started = Date.now();
    let delayMs = 50;
    while (Date.now() - started < timeoutMs) {
      const taskRes = await request(`/tasks/${taskUid}`);
      const task = await taskRes.json();
      if (task.status === 'succeeded') return;
      if (task.status === 'failed' || task.status === 'canceled') {
        const detail = task.error ? `${task.error.message ?? ''} ${JSON.stringify(task.error)}`.trim() : task.status;
        throw new Error(`meili task ${taskUid} ${task.status}: ${detail}`.slice(0, 500));
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, 1000);
    }
    throw new Error(`meili task ${taskUid} did not finish within ${timeoutMs}ms`);
  }

  /** Idempotent: create the index if missing, then (re)apply filterable/sortable settings. */
  async function ensureIndex() {
    const existing = await request(`/indexes/${MEILI_INDEX}`, {}, { allow404: true });
    if (existing.status === 404) {
      const created = await request('/indexes', {
        method: 'POST',
        body: JSON.stringify({ uid: MEILI_INDEX, primaryKey: 'id' }),
      });
      await waitForTask(created);
    }
    const settings = await request(`/indexes/${MEILI_INDEX}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({
        filterableAttributes: ['origin', 'root', 'ext', 'source'],
        sortableAttributes: ['mtime_unix'],
      }),
    });
    await waitForTask(settings);
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
    const response = await request(`/indexes/${MEILI_INDEX}/documents`, {
      method: 'POST',
      body: JSON.stringify([doc]),
    });
    await waitForTask(response);
    return doc.id;
  }

  async function deleteDoc(path) {
    await request(`/indexes/${MEILI_INDEX}/documents/${meiliDocId(path)}`, { method: 'DELETE' }, { allow404: true });
  }

  return Object.freeze({ ensureIndex, upsertDoc, deleteDoc });
}
