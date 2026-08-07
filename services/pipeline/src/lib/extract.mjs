import { readFile } from 'node:fs/promises';
import { basename, extname as pathExtname } from 'node:path';

/** Text extraction: plain read for text-like files, quill-extract for office/pdf docs. */

export const TEXT_EXTENSIONS = new Set([
  'md', 'markdown', 'txt', 'text', 'log', 'json', 'yaml', 'yml', 'csv', 'tsv', 'html', 'htm',
  'xml', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cc',
  'cpp', 'h', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'sql', 'css', 'scss', 'less', 'ini',
  'toml', 'cfg', 'conf', 'env', 'graphql', 'vue', 'svelte',
]);

export const DOC_EXTRACT_EXTENSIONS = new Set(['pdf', 'docx', 'pptx', 'xlsx', 'rtf', 'odt', 'doc']);

export const MAX_TEXT_BYTES = 10 * 1024 * 1024;

const KNOWN_TEXT_FILENAMES = new Set([
  'readme', 'license', 'licence', 'changelog', 'authors', 'contributors', 'notice',
  'makefile', 'dockerfile', 'gemfile', 'rakefile', 'procfile', 'copying', 'todo',
]);

const MIME_BY_EXT = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  rtf: 'application/rtf',
  odt: 'application/vnd.oasis.opendocument.text',
  doc: 'application/msword',
};

export function extname(path) {
  const ext = pathExtname(path);
  return ext.startsWith('.') ? ext.slice(1).toLowerCase() : '';
}

function isKnownTextFilename(absPath) {
  const base = basename(absPath).toLowerCase().replace(/^\./u, '');
  return KNOWN_TEXT_FILENAMES.has(base);
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style[\s\S]*?<\/style>/giu, ' ')
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/[ \t]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function capBytes(text, maxBytes) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= maxBytes) return { text, truncated: false };
  // Slice on the byte cap then drop any partial trailing UTF-8 sequence.
  return { text: buf.subarray(0, maxBytes).toString('utf8').replace(/�+$/u, ''), truncated: true };
}

/**
 * Extract text for one already-scanned, already-size-checked file.
 * Returns { text, truncated, pages } or { unsupported: true } for extensions with no
 * extractor (caller marks these status=skipped, logged once).
 */
export async function extractText(absPath, {
  fetchImpl = globalThis.fetch,
  extractUrl = process.env.QUILL_EXTRACT_URL,
} = {}) {
  const ext = extname(absPath);

  if (DOC_EXTRACT_EXTENSIONS.has(ext)) {
    if (typeof extractUrl !== 'string' || extractUrl.length === 0) {
      throw new Error(`QUILL_EXTRACT_URL is required to extract .${ext} files`);
    }
    const bytes = await readFile(absPath);
    const response = await fetchImpl(`${extractUrl.replace(/\/$/u, '')}/extract`, {
      method: 'POST',
      headers: {
        'content-type': MIME_BY_EXT[ext] ?? 'application/octet-stream',
        // Header values must be Latin-1; corpus filenames may not be. Encode, and have
        // quill-extract decode with the matching urllib.parse.unquote on its side.
        'x-filename': encodeURIComponent(basename(absPath)),
      },
      body: bytes,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`quill-extract HTTP ${response.status}: ${body.slice(0, 500)}`);
    }
    const payload = await response.json();
    const capped = capBytes(payload.text ?? '', MAX_TEXT_BYTES);
    return {
      text: capped.text,
      truncated: capped.truncated || Boolean(payload.truncated),
      pages: payload.pages ?? null,
    };
  }

  if (TEXT_EXTENSIONS.has(ext) || (ext === '' && isKnownTextFilename(absPath))) {
    const raw = await readFile(absPath, 'utf8');
    const text = (ext === 'html' || ext === 'htm') ? stripHtml(raw) : raw;
    const capped = capBytes(text, MAX_TEXT_BYTES);
    return { text: capped.text, truncated: capped.truncated, pages: null };
  }

  return { unsupported: true };
}
