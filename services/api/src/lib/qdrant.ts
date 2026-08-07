import { config } from '../config.js';

// Qdrant leg — collection `quill_chunks`, 1024-d cosine. Payload carries
// path/root/origin/chunk_index/text/mtime_unix (CONTRACT.md). We search on
// the query embedding and group results by path in the merge step.

export interface QdrantPointPayload {
  path: string;
  root: string;
  origin: string;
  source: string;
  chunk_index: number;
  text: string;
  content_hash: string;
  model: string;
  mtime_unix: number;
}

export interface QdrantPoint {
  id: string;
  score: number;
  payload: QdrantPointPayload;
}

interface QdrantSearchResponse {
  result: QdrantPoint[];
}

export interface QdrantFilterOpts {
  origin?: string;
  root?: string;
}

/** Builds a Qdrant filter object, or undefined when no filters apply. */
export function buildQdrantFilter(opts: QdrantFilterOpts): Record<string, unknown> | undefined {
  const must: Record<string, unknown>[] = [];
  if (opts.origin) must.push(matchClause('origin', opts.origin));
  if (opts.root) must.push(matchClause('root', opts.root));
  return must.length ? { must } : undefined;
}

function matchClause(key: string, csv: string): Record<string, unknown> {
  const values = csv
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  return values.length === 1 ? { key, match: { value: values[0] } } : { key, match: { any: values } };
}

export interface QdrantSearchOpts extends QdrantFilterOpts {
  limit: number;
}

/** Builds the Qdrant points/search request body — split out for unit testing. */
export function buildQdrantSearchBody(vector: number[], opts: QdrantSearchOpts): Record<string, unknown> {
  return {
    vector,
    limit: opts.limit,
    with_payload: true,
    filter: buildQdrantFilter(opts),
  };
}

export async function searchQdrant(vector: number[], opts: QdrantSearchOpts): Promise<QdrantPoint[]> {
  const res = await fetch(`${config.qdrantUrl}/collections/quill_chunks/points/search`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(config.qdrantApiKey ? { 'api-key': config.qdrantApiKey } : {}),
    },
    body: JSON.stringify(buildQdrantSearchBody(vector, opts)),
  });
  if (!res.ok) {
    throw new Error(`qdrant search failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as QdrantSearchResponse;
  return json.result;
}
