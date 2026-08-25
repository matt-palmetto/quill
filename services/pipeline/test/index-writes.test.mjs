import assert from 'node:assert/strict';
import test from 'node:test';

import { createMeiliClient, MEILI_INDEX, meiliDocId } from '../src/lib/meili.mjs';
import { createQdrantClient, QDRANT_COLLECTION } from '../src/lib/qdrant.mjs';

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function textResponse(status, text) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => {
      throw new Error('not json');
    },
    text: async () => text,
  };
}

test('meili upsertDoc throws on 404 so indexFile cannot mark the file indexed', async () => {
  const calls = [];
  const meili = createMeiliClient({
    baseUrl: 'http://meili.test',
    apiKey: 'key',
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, method: options.method ?? 'GET' });
      return textResponse(404, '{"message":"Index `quill_files` not found.","code":"index_not_found"}');
    },
  });

  await assert.rejects(
    () => meili.upsertDoc({
      path: '/corpus/cloud-drives/matt/contracts/msa.pdf',
      root: 'cloud-drives',
      origin: 'matt',
      title: 'msa.pdf',
      ext: 'pdf',
      mtimeUnix: 1,
      size: 100,
      text: 'parties agree',
    }),
    /HTTP 404/,
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/indexes\/quill_files\/documents$/);
  assert.equal(calls[0].method, 'POST');
});

test('meili ensureIndex waits for the create task before PATCHing settings', async () => {
  const calls = [];
  const meili = createMeiliClient({
    baseUrl: 'http://meili.test',
    fetchImpl: async (url, options = {}) => {
      const method = options.method ?? 'GET';
      calls.push({ url, method });
      if (url.endsWith(`/indexes/${MEILI_INDEX}`) && method === 'GET') {
        return textResponse(404, 'missing');
      }
      if (url.endsWith('/indexes') && method === 'POST') {
        return jsonResponse(202, { taskUid: 7, status: 'enqueued' });
      }
      if (url.endsWith('/tasks/7')) {
        return jsonResponse(200, { uid: 7, status: 'succeeded' });
      }
      if (url.endsWith(`/indexes/${MEILI_INDEX}/settings`) && method === 'PATCH') {
        return jsonResponse(202, { taskUid: 8, status: 'enqueued' });
      }
      if (url.endsWith('/tasks/8')) {
        return jsonResponse(200, { uid: 8, status: 'succeeded' });
      }
      return textResponse(500, 'unexpected');
    },
  });

  await meili.ensureIndex();

  const methods = calls.map((call) => `${call.method} ${call.url.replace('http://meili.test', '')}`);
  assert.deepEqual(methods, [
    `GET /indexes/${MEILI_INDEX}`,
    'POST /indexes',
    'GET /tasks/7',
    `PATCH /indexes/${MEILI_INDEX}/settings`,
    'GET /tasks/8',
  ]);
});

test('meili upsertDoc waits for the document task and fails if Meili reports failed', async () => {
  const meili = createMeiliClient({
    baseUrl: 'http://meili.test',
    fetchImpl: async (url, options = {}) => {
      const method = options.method ?? 'GET';
      if (url.endsWith(`/indexes/${MEILI_INDEX}/documents`) && method === 'POST') {
        return jsonResponse(202, { taskUid: 11, status: 'enqueued' });
      }
      if (url.endsWith('/tasks/11')) {
        return jsonResponse(200, {
          uid: 11,
          status: 'failed',
          error: { message: 'index_not_found', code: 'index_not_found' },
        });
      }
      return textResponse(500, 'unexpected');
    },
  });

  await assert.rejects(
    () => meili.upsertDoc({
      path: '/corpus/a.md',
      root: 'archives',
      origin: 'archives',
      title: 'a.md',
      ext: 'md',
      mtimeUnix: 1,
      size: 10,
      text: 'hello',
    }),
    /task 11 failed/,
  );
});

test('meili deleteDoc still treats 404 as success (idempotent retract)', async () => {
  const meili = createMeiliClient({
    baseUrl: 'http://meili.test',
    fetchImpl: async () => textResponse(404, 'not found'),
  });
  await meili.deleteDoc('/corpus/gone.md');
  assert.equal(meiliDocId('/corpus/gone.md').length, 64);
});

test('qdrant upsertPoints throws on 404 (missing collection)', async () => {
  const qdrant = createQdrantClient({
    baseUrl: 'http://qdrant.test',
    fetchImpl: async () => textResponse(404, '{"status":{"error":"Not found"}}'),
  });

  await assert.rejects(
    () => qdrant.upsertPoints([{ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', vector: [0], payload: {} }]),
    /HTTP 404/,
  );
});

test('qdrant deleteByPath still treats 404 as success', async () => {
  const qdrant = createQdrantClient({
    baseUrl: 'http://qdrant.test',
    fetchImpl: async () => textResponse(404, 'not found'),
  });
  await qdrant.deleteByPath('/corpus/gone.md');
});

test('qdrant ensureCollection creates only after a 404 GET', async () => {
  const calls = [];
  const qdrant = createQdrantClient({
    baseUrl: 'http://qdrant.test',
    fetchImpl: async (url, options = {}) => {
      const method = options.method ?? 'GET';
      calls.push({ url, method });
      if (method === 'GET') return textResponse(404, 'missing');
      return jsonResponse(200, { result: true });
    },
  });

  await qdrant.ensureCollection();
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[1].method, 'PUT');
  assert.match(calls[1].url, new RegExp(`/collections/${QDRANT_COLLECTION}$`));
});
