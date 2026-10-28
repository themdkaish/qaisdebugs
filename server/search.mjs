/**
 * QaisDebugs — search across a project's source files, for the inspector's Cmd/Ctrl+Shift+F.
 * Reads the same files the Sources tree lists, line by line, and stops at a result limit.
 */

/** Characters of a matching line sent back on each side of the match. */
const CONTEXT = 80;

/** The pattern for a query; throws on an invalid regular expression. */
export function searchPattern(query, { matchCase = false, regex = false, wholeWord = false } = {}) {
  let source = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (wholeWord) source = `\\b(?:${source})\\b`;

  return new RegExp(source, matchCase ? 'g' : 'gi');
}

/** The matching lines of one file: 1-based line, 0-based column, match length and the line around it. */
export function searchContent(content, pattern, limit) {
  const matches = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length && matches.length < limit; index += 1) {
    const text = lines[index];
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    // One result per line, like an IDE's search list; an empty match finds nothing.
    if (!match || match[0].length === 0) continue;
    const from = Math.max(0, match.index - CONTEXT);
    matches.push({
      line: index + 1,
      column: match.index,
      length: match[0].length,
      text: text.slice(from, match.index + match[0].length + CONTEXT),
      offset: match.index - from,
    });
  }

  return matches;
}

/**
 * Searches `files` (absolute paths) with `readFile(path) → Promise<string | undefined>`, a few at a
 * time. Returns the files with matches in the order given, and whether the limit cut the search short.
 */
export async function searchFiles(files, pattern, readFile, { maxResults = 500, concurrency = 24 } = {}) {
  const found = new Array(files.length);
  let total = 0;
  let next = 0;
  let searched = 0;

  async function worker() {
    while (next < files.length && total < maxResults) {
      const index = next++;
      const content = await readFile(files[index]);
      searched += 1;
      if (content === undefined || total >= maxResults) continue;
      const matches = searchContent(content, new RegExp(pattern.source, pattern.flags), maxResults - total);
      if (matches.length === 0) continue;
      total += matches.length;
      found[index] = { file: files[index], matches };
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));

  return { results: found.filter(Boolean), total, searched, truncated: total >= maxResults };
}
