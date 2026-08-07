/**
 * Env config surface for quill-api. Getters throw lazily (at call time, not
 * import time) so unit tests can import pure helpers from modules that also
 * export network-calling functions without needing every env var set.
 */

function req(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required env var ${name}`);
  }
  return v;
}

function opt(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

export const config = {
  get port(): number {
    return Number(opt('PORT', '8080'));
  },
  /** CNPG connection string for the `quill` database (see CONTRACT.md). */
  get pgUrl(): string {
    return req('QUILL_PG_URL');
  },
  get meiliUrl(): string {
    return req('QUILL_MEILI_URL');
  },
  get meiliKey(): string {
    return opt('QUILL_MEILI_KEY');
  },
  get qdrantUrl(): string {
    return req('QUILL_QDRANT_URL');
  },
  get qdrantApiKey(): string {
    return opt('QUILL_QDRANT_API_KEY');
  },
  /** OpenAI-style base, e.g. http://quill-embed:7997/v1 — bge-m3 embeddings. */
  get embedUrl(): string {
    return req('QUILL_EMBED_URL');
  },
} as const;
