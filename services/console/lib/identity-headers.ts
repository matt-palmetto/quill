/**
 * Internal request-header names used to carry the CF-Access-verified
 * identity from the Edge middleware to Server Components. Kept in a
 * dependency-free module so the Edge middleware can import them WITHOUT
 * pulling in `next/headers` / `server-only`.
 *
 * These headers are set by middleware AFTER verifying the Access JWT and are
 * stripped from any inbound request first, so a client can't pre-inject them.
 */
export const IDENTITY_EMAIL_HEADER = 'x-quill-user-email';
export const IDENTITY_SUB_HEADER = 'x-quill-user-sub';
