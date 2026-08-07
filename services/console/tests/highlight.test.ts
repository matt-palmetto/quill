import { describe, expect, it } from 'vitest';
import { splitHighlight } from '../lib/highlight';

const START = String.fromCharCode(1);
const END = String.fromCharCode(2);

describe('splitHighlight', () => {
  it('returns an empty array for an empty snippet', () => {
    expect(splitHighlight('')).toEqual([]);
  });

  it('returns a single plain segment when there are no markers', () => {
    expect(splitHighlight('no markers here')).toEqual([{ text: 'no markers here', highlighted: false }]);
  });

  it('splits a single highlighted term', () => {
    const snippet = `the ${START}quick${END} fox`;
    expect(splitHighlight(snippet)).toEqual([
      { text: 'the ', highlighted: false },
      { text: 'quick', highlighted: true },
      { text: ' fox', highlighted: false },
    ]);
  });

  it('handles multiple highlighted terms', () => {
    const snippet = `${START}alpha${END} and ${START}beta${END}`;
    expect(splitHighlight(snippet)).toEqual([
      { text: 'alpha', highlighted: true },
      { text: ' and ', highlighted: false },
      { text: 'beta', highlighted: true },
    ]);
  });

  it('never interprets HTML-like content in the source text as markup (plain-text segments only)', () => {
    const snippet = `${START}invoice${END} <img src=x onerror=alert(1)>`;
    const segments = splitHighlight(snippet);
    expect(segments).toEqual([
      { text: 'invoice', highlighted: true },
      { text: ' <img src=x onerror=alert(1)>', highlighted: false },
    ]);
  });

  it('treats an unterminated start marker as plain text for the remainder', () => {
    const snippet = `before ${START}unterminated`;
    expect(splitHighlight(snippet)).toEqual([
      { text: 'before ', highlighted: false },
      { text: 'unterminated', highlighted: false },
    ]);
  });
});
