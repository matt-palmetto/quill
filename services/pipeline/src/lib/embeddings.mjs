import { createHash } from 'node:crypto';

/**
 * Embedding client for quill-embed (Infinity, OpenAI-style /v1/embeddings), fork of
 * m7-sales lib/brain-embeddings.mjs adapted to CONTRACT.md's QUILL_EMBED_URL / bge-m3.
 */

export const BGE_M3_SERVED_MODEL = 'bge-m3';
export const BGE_M3_DIMENSION = 1024;
export const EMBED_DIMENSION = Number(process.env.QUILL_EMBED_DIM ?? BGE_M3_DIMENSION);
// Infinity does not report a model revision at /v1/embeddings; pin the HF revision the
// estate already serves elsewhere (gtm-brain's Infinity bge-m3 deployment) so the Qdrant
// payload's model_revision is a real value, not a placeholder. Override via
// QUILL_EMBED_MODEL_REVISION if the deployed revision ever changes.
export const DEFAULT_MODEL_REVISION = '5617a9f61b028005a4858fdac845db406aefb181';
export const DEFAULT_EMBEDDING_BATCH_SIZE = 16;
export const DEFAULT_EMBEDDING_CONCURRENCY = 2;
export const DEFAULT_EMBEDDING_TIMEOUT_MS = 30_000;
// Voyage rejects any request over 120k tokens; stay under it with margin
// for the conservative 3-chars/token estimate.
export const DEFAULT_EMBEDDING_MAX_BATCH_TOKENS = 60_000;
export const DEFAULT_EMBEDDING_MAX_INPUTS = 100_000;
export const DEFAULT_EMBEDDING_MAX_TEXT_BYTES = 65_536;

const SHA256_RE = /^[0-9a-f]{64}$/u;

function requirePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

function requireText(text) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new TypeError('embedding text must be a non-empty string');
  }
}

function requireChunkTextHash(chunkTextHash) {
  if (typeof chunkTextHash !== 'string' || !SHA256_RE.test(chunkTextHash)) {
    throw new TypeError('chunk_text_hash must be a lowercase SHA-256 hex digest');
  }
}

function normalizeBaseUrl(baseUrl) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new TypeError('embedding baseUrl must be a valid URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new TypeError('embedding baseUrl must use http or https');
  }
  return parsed.toString().replace(/\/$/u, '');
}

function validateVector(vector, field = 'embedding') {
  if (!Array.isArray(vector) || vector.length !== EMBED_DIMENSION) {
    throw new Error(`${field} must contain exactly ${EMBED_DIMENSION} values`);
  }
  if (vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error(`${field} must contain only finite numbers`);
  }
  return Object.freeze([...vector]);
}

/** SHA-256 over the exact UTF-8 text sent to the embedding model — cache key basis. */
export function hashChunkText(text) {
  requireText(text);
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function makeEmbeddingCacheKey({ model = process.env.QUILL_EMBED_MODEL ?? BGE_M3_SERVED_MODEL, revision, chunkTextHash }) {
  if (typeof model !== 'string' || model.length === 0) {
    throw new TypeError('model must be a non-empty string');
  }
  if (typeof revision !== 'string' || revision.length === 0) {
    throw new TypeError('revision must be a non-empty string');
  }
  requireChunkTextHash(chunkTextHash);
  const identity = [model, revision, chunkTextHash].join('\0');
  return `embedding_${createHash('sha256').update(identity, 'utf8').digest('hex')}`;
}

/** Bounded process-local LRU. A run only needs in-process reuse across chunks/files. */
export function createMemoryEmbeddingCache({ maxEntries = 10_000 } = {}) {
  requirePositiveInteger(maxEntries, 'maxEntries');
  const entries = new Map();
  return Object.freeze({
    async get(key) {
      if (!entries.has(key)) return null;
      const vector = entries.get(key);
      entries.delete(key);
      entries.set(key, vector);
      return [...vector];
    },
    async set(key, vector) {
      const validated = validateVector(vector, 'cached embedding');
      entries.delete(key);
      entries.set(key, validated);
      while (entries.size > maxEntries) {
        entries.delete(entries.keys().next().value);
      }
    },
    get size() {
      return entries.size;
    },
  });
}

function normalizeInputs(inputs, { maxInputs, maxTextBytes, revision }) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new TypeError('embedTexts inputs must be a non-empty array');
  }
  if (inputs.length > maxInputs) {
    throw new RangeError(`embedTexts inputs must not contain more than ${maxInputs} entries`);
  }
  return inputs.map((input, index) => {
    if (!input || typeof input !== 'object') {
      throw new TypeError(`embedTexts input ${index} must be an object`);
    }
    requireText(input.text);
    if (Buffer.byteLength(input.text, 'utf8') > maxTextBytes) {
      throw new RangeError(`embedTexts input ${index} exceeds ${maxTextBytes} UTF-8 bytes`);
    }
    const chunkTextHash = input.chunk_text_hash ?? hashChunkText(input.text);
    return Object.freeze({
      text: input.text,
      chunk_text_hash: chunkTextHash,
      cache_key: makeEmbeddingCacheKey({ revision, chunkTextHash }),
    });
  });
}

function normalizeResponseData(payload, expectedCount) {
  if (!payload || !Array.isArray(payload.data) || payload.data.length !== expectedCount) {
    throw new Error(`embedding response must contain exactly ${expectedCount} results`);
  }
  const vectors = new Array(expectedCount);
  for (const [position, item] of payload.data.entries()) {
    const index = item?.index ?? position;
    if (!Number.isInteger(index) || index < 0 || index >= expectedCount || vectors[index]) {
      throw new Error('embedding response contains an invalid or duplicate index');
    }
    vectors[index] = validateVector(item?.embedding, `embedding response data[${index}]`);
  }
  if (vectors.some((vector) => vector === undefined)) {
    throw new Error('embedding response is missing a result index');
  }
  return vectors;
}

/** Client for quill-embed (Infinity, bge-m3), batch 16 / concurrency 2 by default. */
export function createEmbeddingClient({
  baseUrl = process.env.QUILL_EMBED_URL,
  model = process.env.QUILL_EMBED_MODEL ?? BGE_M3_SERVED_MODEL,
  apiKey = process.env.QUILL_EMBED_API_KEY,
  inputType = process.env.QUILL_EMBED_INPUT_TYPE ?? null,
  modelRevision = process.env.QUILL_EMBED_MODEL_REVISION || DEFAULT_MODEL_REVISION,
  fetchImpl = globalThis.fetch,
  cache = createMemoryEmbeddingCache(),
  timeoutMs = Number(process.env.QUILL_EMBED_TIMEOUT_MS ?? DEFAULT_EMBEDDING_TIMEOUT_MS),
  maxBatchSize = Number(process.env.QUILL_EMBED_BATCH ?? DEFAULT_EMBEDDING_BATCH_SIZE),
  maxConcurrency = Number(process.env.QUILL_EMBED_CONCURRENCY ?? DEFAULT_EMBEDDING_CONCURRENCY),
  maxBatchTokens = Number(process.env.QUILL_EMBED_MAX_BATCH_TOKENS ?? DEFAULT_EMBEDDING_MAX_BATCH_TOKENS),
  maxInputs = DEFAULT_EMBEDDING_MAX_INPUTS,
  maxTextBytes = DEFAULT_EMBEDDING_MAX_TEXT_BYTES,
} = {}) {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    throw new TypeError('QUILL_EMBED_URL is required');
  }
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('fetchImpl must be a function');
  }
  requirePositiveInteger(timeoutMs, 'timeoutMs');
  requirePositiveInteger(maxBatchSize, 'maxBatchSize');
  requirePositiveInteger(maxBatchTokens, 'maxBatchTokens');
  requirePositiveInteger(maxConcurrency, 'maxConcurrency');
  requirePositiveInteger(maxInputs, 'maxInputs');
  requirePositiveInteger(maxTextBytes, 'maxTextBytes');
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  let tokensUsed = 0;

  async function requestBatch(entries) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      let response;
      try {
        response = await fetchImpl(`${normalizedBaseUrl}/embeddings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify({
            model,
            ...(inputType ? { input_type: inputType } : {}),
            input: entries.map((entry) => entry.text),
            // Voyage rejects encoding_format:'float' (accepts only 'base64');
            // omitting it returns plain float arrays from both Voyage and
            // Infinity, so the field is simply not sent.
          }),
          signal: controller.signal,
        });
      } catch {
        if (controller.signal.aborted) {
          throw new Error(`embedding service timed out after ${timeoutMs}ms`);
        }
        throw new Error('embedding service request failed');
      }
      if (!response || !response.ok) {
        const status = Number.isInteger(response?.status) ? response.status : 'unknown';
        let detail = '';
        try { detail = (await response.text()).slice(0, 300); } catch { /* body already consumed */ }
        throw new Error(`embedding service returned HTTP ${status}${detail ? `: ${detail}` : ''}`);
      }
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error('embedding service returned invalid JSON');
      }
      tokensUsed += Number(payload?.usage?.total_tokens ?? 0);
      return normalizeResponseData(payload, entries.length);
    } finally {
      clearTimeout(timer);
    }
  }

  // GLOBAL batch limiter: maxConcurrency bounds in-flight requests across
  // ALL embedTexts calls, not per call. With a 32-file worker pool the
  // per-call bound allowed ~200 simultaneous batches against 3 CPU
  // replicas — every request queued past the client timeout and 5.6k files
  // were spuriously marked error (2026-08-06 backfill collapse).
  let inFlight = 0;
  const waiters = [];
  async function withPermit(fn) {
    if (inFlight >= maxConcurrency) {
      await new Promise((resolve) => waiters.push(resolve));
    }
    inFlight += 1;
    try {
      return await fn();
    } finally {
      inFlight -= 1;
      const next = waiters.shift();
      if (next) next();
    }
  }

  // Timeouts under load are congestion, not file corruption — retry with
  // backoff before letting the caller mark the file failed.
  /**
   * Estimates can always be wrong, so the ceiling is enforced by the
   * provider's own answer: on TOO_MANY_TOKENS_IN_BATCH the batch halves and
   * retries until it fits (or a single input is genuinely too large).
   */
  async function requestBatchSplitting(entries) {
    try {
      return await requestBatchWithRetry(entries);
    } catch (err) {
      const msg = String(err?.message ?? err);
      const overBudget = msg.includes('TOO_MANY_TOKENS_IN_BATCH') || msg.includes('max allowed tokens per submitted batch');
      if (!overBudget || entries.length < 2) throw err;
      const mid = Math.floor(entries.length / 2);
      const [left, right] = await Promise.all([
        requestBatchSplitting(entries.slice(0, mid)),
        requestBatchSplitting(entries.slice(mid)),
      ]);
      return [...left, ...right];
    }
  }

  async function requestBatchWithRetry(entries) {
    const delays = [5000, 15000, 45000];
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await withPermit(() => requestBatch(entries));
      } catch (err) {
        const msg = String(err?.message ?? err);
        const retryable = msg.includes('timed out') || msg.includes('HTTP 429') || msg.includes('HTTP 503');
        if (!retryable || attempt >= delays.length) throw err;
        await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      }
    }
  }

  async function embedTexts(inputs) {
    const normalized = normalizeInputs(inputs, { maxInputs, maxTextBytes, revision: modelRevision });
    const results = new Array(normalized.length);
    const misses = new Map();

    for (const [index, entry] of normalized.entries()) {
      const cached = await cache.get(entry.cache_key);
      if (cached !== null && cached !== undefined) {
        results[index] = validateVector(cached, `cached embedding ${entry.cache_key}`);
        continue;
      }
      const miss = misses.get(entry.cache_key) ?? { entry, indexes: [] };
      miss.indexes.push(index);
      misses.set(entry.cache_key, miss);
    }

    const uniqueMisses = [...misses.values()];
    const batches = [];
    {
      let current = [];
      let currentTokens = 0;
      for (const miss of uniqueMisses) {
        // 2.2 bytes/token is deliberately pessimistic: a 3.0 estimate let a
        // 122,517-token batch through Voyage's 120k ceiling (2026-08-07).
        const estTokens = Math.ceil(Buffer.byteLength(miss.entry.text, 'utf8') / 2.2);
        if (current.length > 0 && (current.length >= maxBatchSize || currentTokens + estTokens > maxBatchTokens)) {
          batches.push(current);
          current = [];
          currentTokens = 0;
        }
        current.push(miss);
        currentTokens += estTokens;
      }
      if (current.length > 0) batches.push(current);
    }

    let nextBatch = 0;
    async function worker() {
      while (nextBatch < batches.length) {
        const batchIndex = nextBatch;
        nextBatch += 1;
        const batch = batches[batchIndex];
        const vectors = await requestBatchSplitting(batch.map((miss) => miss.entry));
        await Promise.all(batch.map(async (miss, index) => {
          const vector = vectors[index];
          await cache.set(miss.entry.cache_key, vector);
          for (const resultIndex of miss.indexes) results[resultIndex] = vector;
        }));
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(maxConcurrency, batches.length) }, () => worker()),
    );
    return Object.freeze(results.map((vector) => Object.freeze([...vector])));
  }

  return Object.freeze({
    model,
    modelRevision,
    embedTexts,
    get tokensUsed() { return tokensUsed; },
  });
}
