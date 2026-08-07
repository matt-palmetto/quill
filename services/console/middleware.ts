import { NextResponse, type NextRequest } from 'next/server';
import {
  verifyCfAccessAssertion,
  cfAccessConfigured,
  cfAccessHeaderName,
} from './lib/cf-access';
import { IDENTITY_EMAIL_HEADER, IDENTITY_SUB_HEADER } from './lib/identity-headers';

/**
 * Edge middleware — the single auth verification layer.
 *
 * On EVERY matched request we verify the signed Cloudflare Access assertion
 * (RS256, correct issuer, EXACT-match audience) and forward ONLY the
 * verified sub/email to Server Components via internal request headers. The
 * plain Cf-Access-Authenticated-User-Email header is never trusted — it is
 * spoofable if a request reaches the backend without traversing Access.
 *
 * Health-probe / static paths are allowlisted (Access does not attach a JWT
 * to uptime probes) — hard-failing on a missing JWT would 500 liveness
 * checks.
 *
 * When CF_ACCESS_AUD is unset (local/dev only — never true once a real
 * deployment sets it), every request is forwarded under a fixed dev
 * identity. quill-api itself has no in-service auth (CONTRACT.md: "Auth:
 * none in-service ... api is cluster-internal only") — this console is the
 * only gated surface.
 */

const PUBLIC_PATHS = ['/healthz', '/readyz', '/favicon.ico'];

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;

  if (isPublic(pathname)) {
    return NextResponse.next();
  }

  if (cfAccessConfigured()) {
    const identity = await verifyCfAccessAssertion(
      req.headers.get(cfAccessHeaderName()),
    );
    if (!identity) {
      return new NextResponse(
        'Unauthorized: missing or invalid Cloudflare Access assertion',
        { status: 401 },
      );
    }
    return forward(req, identity);
  }

  return forward(req, {
    sub: 'dev:local',
    email: process.env.DEV_USER_EMAIL?.toLowerCase() || 'user@example.com',
  });
}

function forward(
  req: NextRequest,
  identity: { sub: string; email: string },
): NextResponse {
  // Strip any client-supplied identity headers before stamping verified ones.
  const headers = new Headers(req.headers);
  headers.delete(IDENTITY_EMAIL_HEADER);
  headers.delete(IDENTITY_SUB_HEADER);
  headers.set(IDENTITY_EMAIL_HEADER, identity.email);
  headers.set(IDENTITY_SUB_HEADER, identity.sub);
  return NextResponse.next({ request: { headers } });
}

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.includes(pathname)) return true;
  return pathname.startsWith('/_next/') || pathname.startsWith('/static/');
}

// Next reads the matcher from the exported `config`.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|healthz|readyz).*)'],
};
