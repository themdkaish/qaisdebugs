/** Find in the open file. */

export interface FindOptions {
  matchCase: boolean;
  regex: boolean;
}

export interface FindMatch {
  /** 1-based line. */
  line: number;
  /** 0-based columns, end exclusive. */
  start: number;
  end: number;
}

/** Stops a file full of single-letter matches from freezing the page. */
export const MAX_FIND_MATCHES = 5000;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The pattern for a query, or an error message when `regex` is on and the query is not a valid one. */
export function findPattern(query: string, options: FindOptions): RegExp | string | undefined {
  if (!query) return undefined;
  try {
    return new RegExp(options.regex ? query : escapeRegExp(query), options.matchCase ? 'g' : 'gi');
  } catch (reason) {
    return reason instanceof Error ? reason.message : String(reason);
  }
}

export function findMatches(lines: string[], pattern: RegExp): FindMatch[] {
  const matches: FindMatch[] = [];
  for (let index = 0; index < lines.length && matches.length < MAX_FIND_MATCHES; index += 1) {
    pattern.lastIndex = 0;
    for (const match of lines[index].matchAll(pattern)) {
      // An empty match (`^`, `a*`) highlights nothing; skip it.
      if (match[0].length === 0) continue;
      const start = match.index ?? 0;
      matches.push({ line: index + 1, start, end: start + match[0].length });
      if (matches.length >= MAX_FIND_MATCHES) break;
    }
  }

  return matches;
}

/** The first match at or after `line`, so a new search starts where you are looking. */
export function firstMatchFrom(matches: FindMatch[], line: number | undefined): number {
  if (!line) return 0;
  const index = matches.findIndex((match) => match.line >= line);

  return index >= 0 ? index : 0;
}
