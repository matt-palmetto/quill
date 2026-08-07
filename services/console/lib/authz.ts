import 'server-only';
import { headers } from 'next/headers';
import { IDENTITY_EMAIL_HEADER, IDENTITY_SUB_HEADER } from './identity-headers';

/**
 * Viewer identity — display-only. Phase 1 is read-only and every verified
 * identity is a viewer (no role tiers; see CONTRACT.md/console build
 * instructions, "Skip role tiers"). Re-introduce `role` here if/when a
 * mutation needs a stricter check.
 */
export interface Viewer {
  email: string;
  sub: string;
}

// Re-exported for convenience; canonical definition is dependency-free so
// the Edge middleware can import it without next/headers or server-only.
export { IDENTITY_EMAIL_HEADER, IDENTITY_SUB_HEADER };

/**
 * Read the verified identity forwarded by middleware. Returns null if the
 * request carries no verified identity (should not happen on gated routes —
 * middleware would have 401'd — but callers must handle it).
 */
export async function currentViewer(): Promise<Viewer | null> {
  const h = await headers();
  const email = h.get(IDENTITY_EMAIL_HEADER);
  const sub = h.get(IDENTITY_SUB_HEADER);
  if (!email || !sub) return null;
  return { email, sub };
}
