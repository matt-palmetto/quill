// quill-api marks highlight boundaries with sentinel control characters
// U+0001/U+0002 (see services/api/src/lib/meili.ts) rather than literal
// `<mark>` tags — indexed file content is untrusted, so it must never be
// rendered via dangerouslySetInnerHTML. Split on the sentinels here and
// render each segment as plain React text; React escapes it automatically.

const HIGHLIGHT_START = String.fromCharCode(1);
const HIGHLIGHT_END = String.fromCharCode(2);

export interface HighlightSegment {
  text: string;
  highlighted: boolean;
}

export function splitHighlight(snippet: string): HighlightSegment[] {
  if (!snippet) return [];
  const segments: HighlightSegment[] = [];
  let rest = snippet;
  while (rest.length > 0) {
    const start = rest.indexOf(HIGHLIGHT_START);
    if (start === -1) {
      segments.push({ text: rest, highlighted: false });
      break;
    }
    if (start > 0) {
      segments.push({ text: rest.slice(0, start), highlighted: false });
    }
    const end = rest.indexOf(HIGHLIGHT_END, start + 1);
    if (end === -1) {
      // Unterminated marker — treat the remainder as plain text.
      segments.push({ text: rest.slice(start + 1), highlighted: false });
      break;
    }
    segments.push({ text: rest.slice(start + 1, end), highlighted: true });
    rest = rest.slice(end + 1);
  }
  return segments;
}
