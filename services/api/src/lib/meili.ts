import { config } from '../config.js';

// Meilisearch leg — index `quill_files`, primary key sha256(path). Filters
// are equality/OR clauses over `origin`, `root`, `ext` (comma-separated
// values OR together); attributesToCrop/Highlight drive the snippet.

export interface MeiliHit {
  id: string;
  path: string;
  root: string;
  origin: string;
  title: string;
  ext: string;
  mtime_unix: number;
  size: number;
  _rankingScore?: number;
  _formatted?: {
    title?: string;
    text?: string;
  };
}

interface MeiliSearchResponse {
  hits: MeiliHit[];
}

export interface MeiliFilterOpts {
  origin?: string;
  root?: string;
  ext?: string;
}

/** Builds a Meilisearch filter expression, or undefined when no filters apply. */
export function buildMeiliFilter(opts: MeiliFilterOpts): string | undefined {
  const clauses: string[] = [];
  if (opts.origin) clauses.push(orClause('origin', opts.origin));
  if (opts.root) clauses.push(orClause('root', opts.root));
  if (opts.ext) clauses.push(orClause('ext', opts.ext));
  return clauses.length ? clauses.join(' AND ') : undefined;
}

function orClause(field: string, csv: string): string {
  const values = csv
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  const terms = values.map((v) => `${field} = "${escapeFilterValue(v)}"`);
  return terms.length === 1 ? terms[0] : `(${terms.join(' OR ')})`;
}

function escapeFilterValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export interface MeiliSearchOpts extends MeiliFilterOpts {
  limit: number;
}

// Sentinel control characters U+0001 / U+0002 (SOH / STX, never occur in
// extracted text) mark highlight boundaries instead of literal HTML tags.
// Indexed file content is untrusted — a literal `<mark>` would let arbitrary
// source-file text smuggle HTML/script into the console if ever rendered
// without escaping. Consumers split the snippet on these sentinels and
// render each segment as plain text. Spelled via fromCharCode to keep this
// source file plain ASCII rather than embedding invisible control bytes.
export const HIGHLIGHT_START = String.fromCharCode(1);
export const HIGHLIGHT_END = String.fromCharCode(2);

/** Builds the Meilisearch /search request body — split out for unit testing. */
export function buildMeiliSearchBody(query: string, opts: MeiliSearchOpts): Record<string, unknown> {
  return {
    q: query,
    limit: opts.limit,
    filter: buildMeiliFilter(opts),
    attributesToCrop: ['text'],
    cropLength: 40,
    attributesToHighlight: ['title', 'text'],
    highlightPreTag: HIGHLIGHT_START,
    highlightPostTag: HIGHLIGHT_END,
    showRankingScore: true,
  };
}

export async function searchMeili(query: string, opts: MeiliSearchOpts): Promise<MeiliHit[]> {
  const res = await fetch(`${config.meiliUrl}/indexes/quill_files/search`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(config.meiliKey ? { authorization: `Bearer ${config.meiliKey}` } : {}),
    },
    body: JSON.stringify(buildMeiliSearchBody(query, opts)),
  });
  if (!res.ok) {
    throw new Error(`meili search failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as MeiliSearchResponse;
  return json.hits;
}

export async function meiliReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${config.meiliUrl}/health`, {
      headers: config.meiliKey ? { authorization: `Bearer ${config.meiliKey}` } : {},
    });
    return res.ok;
  } catch {
    return false;
  }
}
