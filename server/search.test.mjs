import { describe, expect, it } from 'vitest';
import { searchContent, searchFiles, searchPattern } from './search.mjs';

describe('searchPattern', () => {
  it('escapes plain text and ignores case by default', () => {
    expect(searchPattern('a.b').test('A.B')).toBe(true);
    expect(searchPattern('a.b').test('axb')).toBe(false);
  });

  it('honours match case, regex and whole word', () => {
    expect(searchPattern('User', { matchCase: true }).test('user')).toBe(false);
    expect(searchPattern('user\\d', { regex: true }).test('user7')).toBe(true);
    expect(searchPattern('user', { wholeWord: true }).test('userId')).toBe(false);
    expect(searchPattern('user', { wholeWord: true }).test('get user')).toBe(true);
  });

  it('throws on an invalid regular expression', () => {
    expect(() => searchPattern('(', { regex: true })).toThrow();
  });
});

describe('searchContent', () => {
  it('reports each matching line once, with its column and context', () => {
    const content = 'const a = 1;\nconst userId = get("user");\nreturn user;';
    expect(searchContent(content, searchPattern('user'), 10)).toEqual([
      { line: 2, column: 6, length: 4, text: 'const userId = get("user");', offset: 6 },
      { line: 3, column: 7, length: 4, text: 'return user;', offset: 7 },
    ]);
  });

  it('trims long lines around the match', () => {
    const [match] = searchContent(`${'x'.repeat(500)}needle${'y'.repeat(500)}`, searchPattern('needle'), 10);
    expect(match.text.length).toBe(80 + 6 + 80);
    expect(match.text.slice(match.offset, match.offset + match.length)).toBe('needle');
  });

  it('stops at the limit', () => {
    expect(searchContent('a\na\na\na', searchPattern('a'), 2)).toHaveLength(2);
  });
});

describe('searchFiles', () => {
  const files = { '/r/a.ts': 'one\nfetch()', '/r/b.ts': 'nothing', '/r/c.ts': 'fetch\nfetch\nfetch' };
  const read = async (file) => files[file];

  it('returns the files with matches in the order given', async () => {
    const result = await searchFiles(Object.keys(files), searchPattern('fetch'), read);
    expect(result.results.map((entry) => entry.file)).toEqual(['/r/a.ts', '/r/c.ts']);
    expect(result).toMatchObject({ total: 4, searched: 3, truncated: false });
  });

  it('says when the result limit cut the search short', async () => {
    const result = await searchFiles(Object.keys(files), searchPattern('fetch'), read, { maxResults: 2, concurrency: 1 });
    expect(result.total).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it('skips files it cannot read', async () => {
    const result = await searchFiles(['/r/missing.ts', '/r/a.ts'], searchPattern('one'), read);
    expect(result.results).toHaveLength(1);
  });
});
