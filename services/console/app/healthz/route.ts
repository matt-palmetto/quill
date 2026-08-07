import { NextResponse } from 'next/server';

// Liveness probe — allowlisted in middleware so it serves without a
// Cloudflare Access assertion (Access does not attach one to uptime probes).
export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json({ status: 'ok' });
}
