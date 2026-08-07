/**
 * Which files earn embedding tokens.
 *
 * Voyage's free allowance is a shared 200M-token pool, and a re-embed costs
 * a full pass — so tokens go only where semantic search actually pays off:
 * prose and documents. Source code is keyword-only. It is already indexed
 * in git, and embeddings over source are the weakest part of the retrieval
 * story; Meilisearch still covers every one of these files by keyword.
 * (Matt, 2026-08-07: "No need to do this for source code that's already
 * indexed in git. I want to stay in the free range.")
 */

/** Prose + document formats: the text a human wrote to be read. */
export const EMBEDDABLE_EXTENSIONS = new Set([
  'pdf', 'doc', 'docx', 'rtf', 'odt', 'pages',
  'ppt', 'pptx', 'key',
  'xls', 'xlsx', 'ods', 'csv',
  'md', 'markdown', 'txt', 'text', 'rst', 'org',
  'eml', 'msg', 'vtt', 'srt',
]);

/** Per-root policy values. */
export const EMBED_POLICIES = new Set(['documents', 'none', 'all']);

export function normalizeExtension(path) {
  const match = /\.([A-Za-z0-9]{1,8})$/u.exec(path);
  return match ? match[1].toLowerCase() : '';
}

/**
 * @returns {boolean} true when this file's chunks should be embedded.
 */
export function shouldEmbed(path, policy = 'documents') {
  if (policy === 'none') return false;
  if (policy === 'all') return true;
  return EMBEDDABLE_EXTENSIONS.has(normalizeExtension(path));
}
