// Known cloud-drives origins (CONTRACT.md / DECISIONS.md 2026-08-06): the
// first path segment under cloud-drives. Used only to give filter chips a
// stable order and color — an unlisted origin still renders (generic chip
// style), it just sorts after the known set.
// …plus mac-sync's per-machine origins (first path segment under mac-sync,
// added 2026-08-06 so each machine — e.g. the jon-snow MacBook — is its own
// filterable source).
export const KNOWN_ORIGINS = [
  'matt', 'example-org', 'meridian7', 'example-fitness', 'archives',
  'jon-snow', 'matts-mac-studio', 'workstation', 'mac',
] as const;

export function originRank(origin: string): number {
  const idx = KNOWN_ORIGINS.indexOf(origin as (typeof KNOWN_ORIGINS)[number]);
  return idx === -1 ? KNOWN_ORIGINS.length : idx;
}
