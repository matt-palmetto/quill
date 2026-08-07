import { EMBED_POLICIES } from './embed-policy.mjs';
import { readFile } from 'node:fs/promises';

/**
 * sources.json loader + exclusion/origin rules (CONTRACT.md "Sources config").
 *
 * Exclude rules (strings) come in three forms, checked against the path segments from
 * a root to a candidate entry (files or directories), always evaluated BEFORE descent:
 *   "/seg1/seg2"  anchored prefix match from the root (e.g. "/sarah" excludes only the
 *                 top-level cloud-drives/sarah directory, not any nested "sarah").
 *   "*.suffix"    suffix match on the current entry's basename (e.g. "*.git" excludes
 *                 bare-mirror directories like "myrepo.git").
 *   "name"        exact basename match at any depth (e.g. "objects" excludes any
 *                 directory literally named "objects", used for bare-repo internals).
 */

export async function loadSources(filePath) {
  const raw = await readFile(filePath, 'utf8');
  const config = JSON.parse(raw);
  if (!Array.isArray(config.roots) || config.roots.length === 0) {
    throw new TypeError('sources.json must have a non-empty "roots" array');
  }
  for (const root of config.roots) {
    if (typeof root.name !== 'string' || root.name.length === 0) {
      throw new TypeError('each source root needs a "name"');
    }
    if (typeof root.path !== 'string' || root.path.length === 0) {
      throw new TypeError(`root ${root.name} needs a "path"`);
    }
    if (typeof root.origin !== 'string' || root.origin.length === 0) {
      throw new TypeError(`root ${root.name} needs an "origin" ("path-segment" or a fixed string)`);
    }
    if (root.exclude !== undefined && !Array.isArray(root.exclude)) {
      throw new TypeError(`root ${root.name} "exclude" must be an array of strings`);
    }
    root.exclude = root.exclude ?? [];
    root.enabled = root.enabled !== false;
    root.embed = root.embed ?? 'documents';
    if (!EMBED_POLICIES.has(root.embed)) {
      throw new TypeError(`root ${root.name} has invalid "embed" policy "${root.embed}"`);
    }
  }
  return config;
}

export function enabledRoots(config) {
  return config.roots.filter((root) => root.enabled);
}

/**
 * Rules applied to EVERY root regardless of config. Git worktrees are
 * duplicate checkouts of a repo we already index (and re-embed identical
 * content at real token cost), so they are never opened — matched anywhere
 * in the path, under any name: `worktrees/`, `.worktrees/`,
 * `.claude/worktrees/`, `pi-maint-worktrees/`, `<repo>-worktree/`.
 */
export const ALWAYS_EXCLUDED_SEGMENT_SUBSTRINGS = ['worktree'];

function isAlwaysExcluded(relSegments) {
  return relSegments.some((segment) => {
    const lower = segment.toLowerCase();
    return ALWAYS_EXCLUDED_SEGMENT_SUBSTRINGS.some((needle) => lower.includes(needle));
  });
}

/** True if the entry at relSegments (path parts below the root) must never be opened. */
export function isExcluded(relSegments, excludeRules) {
  if (relSegments.length === 0) return false;
  if (isAlwaysExcluded(relSegments)) return true;
  if (!Array.isArray(excludeRules) || excludeRules.length === 0) return false;
  const basename = relSegments[relSegments.length - 1];

  for (const rule of excludeRules) {
    if (typeof rule !== 'string' || rule.length === 0) continue;

    if (rule.startsWith('/')) {
      const ruleSegments = rule.slice(1).split('/').filter(Boolean);
      if (
        relSegments.length >= ruleSegments.length &&
        ruleSegments.every((seg, i) => relSegments[i] === seg)
      ) {
        return true;
      }
      continue;
    }

    if (rule.startsWith('*.')) {
      if (basename.endsWith(rule.slice(1))) return true;
      continue;
    }

    if (basename === rule) return true;
  }

  return false;
}

/** origin = fixed string, or the first path segment below the root ("path-segment"). */
export function deriveOrigin(root, relSegments) {
  if (root.origin === 'path-segment') {
    if (relSegments.length === 0) {
      throw new Error(`cannot derive path-segment origin for root "${root.name}" at its own root`);
    }
    return relSegments[0];
  }
  return root.origin;
}
