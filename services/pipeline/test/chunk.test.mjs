import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  DEFAULT_OVERLAP_RATIO,
  DEFAULT_WINDOW_TOKENS,
  chunkDocument,
  countApproxTokens,
  hashRawText,
} from '../src/lib/chunk.mjs';

test('hashRawText is SHA-256 of exact raw UTF-8 text without normalization', () => {
  const lf = 'Café\n';
  const crlf = 'Café\r\n';
  assert.equal(hashRawText(lf), createHash('sha256').update(lf, 'utf8').digest('hex'));
  assert.notEqual(hashRawText(lf), hashRawText(crlf));
  assert.notEqual(hashRawText('é'), hashRawText('é'));
});

test('heading mode splits on H2/H3, preserves preamble, and emits strict metadata', () => {
  const rawText = [
    '# Document title',
    'Preamble text.',
    '',
    '## First section',
    'First body.',
    '',
    '### Child section ###',
    'Child body.',
    '',
    '#### H4 stays inside child',
    'Last body.',
    '',
  ].join('\n');

  const chunks = chunkDocument({ rawText, sourcePath: 'docs/example.md', maxTokens: 2 });
  assert.equal(chunks.length, 3, 'fallback token size must not split a document with H2/H3 headings');
  assert.deepEqual(chunks.map((chunk) => chunk.heading), [
    null,
    { level: 2, title: 'First section' },
    { level: 3, title: 'Child section' },
  ]);
  assert.deepEqual(chunks.map((chunk) => chunk.strategy), ['heading', 'heading', 'heading']);
  assert.equal(chunks[0].text, '# Document title\nPreamble text.');
  assert.equal(chunks[1].text, '## First section\nFirst body.');
  assert.equal(
    chunks[2].text,
    '### Child section ###\nChild body.\n\n#### H4 stays inside child\nLast body.',
  );
  assert.equal(chunks[1].source_path, 'docs/example.md');
  assert.equal(chunks[1].content_hash, hashRawText(rawText));
  assert.equal(
    chunks[1].chunk_text_hash,
    createHash('sha256').update(chunks[1].text, 'utf8').digest('hex'),
  );
  assert.equal(chunks[1].chunk_index, 1);
  assert.equal(chunks[1].start_line, 4);
  assert.equal(chunks[1].end_line, 5);
  assert.equal(chunks[1].locator, 'docs/example.md#L4-L5');
  assert.equal(chunks[1].text, rawText.slice(chunks[1].start_offset, chunks[1].end_offset));
  assert.equal(chunks[1].token_count, countApproxTokens(chunks[1].text));
});

test('heading-like text inside fenced code does not select heading mode', () => {
  const rawText = ['```markdown', '## not a boundary', '```', 'one two three four'].join('\n');
  const chunks = chunkDocument({
    rawText,
    sourcePath: 'docs/fenced.md',
    maxTokens: 3,
    overlapRatio: 0,
  });
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.strategy === 'window'));
  assert.ok(chunks.every((chunk) => chunk.heading === null));
});

test('headingless prose uses deterministic sliding windows with exact overlap', () => {
  const words = Array.from({ length: 12 }, (_, index) => `w${index + 1}`);
  const chunks = chunkDocument({
    rawText: words.join(' '),
    sourcePath: 'docs/prose.txt',
    maxTokens: 5,
    overlapRatio: 0.2,
  });

  assert.deepEqual(chunks.map((chunk) => chunk.text), [
    'w1 w2 w3 w4 w5',
    'w5 w6 w7 w8 w9',
    'w9 w10 w11 w12',
  ]);
  assert.deepEqual(chunks.map((chunk) => chunk.token_count), [5, 5, 4]);
  assert.equal(chunks[0].text.split(/\s+/u).at(-1), chunks[1].text.split(/\s+/u)[0]);
  assert.equal(chunks[1].text.split(/\s+/u).at(-1), chunks[2].text.split(/\s+/u)[0]);
});

test('default fallback is 500 approximate tokens with a 75-token overlap (CONTRACT.md chunking)', () => {
  assert.equal(DEFAULT_WINDOW_TOKENS, 500);
  assert.equal(DEFAULT_OVERLAP_RATIO, 0.15);
  const words = Array.from({ length: 1_000 }, (_, index) => `t${index}`);
  const chunks = chunkDocument({ rawText: words.join(' '), sourcePath: 'docs/long.txt' });
  assert.deepEqual(chunks.map((chunk) => chunk.token_count), [500, 500, 150]);
  assert.equal(chunks[0].text.split(' ')[425], chunks[1].text.split(' ')[0]);
  assert.equal(chunks[1].text.split(' ')[425], chunks[2].text.split(' ')[0]);
});

test('a one-token window always advances even when the requested overlap is near 100%', () => {
  const chunks = chunkDocument({
    rawText: 'one two three',
    sourcePath: 'docs/tiny-window.txt',
    maxTokens: 1,
    overlapRatio: 0.99,
  });
  assert.deepEqual(chunks.map((chunk) => chunk.text), ['one', 'two', 'three']);
});

test('same source content always produces byte-identical chunk identities and metadata', () => {
  const input = { rawText: 'alpha beta gamma delta', sourcePath: 'docs/stable.md', maxTokens: 2 };
  assert.deepEqual(chunkDocument(input), chunkDocument(input));
});

test('chunk_text_hash addresses exact text independently of document identity', () => {
  const left = chunkDocument({ rawText: 'same exact chunk', sourcePath: 'docs/left.md' });
  const right = chunkDocument({ rawText: 'same exact chunk', sourcePath: 'docs/right.md' });

  assert.equal(left[0].chunk_text_hash, right[0].chunk_text_hash);
  assert.equal(left[0].content_hash, right[0].content_hash);
});

test('invalid chunk inputs fail closed', () => {
  assert.throws(() => hashRawText(Buffer.from('bytes')), /rawText must be a string/);
  assert.throws(() => chunkDocument({ rawText: 'text', sourcePath: ' docs.md' }), /sourcePath/);
  assert.throws(
    () => chunkDocument({ rawText: 'text', sourcePath: 'docs.md', maxTokens: 0 }),
    /positive integer/,
  );
  assert.throws(
    () => chunkDocument({ rawText: 'text', sourcePath: 'docs.md', overlapRatio: 1 }),
    /overlapRatio/,
  );
});

// --- token-aware batching (Voyage caps a request at 120k tokens) ---
import { createEmbeddingClient } from '../src/lib/embeddings.mjs';

test('embedTexts splits batches by token budget, not just count', async () => {
  const seen = [];
  // distinct texts: identical inputs legitimately dedupe to one cache key
  const big = (n) => `${n} ` + 'x'.repeat(150_000); // ~50k est. tokens each
  const client = createEmbeddingClient({
    baseUrl: 'http://embed.test/v1',
    maxBatchSize: 64,
    maxBatchTokens: 90_000,
    maxTextBytes: 200_000,
    fetchImpl: async (_url, init) => {
      const inputs = JSON.parse(init.body).input;
      seen.push(inputs.length);
      return { ok: true, status: 200, json: async () => ({
        data: inputs.map((_t, i) => ({ index: i, embedding: new Array(1024).fill(0.01) })),
      }) };
    },
  });
  await client.embedTexts([{ text: big(1) }, { text: big(2) }, { text: big(3) }]);
  assert.ok(seen.every((n) => n <= 2), `each request must respect the token budget, got ${seen}`);
  assert.equal(seen.reduce((a, b) => a + b, 0), 3);
});

test('embedTexts halves and retries a batch the provider rejects as over-budget', async () => {
  let calls = 0;
  const client = createEmbeddingClient({
    baseUrl: 'http://embed.test/v1',
    maxBatchSize: 64,
    maxBatchTokens: 10_000_000, // force one oversized batch past the estimator
    fetchImpl: async (_url, init) => {
      const inputs = JSON.parse(init.body).input;
      calls += 1;
      if (inputs.length > 1) {
        return { ok: false, status: 400,
          text: async () => JSON.stringify({ detail: 'max allowed tokens per submitted batch is 120000', error_code: 'TOO_MANY_TOKENS_IN_BATCH' }) };
      }
      return { ok: true, status: 200, json: async () => ({
        data: inputs.map((_t, i) => ({ index: i, embedding: new Array(1024).fill(0.02) })) }) };
    },
  });
  const out = await client.embedTexts([{ text: 'alpha' }, { text: 'beta' }, { text: 'gamma' }, { text: 'delta' }]);
  assert.equal(out.length, 4, 'every input still gets a vector');
  assert.ok(calls > 4, 'must have split before succeeding');
});
