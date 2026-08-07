// Search hit shape — the fixed /search response contract (CONTRACT.md).
export interface SearchHit {
  id: string;
  kind: 'file';
  path: string;
  origin: string;
  root: string;
  title: string;
  snippet: string;
  score: number;
  mtime_unix: number;
  match: 'keyword' | 'semantic' | 'both';
}

export interface SearchResponse {
  hits: SearchHit[];
  took_ms: number;
}
