import { NextRequest, NextResponse } from 'next/server';
import { config } from '../../../lib/config';

/**
 * Server-side proxy to quill-api's /search — the ONLY way the browser
 * reaches quill-api (CONTRACT.md: "api is cluster-internal only"). Always
 * forwards fast=1: the palette needs the keyword-only leg for latency: the
 * full (semantic) search is a Phase 2 concern.
 */
export const dynamic = 'force-dynamic';

const FORWARDED_PARAMS = ['limit', 'origin', 'root', 'ext'];

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const q = params.get('q')?.trim() ?? '';
  if (!q) {
    return NextResponse.json({ error: 'missing required query param q' }, { status: 400 });
  }

  const upstream = new URL('/search', config.quillApiUrl);
  upstream.searchParams.set('q', q);
  upstream.searchParams.set('fast', '1');
  for (const key of FORWARDED_PARAMS) {
    const value = params.get(key);
    if (value) upstream.searchParams.set(key, value);
  }

  try {
    const res = await fetch(upstream, { cache: 'no-store' });
    const body = await res.text();
    return new NextResponse(body, {
      status: res.status,
      headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
    });
  } catch (err) {
    console.error('quill-api search proxy failed', err);
    return NextResponse.json({ error: 'search backend unreachable' }, { status: 502 });
  }
}
