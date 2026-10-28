import type { RefObject } from 'react';
import type { FindOptions } from './find';

interface FindBarProps {
  inputRef: RefObject<HTMLInputElement>;
  query: string;
  options: FindOptions;
  count: number;
  /** 0-based index of the current match. */
  index: number;
  /** An invalid regular expression. */
  error?: string;
  onQuery: (query: string) => void;
  onOptions: (options: FindOptions) => void;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
}

/** Cmd/Ctrl+F: find in the open file. Enter goes to the next match, Shift+Enter to the previous, Esc closes. */
export function FindBar({ inputRef, query, options, count, index, error, onQuery, onOptions, onNext, onPrevious, onClose }: FindBarProps): JSX.Element {
  const status = error ? 'Invalid pattern' : !query ? '' : count === 0 ? 'No results' : `${index + 1} of ${count.toLocaleString()}`;

  return (
    <div className="absolute right-4 top-1 z-20 flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-900 p-1 text-xs shadow-xl" role="search">
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') (event.shiftKey ? onPrevious : onNext)();
          else if (event.key === 'Escape') onClose();
          else return;
          event.preventDefault();
        }}
        placeholder="Find in file"
        aria-label="Find in file"
        title={error}
        className={`w-56 rounded border bg-zinc-950 px-2 py-0.5 font-mono text-zinc-100 placeholder:font-sans placeholder:text-zinc-600 focus:outline-none ${error ? 'border-red-500' : 'border-zinc-700 focus:border-sky-500'}`}
      />
      <Toggle on={options.matchCase} label="Match case" onClick={() => onOptions({ ...options, matchCase: !options.matchCase })}>
        Aa
      </Toggle>
      <Toggle on={options.regex} label="Use regular expression" onClick={() => onOptions({ ...options, regex: !options.regex })}>
        .*
      </Toggle>
      <span className={`w-20 text-center tabular-nums ${count === 0 && query ? 'text-amber-300' : 'text-zinc-400'}`}>{status}</span>
      <IconButton label="Previous match (Shift+Enter)" disabled={count === 0} onClick={onPrevious}>
        ↑
      </IconButton>
      <IconButton label="Next match (Enter)" disabled={count === 0} onClick={onNext}>
        ↓
      </IconButton>
      <IconButton label="Close (Esc)" onClick={onClose}>
        ×
      </IconButton>
    </div>
  );
}

export function Toggle({ on, label, onClick, children }: { on: boolean; label: string; onClick: () => void; children: string }): JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={on}
      title={label}
      aria-label={label}
      onClick={onClick}
      className={`rounded px-1.5 py-0.5 font-mono text-[11px] ${on ? 'bg-sky-500/30 text-sky-100 ring-1 ring-sky-500/60' : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'}`}
    >
      {children}
    </button>
  );
}

function IconButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: string }): JSX.Element {
  return (
    <button type="button" title={label} aria-label={label} disabled={disabled} onClick={onClick} className="grid h-5 w-5 place-items-center rounded text-zinc-300 hover:bg-zinc-800 disabled:text-zinc-600 disabled:hover:bg-transparent">
      {children}
    </button>
  );
}
