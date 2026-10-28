import { useEffect, useMemo, useRef, useState } from 'react';
import { parseQuickOpen, rankFiles } from './fuzzy';

interface QuickOpenProps {
  /** Every file of the project, absolute. */
  files: string[];
  /** Shown before typing: the open tabs, most recently used first. */
  recent: string[];
  /** Stripped from paths for display and matching. */
  root: string;
  /** `''` opens files, `':'` starts in go-to-line mode. */
  initial: '' | ':';
  /** Lines in the open file, for go-to-line; undefined when no file is open. */
  lineCount?: number;
  onOpen: (file: string, line?: number) => void;
  onGoToLine: (line: number) => void;
  onClose: () => void;
}

const MAX_RESULTS = 50;

/** Cmd/Ctrl+P and Cmd/Ctrl+G: one palette. Type to find a file (`name:42` opens it at a line), or `:42` to go to a line. */
export function QuickOpen({ files, recent, root, initial, lineCount, onOpen, onGoToLine, onClose }: QuickOpenProps): JSX.Element {
  const [value, setValue] = useState<string>(initial);
  const [selected, setSelected] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const prefix = root ? `${root}/` : '';
  const relative = (file: string): string => (file.startsWith(prefix) ? file.slice(prefix.length) : file);

  const relativeFiles = useMemo(() => files.map(relative), [files, prefix]);
  const parsed = parseQuickOpen(value);
  const lineMode = value.startsWith(':');

  const results = useMemo(() => {
    if (lineMode) return [];
    if (!parsed.query) return recent.map((file) => ({ path: relative(file), positions: [] as number[] }));

    return rankFiles(relativeFiles, parsed.query, MAX_RESULTS);
  }, [lineMode, parsed.query, recent, relativeFiles]);

  useEffect(() => setSelected(0), [parsed.query]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${selected}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const open = (index: number): void => {
    const result = results[index];
    if (!result) return;
    onOpen(prefix + result.path, parsed.line);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') onClose();
    else if (event.key === 'ArrowDown') setSelected((index) => Math.min(results.length - 1, index + 1));
    else if (event.key === 'ArrowUp') setSelected((index) => Math.max(0, index - 1));
    else if (event.key === 'Enter') {
      if (lineMode) {
        if (parsed.line && lineCount) onGoToLine(Math.min(lineCount, Math.max(1, parsed.line)));
      } else {
        open(selected);
      }
    } else return;
    event.preventDefault();
  };

  return (
    <div className="fixed inset-0 z-40 bg-black/30" onMouseDown={onClose}>
      <div className="mx-auto mt-16 w-[min(640px,calc(100%-32px))] overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl" onMouseDown={(event) => event.stopPropagation()}>
        <input
          autoFocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={lineMode ? 'Line number' : 'Search files by name (append :line to jump to a line)'}
          aria-label={lineMode ? 'Go to line' : 'Open file'}
          className="w-full border-b border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-100 placeholder:font-sans placeholder:text-zinc-500 focus:outline-none"
        />
        {lineMode ? (
          <p className="px-3 py-2 text-xs text-zinc-400">
            {!lineCount
              ? 'Open a file first.'
              : parsed.line
                ? `Go to line ${Math.min(lineCount, Math.max(1, parsed.line))} of ${lineCount}. Press Enter.`
                : `Type a line number between 1 and ${lineCount}.`}
          </p>
        ) : results.length === 0 ? (
          <p className="px-3 py-2 text-xs text-zinc-500">{parsed.query ? 'No matching files.' : `Type to search ${files.length.toLocaleString()} files. Type : and a number to go to a line.`}</p>
        ) : (
          <ul ref={list} role="listbox" className="max-h-[50vh] overflow-y-auto py-1 text-xs">
            {!parsed.query && <li className="px-3 pb-1 pt-0.5 text-[11px] uppercase tracking-wide text-zinc-500">Open files</li>}
            {results.map((result, index) => (
              <li
                key={result.path}
                data-index={index}
                role="option"
                aria-selected={index === selected}
                onMouseMove={() => setSelected(index)}
                onClick={() => open(index)}
                className={`flex cursor-pointer items-baseline gap-2 px-3 py-1 ${index === selected ? 'bg-sky-500/20' : ''}`}
              >
                <MatchedPath path={result.path} positions={result.positions} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** The file name first, then its folder, with the matched characters highlighted. */
function MatchedPath({ path, positions }: { path: string; positions: number[] }): JSX.Element {
  const nameStart = path.lastIndexOf('/') + 1;
  const marked = new Set(positions);
  const render = (from: number, to: number): JSX.Element[] =>
    [...path.slice(from, to)].map((char, offset) => (
      <span key={from + offset} className={marked.has(from + offset) ? 'font-semibold text-sky-300' : undefined}>
        {char}
      </span>
    ));

  return (
    <>
      <span className="shrink-0 font-mono text-zinc-100">{render(nameStart, path.length)}</span>
      <span className="min-w-0 truncate font-mono text-[11px] text-zinc-500">{render(0, Math.max(0, nameStart - 1))}</span>
    </>
  );
}
