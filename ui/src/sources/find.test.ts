import { describe, expect, it } from 'vitest';
import { findMatches, findPattern, firstMatchFrom } from './find';

const lines = ['const userId = params.get("user");', 'fetch(`/todos?userId=${userId}`);', 'USER'];
const pattern = (query: string, matchCase = false, regex = false): RegExp => findPattern(query, { matchCase, regex }) as RegExp;

describe('findMatches', () => {
  it('finds every match with its line and columns', () => {
    expect(findMatches(lines, pattern('userId', true))).toEqual([
      { line: 1, start: 6, end: 12 },
      { line: 2, start: 14, end: 20 },
      { line: 2, start: 23, end: 29 },
    ]);
  });

  it('ignores case unless asked', () => {
    expect(findMatches(lines, pattern('user'))).toHaveLength(5);
    expect(findMatches(lines, pattern('user', true))).toHaveLength(4);
  });

  it('treats the query as text, not a pattern', () => {
    expect(findMatches(lines, pattern('${userId}', true))).toEqual([{ line: 2, start: 21, end: 30 }]);
  });

  it('supports regular expressions', () => {
    expect(findMatches(lines, pattern('user\\w*', true, true))).toHaveLength(4);
  });

  it('skips empty matches', () => {
    expect(findMatches(lines, pattern('^', false, true))).toEqual([]);
  });
});

describe('findPattern', () => {
  it('returns the error for an invalid regular expression', () => {
    expect(typeof findPattern('(', { matchCase: false, regex: true })).toBe('string');
  });

  it('returns nothing for an empty query', () => {
    expect(findPattern('', { matchCase: false, regex: false })).toBeUndefined();
  });
});

describe('firstMatchFrom', () => {
  const matches = [
    { line: 3, start: 0, end: 1 },
    { line: 9, start: 0, end: 1 },
  ];

  it('starts at the first match at or after the line in view', () => {
    expect(firstMatchFrom(matches, 4)).toBe(1);
  });

  it('wraps to the first match past the last one', () => {
    expect(firstMatchFrom(matches, 20)).toBe(0);
  });
});
