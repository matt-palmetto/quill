import { createHash } from 'node:crypto';

/**
 * Deterministic document chunking for Quill (Phase 1).
 *
 * Fork of m7-sales lib/brain-chunk.mjs — same 500-token/0.15-overlap, markdown-header-aware
 * contract (CONTRACT.md "Chunking"). Trimmed to what the pipeline actually consumes:
 * ingestion planning (previousContentHash noop check) is dropped since file_state already
 * carries that decision upstream in scan.mjs.
 */

export const DEFAULT_WINDOW_TOKENS = 500;
export const DEFAULT_OVERLAP_RATIO = 0.15;

const TOKEN_RE = /\S+/gu;
const ATX_H2_H3_RE = /^ {0,3}(#{2,3})[\t ]+(.+?)[\t ]*#*[\t ]*$/u;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/u;

function requireRawText(rawText) {
  if (typeof rawText !== 'string') {
    throw new TypeError('rawText must be a string');
  }
}

function requireSourcePath(sourcePath) {
  if (
    typeof sourcePath !== 'string' ||
    sourcePath.length === 0 ||
    sourcePath !== sourcePath.trim()
  ) {
    throw new TypeError('sourcePath must be a non-empty, trimmed string');
  }
}

function requireChunkOptions(maxTokens, overlapRatio) {
  if (!Number.isInteger(maxTokens) || maxTokens < 1) {
    throw new RangeError('maxTokens must be a positive integer');
  }
  if (!Number.isFinite(overlapRatio) || overlapRatio < 0 || overlapRatio >= 1) {
    throw new RangeError('overlapRatio must be a number from 0 (inclusive) to 1 (exclusive)');
  }
}

/** SHA-256 over the exact UTF-8 raw source text. No newline or Unicode normalization. */
export function hashRawText(rawText) {
  requireRawText(rawText);
  return createHash('sha256').update(rawText, 'utf8').digest('hex');
}

/** Dependency-free token approximation: one token is one non-whitespace run. */
export function countApproxTokens(text) {
  requireRawText(text);
  return [...text.matchAll(TOKEN_RE)].length;
}

function lineNumberAt(rawText, offset) {
  let line = 1;
  for (let i = 0; i < offset; i += 1) {
    if (rawText.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function trimSpan(rawText, startOffset, endOffset) {
  let start = startOffset;
  let end = endOffset;
  while (start < end && /\s/u.test(rawText[start])) start += 1;
  while (end > start && /\s/u.test(rawText[end - 1])) end -= 1;
  return { start, end };
}

/**
 * Find H2/H3 ATX headings outside fenced code blocks. H1 and H4+ are content, not
 * boundaries (matches the approved chunking contract).
 */
function findHeadingBoundaries(rawText) {
  const headings = [];
  let offset = 0;
  let openFence = null;

  while (offset < rawText.length) {
    const newline = rawText.indexOf('\n', offset);
    const nextOffset = newline === -1 ? rawText.length : newline + 1;
    const lineWithPossibleCr = rawText.slice(offset, newline === -1 ? rawText.length : newline);
    const line = lineWithPossibleCr.endsWith('\r')
      ? lineWithPossibleCr.slice(0, -1)
      : lineWithPossibleCr;
    const fence = line.match(FENCE_RE)?.[1] ?? null;

    if (fence) {
      if (!openFence) {
        openFence = { marker: fence[0], length: fence.length };
      } else if (fence[0] === openFence.marker && fence.length >= openFence.length) {
        openFence = null;
      }
    } else if (!openFence) {
      const heading = line.match(ATX_H2_H3_RE);
      if (heading) {
        headings.push({
          start: offset,
          level: heading[1].length,
          title: heading[2].trim(),
        });
      }
    }

    offset = nextOffset;
  }

  return headings;
}

function makeChunk({
  rawText,
  sourcePath,
  contentHash,
  index,
  strategy,
  startOffset,
  endOffset,
  heading = null,
}) {
  const text = rawText.slice(startOffset, endOffset);
  const chunkTextHash = createHash('sha256').update(text, 'utf8').digest('hex');
  const startLine = lineNumberAt(rawText, startOffset);
  const endLine = lineNumberAt(rawText, Math.max(startOffset, endOffset - 1));

  return Object.freeze({
    source_path: sourcePath,
    content_hash: contentHash,
    chunk_text_hash: chunkTextHash,
    chunk_index: index,
    strategy,
    heading,
    locator: `${sourcePath}#L${startLine}-L${endLine}`,
    start_offset: startOffset,
    end_offset: endOffset,
    start_line: startLine,
    end_line: endLine,
    token_count: countApproxTokens(text),
    text,
  });
}

function headingChunks(rawText, sourcePath, contentHash, headings) {
  const spans = [];
  const preamble = trimSpan(rawText, 0, headings[0].start);
  if (preamble.end > preamble.start) {
    spans.push({ ...preamble, heading: null });
  }

  for (let i = 0; i < headings.length; i += 1) {
    const current = headings[i];
    const next = headings[i + 1];
    const span = trimSpan(rawText, current.start, next?.start ?? rawText.length);
    if (span.end > span.start) {
      spans.push({
        ...span,
        heading: Object.freeze({ level: current.level, title: current.title }),
      });
    }
  }

  return spans.map((span, index) => makeChunk({
    rawText,
    sourcePath,
    contentHash,
    index,
    strategy: 'heading',
    startOffset: span.start,
    endOffset: span.end,
    heading: span.heading,
  }));
}

function windowChunks(rawText, sourcePath, contentHash, maxTokens, overlapRatio) {
  const tokens = [...rawText.matchAll(TOKEN_RE)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
  if (tokens.length === 0) return [];

  // Floor keeps the step positive for every valid ratio, including one-token test
  // windows, while producing the required 75-token overlap for 500 x 15%.
  const overlapTokens = Math.floor(maxTokens * overlapRatio);
  const step = maxTokens - overlapTokens;
  const chunks = [];

  for (let tokenStart = 0; tokenStart < tokens.length; tokenStart += step) {
    const tokenEnd = Math.min(tokenStart + maxTokens, tokens.length);
    chunks.push(makeChunk({
      rawText,
      sourcePath,
      contentHash,
      index: chunks.length,
      strategy: 'window',
      startOffset: tokens[tokenStart].start,
      endOffset: tokens[tokenEnd - 1].end,
    }));
    if (tokenEnd === tokens.length) break;
  }

  return chunks;
}

/**
 * Chunk a document deterministically.
 *
 * Any H2/H3 outside fenced code selects heading mode for the whole document. Otherwise
 * the text uses a sliding token window (500 tokens, 0.15 overlap). Heading chunks preserve
 * the heading line itself; a non-empty preamble before the first H2/H3 is chunk zero.
 */
export function chunkDocument({
  rawText,
  sourcePath,
  maxTokens = DEFAULT_WINDOW_TOKENS,
  overlapRatio = DEFAULT_OVERLAP_RATIO,
} = {}) {
  requireRawText(rawText);
  requireSourcePath(sourcePath);
  requireChunkOptions(maxTokens, overlapRatio);

  const contentHash = hashRawText(rawText);
  const headings = findHeadingBoundaries(rawText);
  const chunks = headings.length > 0
    ? headingChunks(rawText, sourcePath, contentHash, headings)
    : windowChunks(rawText, sourcePath, contentHash, maxTokens, overlapRatio);
  return Object.freeze(chunks);
}
