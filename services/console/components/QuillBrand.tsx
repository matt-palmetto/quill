/**
 * The Quill mark — a single hand-inlined feather, drawn to stay legible from
 * 16px (favicon) to 32px (brand lockup). A gold body with a thin ink spine
 * and nib dot, mirroring the restrained, single-path treatment of azalea's
 * blossom mark.
 */
export function QuillMark({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" role="img" aria-label="Quill">
      <path
        className="q-quill-mark__feather"
        d="M25 4C16 5.5 8.5 12.5 6.5 27c14-2.6 19.8-10.8 20.3-19.6.1-1.7-.3-3.1-1.8-3.4Z"
      />
      <path className="q-quill-mark__spine" d="M23.5 6.5 8.5 24.5" />
      <circle className="q-quill-mark__nib" cx="7.4" cy="25.6" r="1.5" />
    </svg>
  );
}

export function QuillBrand() {
  return (
    <span className="q-brand" aria-label="Quill by Example Org">
      <QuillMark className="q-brand__mark" />
      <span className="q-brand__lockup">
        <span className="q-brand__name">Quill</span>
        <span className="q-brand__byline">by Example Org</span>
      </span>
    </span>
  );
}
