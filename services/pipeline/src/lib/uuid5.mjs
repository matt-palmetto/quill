import { createHash } from 'node:crypto';

/**
 * RFC 4122 UUIDv5 (SHA-1, namespace + name), dependency-free. Used for Qdrant point ids
 * so re-runs over the same (path, chunk_index, content_hash) always upsert the same point.
 */

// Fixed application namespace for Quill Qdrant point ids. Arbitrary but constant --
// changing this would silently orphan every previously-indexed point. Generated once
// with crypto.randomUUID(); do not regenerate.
export const QUILL_QDRANT_NAMESPACE = '2f6e6b2e-6d84-4f7a-9d7b-8b6a7a9c9f11';

function parseUuid(uuid) {
  const hex = uuid.replace(/-/gu, '');
  if (!/^[0-9a-f]{32}$/iu.test(hex)) {
    throw new TypeError('namespace must be a valid UUID string');
  }
  return Buffer.from(hex, 'hex');
}

export function uuid5(name, namespace = QUILL_QDRANT_NAMESPACE) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('name must be a non-empty string');
  }
  const namespaceBytes = parseUuid(namespace);
  const hash = createHash('sha1')
    .update(namespaceBytes)
    .update(Buffer.from(name, 'utf8'))
    .digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant RFC4122
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
