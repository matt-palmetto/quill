import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { config } from './config';

/**
 * Cloudflare Access assertion verification (forked from azalea
 * fleet-console's lib/cf-access.ts — same verification, no IAP fallback:
 * Quill has only ever run behind Cloudflare Access).
 *
 * Access injects `Cf-Access-Jwt-Assertion` — an RS256 JWT signed by the
 * Zero Trust team — on every request that traversed the Access edge. The
 * convenience header (Cf-Access-Authenticated-User-Email) is spoofable at a
 * directly-reached origin and is NEVER trusted; only the verified JWT
 * proves the request passed Access.
 *
 * Enabled by setting CF_ACCESS_AUD (the Access application's AUD tag).
 * Comma-separated accepts several Access apps on one origin.
 *
 * Human logins carry `email` + `sub` (user id); service tokens carry
 * `common_name` (the token's client id) and no email. Both are accepted —
 * service tokens map to `<common_name>@service.cloudflareaccess`.
 */

export interface CfAccessIdentity {
  /** Verified subject: Access user id, or the service-token client id. */
  sub: string;
  /** Verified email (lower-cased), or the synthetic service-token identity. */
  email: string;
}

const HEADER = 'cf-access-jwt-assertion';

// Lazy: Access is optional — only build the remote JWKS when configured.
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

export function cfAccessAudiences(): string[] {
  return config.cfAccessAud
    .split(',')
    .map((aud) => aud.trim())
    .filter(Boolean);
}

export function cfAccessConfigured(): boolean {
  return cfAccessAudiences().length > 0;
}

export function cfAccessHeaderName(): string {
  return HEADER;
}

export async function verifyCfAccessAssertion(
  token: string | null | undefined,
): Promise<CfAccessIdentity | null> {
  if (!token || !cfAccessConfigured()) return null;
  const issuer = `https://${config.cfAccessTeamDomain}`;
  try {
    jwks ??= createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    const { payload } = await jwtVerify(token, jwks, {
      issuer,
      // EXACT match against any configured app AUD — jose rejects mismatches.
      audience: cfAccessAudiences(),
      algorithms: ['RS256'],
    });
    return identityFromCfPayload(payload);
  } catch {
    // Signature/issuer/audience/exp failure → unauthenticated.
    return null;
  }
}

export function identityFromCfPayload(payload: JWTPayload): CfAccessIdentity | null {
  const p = payload as Record<string, unknown>;
  const email = typeof p.email === 'string' ? p.email.toLowerCase() : '';
  const sub = typeof payload.sub === 'string' ? payload.sub : '';
  if (email && sub) return { sub, email };
  // Service token: no email; identity is the token's common_name.
  const commonName = typeof p.common_name === 'string' ? p.common_name : '';
  if (commonName) {
    return {
      sub: commonName,
      email: `${commonName.toLowerCase()}@service.cloudflareaccess`,
    };
  }
  return null;
}
