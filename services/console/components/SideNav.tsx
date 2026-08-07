'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { QuillBrand } from './QuillBrand';

/**
 * Client Component: the console sidebar — Quill brand lockup on top, grouped
 * labeled navigation, and the viewer identity chip in the footer. Client-only
 * because it needs the current pathname to mark the active item. The viewer is
 * passed down from the server layout as serializable display-only props.
 */

export interface SideNavViewer {
  email: string;
}

interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

// Phase 1 information architecture: Search (the palette) and System (sync
// health/ops). Deep-link viewer and role tiers are Phase 2+.
const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Search',
    items: [{ href: '/search', label: 'Palette', icon: <IconSearch /> }],
  },
  {
    label: 'System',
    items: [{ href: '/ops', label: 'Ops', icon: <IconGauge /> }],
  },
];

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function SideNav({ viewer }: { viewer: SideNavViewer | null }) {
  const pathname = usePathname();
  return (
    <aside className="az-side">
      <Link href="/" className="az-side__brand" aria-label="Quill home">
        <QuillBrand />
      </Link>
      <nav className="az-side__nav" aria-label="Quill navigation">
        {NAV_GROUPS.map((group) => (
          <div className="az-side__group" key={group.label}>
            <span className="az-side__group-label">{group.label}</span>
            {group.items.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`az-side__item${active ? ' is-active' : ''}`}
                  aria-label={item.label}
                  aria-current={active ? 'page' : undefined}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="az-side__foot">
        {viewer ? (
          <span className="az-viewer" title={viewer.email}>
            <span className="az-viewer__status" aria-hidden="true" />
            <span className="az-viewer__identity">
              <span className="az-viewer__email">{viewer.email}</span>
              <span className="az-viewer__role">viewer access</span>
            </span>
          </span>
        ) : (
          <span className="az-viewer az-viewer--anon">
            <span>not authenticated</span>
          </span>
        )}
      </div>
    </aside>
  );
}

/**
 * Top-bar page context — the section eyebrow + page title for the current
 * route, derived from the same nav map the sidebar uses.
 */
export function PageContext() {
  const pathname = usePathname();
  let eyebrow = 'Console';
  let title = 'Quill';
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (isActive(pathname, item.href)) {
        eyebrow = group.label;
        title = item.label;
      }
    }
  }
  return (
    <div className="az-context">
      <span className="az-context__eyebrow">{eyebrow}</span>
      <span className="az-context__title">{title}</span>
    </div>
  );
}

// ---- inline icons (no external icon dep; CSP-safe) ----
function IconSearch() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.2" y2="16.2" strokeLinecap="round" />
    </svg>
  );
}
function IconGauge() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 15a8 8 0 1 1 16 0" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 15l4-5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="15" r="1.3" fill="currentColor" stroke="none" />
    </svg>
  );
}
