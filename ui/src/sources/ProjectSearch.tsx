import { useEffect, useRef, useState } from 'react';
import { Toggle } from './FindBar';

interface SearchMatch {
  line: number;
  column: number;
  length: number;
  text: string;
  /** Where the match starts in `text`. */
  offset: number;
}

interface SearchResponse {
  results: Array<{ file: string; relative: string; matches: SearchMatch[] }>;
  total: number;
  searched: number;
  truncated: boolean;
  error?: string;
}

export interface ProjectSearchOptions {
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
}

interface ProjectSearchProps {
  /** The project to search; undefined searches the inspector's own project. */
  root?: string;
  /** Text to search for when the panel is opened with a selection; changes with `focusNonce`. */
  seed?: string;
  /** Changes each time Cmd/Ctrl+Shift+F is pressed, to focus the input again. */
  focusNonce: number;
  onOpen: (file: string, line: number, query: string, options: ProjectSearchOptions) => void;
}

const DEBOUNCE_MS = 250;

/** Cmd/Ctrl+Shift+F: search every file of the project, results grouped by file. */
export function ProjectSearch({ root, seed, focusNonce, onOpen }: ProjectSearchProps): JSX.Element {
  const [query, setQuery] = useState(seed ?? '');
  const [options, setOptions] = useState<ProjectSearchOptions>({ matchCase: false, wholeWord: false, regex: false });
  const [response, setResponse] = useState<SearchResponse | undefined>();
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (seed) setQuery(seed);
    input.current?.focus();
    input.current?.select();
  }, [focusNonce, seed]);

  useEffect(() => {
    if (!query) {
      setResponse(undefined);
      setLoading(false);

      return;
    }
    const controller = new AbortController();
    setLoading(true);
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ q: query });
      if (root) params.set('root', root);
      if (options.matchCase) params.set('case', '1');
      if (options.wholeWord) params.set('word', '1');
      if (options.regex) params.set('regex', '1');
      fetch(`/sources/search?${params}`, { signal: controller.signal })
        .then(async (result) => {
          const payload = (await result.json()) as SearchResponse;
          setResponse(result.ok ? payload : { results: [], total: 0, searched: 0, truncated: false, error: payload.error ?? `search failed (${result.status})` });
          setCollapsed(new Set());
          setLoading(false);
        })
        .catch((reason: Error) => {
          if (reason.name === 'AbortError') return;
          setResponse({ results: [], total: 0, searched: 0, truncated: false, error: reason.message });
          setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, options, root]);

  const toggle = (file: string): void =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(file)) next.delete(file);
      else next.add(file);

      return next;
    });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="m-2 flex items-center gap-1 rounded border border-zinc-700 bg-zinc-950 pr-1 focus-within:border-sky-500">
        <input
          ref={input}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search in project…"
          aria-label="Search in project"
          className="min-w-0 flex-1 bg-transparent px-2 py-1 font-mono text-xs text-zinc-200 placeholder:font-sans placeholder:text-zinc-600 focus:outline-none"
        />
        <Toggle on={options.matchCase} label="Match case" onClick={() => setOptions({ ...options, matchCase: !options.matchCase })}>
          Aa
        </Toggle>
        <Toggle on={options.wholeWord} label="Match whole word" onClick={() => setOptions({ ...options, wholeWord: !options.wholeWord })}>
          ab
        </Toggle>
        <Toggle on={options.regex} label="Use regular expression" onClick={() => setOptions({ ...options, regex: !options.regex })}>
          .*
        </Toggle>
      </div>

      <p className="px-3 pb-1 text-[11px] text-zinc-500">
        {response?.error ? (
          <span className="text-amber-300">{response.error}</span>
        ) : loading ? (
          'Searching…'
        ) : response ? (
          `${response.total.toLocaleString()} result${response.total === 1 ? '' : 's'} in ${response.results.length.toLocaleString()} file${response.results.length === 1 ? '' : 's'}${response.truncated ? ' (first results only; narrow the search)' : ''}`
        ) : (
          'Searches every file in the Files tree.'
        )}
      </p>

      <div className="min-h-0 flex-1 overflow-auto pb-4 text-xs">
        {response?.results.map((result) => {
          const name = result.relative.split('/').at(-1) ?? result.relative;
          const folder = result.relative.slice(0, result.relative.length - name.length - 1);
          const isCollapsed = collapsed.has(result.file);

          return (
            <div key={result.file}>
              <button type="button" onClick={() => toggle(result.file)} title={result.relative} className="flex w-full items-baseline gap-1.5 px-2 py-0.5 text-left hover:bg-zinc-800/60">
                <span className="w-3 shrink-0 text-zinc-500">{isCollapsed ? '▸' : '▾'}</span>
                <span className="shrink-0 font-mono text-zinc-200">{name}</span>
                <span className="min-w-0 truncate text-[11px] text-zinc-500">{folder}</span>
                <span className="ml-auto shrink-0 rounded-full bg-zinc-800 px-1.5 text-[10px] text-zinc-300">{result.matches.length}</span>
              </button>
              {!isCollapsed &&
                result.matches.map((match) => (
                  <button
                    key={match.line}
                    type="button"
                    onClick={() => onOpen(result.file, match.line, query, options)}
                    className="flex w-full items-baseline gap-2 whitespace-pre py-0.5 pl-7 pr-2 text-left font-mono text-[11px] text-zinc-400 hover:bg-zinc-800/60"
                  >
                    <span className="w-8 shrink-0 text-right text-zinc-600">{match.line}</span>
                    <span className="min-w-0 truncate">
                      {match.text.slice(0, match.offset).trimStart()}
                      <mark className="rounded-sm bg-amber-400/30 text-amber-100">{match.text.slice(match.offset, match.offset + match.length)}</mark>
                      {match.text.slice(match.offset + match.length)}
                    </span>
                  </button>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
