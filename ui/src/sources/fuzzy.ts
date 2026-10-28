/**
 * Quick-open matching: the typed characters must appear in the path in order, and a match scores
 * higher when it falls in the file name, runs on consecutively, or starts a word.
 */

export interface FuzzyMatch {
  score: number;
  /** Indexes in the path of the matched characters, for highlighting. */
  positions: number[];
}

const WORD_START = /[/\\._\-\s]/;

export function fuzzyMatch(query: string, path: string): FuzzyMatch | undefined {
  const needle = query.replace(/\s+/g, '').toLowerCase();
  if (!needle) return { score: 0, positions: [] };
  const haystack = path.toLowerCase();
  const nameStart = path.lastIndexOf('/') + 1;

  // Match from the end, so characters land in the file name when they can.
  const positions: number[] = [];
  let at = haystack.length - 1;
  for (let index = needle.length - 1; index >= 0; index -= 1) {
    at = haystack.lastIndexOf(needle[index], at);
    if (at < 0) return undefined;
    positions.unshift(at);
    at -= 1;
  }

  let score = 0;
  positions.forEach((position, index) => {
    score += 1;
    if (position >= nameStart) score += 2;
    if (index > 0 && positions[index - 1] === position - 1) score += 3;
    if (position === 0 || WORD_START.test(path[position - 1]) || (/[a-z]/.test(path[position - 1]) && /[A-Z]/.test(path[position]))) score += 2;
  });
  // A name that contains the query as typed beats a scattered match.
  if (path.slice(nameStart).toLowerCase().includes(needle)) score += needle.length * 2;
  // Shorter paths win ties.
  score -= path.length / 1000;

  return { score, positions };
}

export interface RankedFile extends FuzzyMatch {
  path: string;
}

/** The best `limit` matches for `query`, best first. */
export function rankFiles(paths: string[], query: string, limit = 50): RankedFile[] {
  const ranked: RankedFile[] = [];
  for (const path of paths) {
    const match = fuzzyMatch(query, path);
    if (match) ranked.push({ path, ...match });
  }

  return ranked.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** `page.tsx:42` → the file part and line 42; `:42` alone means a line in the open file. */
export function parseQuickOpen(input: string): { query: string; line?: number } {
  const match = /^(.*?):(\d+)(?::\d+)?\s*$/.exec(input);
  if (!match) return { query: input.trim() };

  return { query: match[1].trim(), line: Number(match[2]) };
}
