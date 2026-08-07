import { NextResponse } from 'next/server';

// Readiness probe. Kept intentionally shallow: the console is stateless and
// quill-api is independently failable and degrades per-panel, so its health
// does NOT gate readiness — a degraded upstream must not take the whole
// console out of the load-balancer rotation.
export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json({ status: 'ready' });
}
