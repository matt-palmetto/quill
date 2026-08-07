/**
 * Env config surface for the Quill console.
 *
 * Getters throw lazily (at call time, not import time) so unit tests and
 * `next build` of unrelated routes don't explode on a missing var.
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
  /**
   * Server-side quill-api origin (e.g. http://quill-api:8080, in-cluster
   * DNS). Consumed ONLY by server-side route handlers — never exposed to
   * the browser (CONTRACT.md: "api is cluster-internal only").
   */
  get quillApiUrl(): string {
    return req('QUILL_API_URL');
  },

  /**
   * Cloudflare Access application AUD tag(s), comma-separated. Setting this
   * switches middleware to verify `Cf-Access-Jwt-Assertion` on every
   * request. Unset (local/dev only) falls back to a fixed dev identity.
   */
  get cfAccessAud(): string {
    return opt('CF_ACCESS_AUD');
  },
  get cfAccessTeamDomain(): string {
    return opt('CF_ACCESS_TEAM_DOMAIN', 'example.cloudflareaccess.com');
  },
} as const;
