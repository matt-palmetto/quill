'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { KNOWN_ORIGINS } from '../lib/origins';
import { splitHighlight } from '../lib/highlight';
import type { SearchHit, SearchResponse } from '../lib/types';

const DEBOUNCE_MS = 150;

export function SearchPalette() {
  const [query, setQuery] = useState('');
  const [origin, setOrigin] = useState<string | null>(null);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [tookMs, setTookMs] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const requestSeq = useRef(0);

  // Global ⌘K / Ctrl+K focuses the search input from anywhere on the page.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Debounced fetch against the server-side proxy (never quill-api directly).
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setHits([]);
      setTookMs(null);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    const seq = ++requestSeq.current;
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ q: trimmed });
      if (origin) params.set('origin', origin);
      fetch(`/api/search?${params.toString()}`)
        .then(async (res) => {
          const body = (await res.json()) as SearchResponse | { error: string };
          if (seq !== requestSeq.current) return; // stale response, dropped
          if (!res.ok || 'error' in body) {
            setError('error' in body ? body.error : `search failed (${res.status})`);
            setHits([]);
            setTookMs(null);
            return;
          }
          setError(null);
          setHits(body.hits);
          setTookMs(body.took_ms);
          setSelectedIndex(0);
        })
        .catch(() => {
          if (seq !== requestSeq.current) return;
          setError('search backend unreachable');
          setHits([]);
          setTookMs(null);
        })
        .finally(() => {
          if (seq === requestSeq.current) setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query, origin]);

  function copyPath(hit: SearchHit) {
    navigator.clipboard?.writeText(hit.path).then(() => {
      setCopiedId(hit.id);
      setTimeout(() => setCopiedId((current) => (current === hit.id ? null : current)), 1200);
    });
  }

  function onInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (hits.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, hits.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const hit = hits[selectedIndex];
      if (hit) copyPath(hit);
    }
  }

  const originChips = useMemo(() => ['all', ...KNOWN_ORIGINS], []);

  return (
    <div className="q-palette">
      <div className="q-palette__searchbar">
        <svg className="q-palette__searchicon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <line x1="21" y1="21" x2="16.2" y2="16.2" strokeLinecap="round" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          className="q-palette__input"
          placeholder="Search everything…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onInputKeyDown}
          autoFocus
          aria-label="Search"
        />
        <kbd className="q-palette__hint">⌘K</kbd>
      </div>

      <div className="q-chips" role="group" aria-label="Filter by origin">
        {originChips.map((chip) => {
          const value = chip === 'all' ? null : chip;
          const active = origin === value;
          return (
            <button
              key={chip}
              type="button"
              className={`q-chip${active ? ' is-active' : ''}`}
              onClick={() => setOrigin(value)}
            >
              {chip}
            </button>
          );
        })}
      </div>

      {error && <div className="q-alert q-alert--error">{error}</div>}

      {!error && query.trim() && !loading && hits.length === 0 && (
        <div className="q-empty">No results for &ldquo;{query.trim()}&rdquo;.</div>
      )}

      <ul className="q-results" role="listbox" aria-label="Search results">
        {hits.map((hit, index) => (
          <li key={hit.id}>
            <button
              type="button"
              className={`q-result${index === selectedIndex ? ' is-selected' : ''}`}
              role="option"
              aria-selected={index === selectedIndex}
              onMouseEnter={() => setSelectedIndex(index)}
              onClick={() => copyPath(hit)}
            >
              <div className="q-result__head">
                <span className="q-result__title">{hit.title}</span>
                <span className={`q-origin-badge q-origin-badge--${badgeVariant(hit.origin)}`}>{hit.origin}</span>
              </div>
              <div className="q-result__path quill-tnum">{hit.path}</div>
              {hit.snippet && (
                <div className="q-result__snippet">
                  {splitHighlight(hit.snippet).map((segment, i) =>
                    segment.highlighted ? <mark key={i}>{segment.text}</mark> : <span key={i}>{segment.text}</span>,
                  )}
                </div>
              )}
              <div className="q-result__meta">
                <span>{formatMtime(hit.mtime_unix)}</span>
                <span className="q-result__match">{hit.match}</span>
                {copiedId === hit.id && <span className="q-result__copied">copied path</span>}
              </div>
            </button>
          </li>
        ))}
      </ul>

      <div className="q-palette__footer">
        <span>
          {hits.length > 0 ? `${hits.length} result${hits.length === 1 ? '' : 's'}` : ''}
        </span>
        <span className="quill-tnum">{tookMs !== null ? `${tookMs} ms` : loading ? 'searching…' : ''}</span>
      </div>

      <p className="q-todo">
        TODO (Phase 2): pressing Enter deep-links to a file viewer — for now it copies the
        path to your clipboard.
      </p>
    </div>
  );
}

function formatMtime(mtimeUnix: number): string {
  return new Date(mtimeUnix * 1000).toLocaleString();
}

const BADGE_VARIANTS = ['a', 'b', 'c', 'd', 'e'] as const;
function badgeVariant(origin: string): string {
  const known = KNOWN_ORIGINS.indexOf(origin as (typeof KNOWN_ORIGINS)[number]);
  if (known !== -1) return KNOWN_ORIGINS[known];
  // Stable fallback variant for an origin outside the known set.
  let hash = 0;
  for (let i = 0; i < origin.length; i++) hash = (hash * 31 + origin.charCodeAt(i)) >>> 0;
  return BADGE_VARIANTS[hash % BADGE_VARIANTS.length];
}
