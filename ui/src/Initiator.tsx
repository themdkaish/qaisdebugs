import { useEffect, useState } from 'react';
import type { StackFrame } from './events';
import { shortFile } from './format';

interface InitiatorProps {
  initiator?: StackFrame;
  frames?: StackFrame[];
  /** The app's dev-server origin, used for Next's launch-editor endpoint. */
  appOrigin?: string;
  onOpenSource?: (file: string, line: number) => void;
}

interface Snippet {
  file: string;
  relative: string;
  line: number;
  start: number;
  lines: string[];
}

export function Initiator({ initiator, frames = [], appOrigin, onOpenSource }: InitiatorProps): JSX.Element {
  const [selected, setSelected] = useState<StackFrame | undefined>(initiator);
  const [snippet, setSnippet] = useState<Snippet | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [opened, setOpened] = useState<string | undefined>();

  useEffect(() => {
    setSelected(initiator);
  }, [initiator]);

  useEffect(() => {
    if (!selected) {
      setSnippet(undefined);

      return;
    }

    let cancelled = false;
    setError(undefined);
    fetch(`/snippet?file=${encodeURIComponent(selected.file)}&line=${selected.line}`)
      .then(async (response) => {
        const body = await response.json();
        if (cancelled) return;
        if (!response.ok) {
          setSnippet(undefined);
          setError(body.error ?? `snippet failed (${response.status})`);
        } else {
          setSnippet(body);
        }
      })
      .catch((reason: Error) => {
        if (!cancelled) setError(reason.message);
      });

    return () => {
      cancelled = true;
    };
  }, [selected]);

  if (!initiator) {
    return <p className="p-3 text-xs text-zinc-500">No application frame was captured for this event.</p>;
  }

  const openInEditor = (frame: StackFrame): void => {
    if (!appOrigin) return;
    const params = new URLSearchParams({ file: frame.file, lineNumber: String(frame.line), column: String(frame.column) });
    // Next's dev server answers without CORS headers; an opaque response is enough, the editor opens.
    void fetch(`${appOrigin}/__nextjs_launch-editor?${params}`, { mode: 'no-cors' }).catch(() => undefined);
    setOpened(`${frame.file}:${frame.line}`);
    window.setTimeout(() => setOpened(undefined), 1500);
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-zinc-500">Initiator</span>
        <code className="font-mono text-zinc-200">
          {shortFile(initiator.file)}:{initiator.line}:{initiator.column}
        </code>
        {initiator.fn && <span className="text-zinc-500">in {initiator.fn}</span>}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-3">
        <ol className="min-h-0 overflow-auto rounded border border-zinc-800">
          {frames.map((frame, index) => {
            const active = selected === frame || (selected && selected.file === frame.file && selected.line === frame.line);

            return (
              <li key={`${frame.file}:${frame.line}:${index}`}>
                <button
                  type="button"
                  onClick={() => setSelected(frame)}
                  className={`block w-full px-2 py-1 text-left font-mono ${active ? 'bg-sky-500/15 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800/60'}`}
                  title={frame.file}
                >
                  <span className="text-zinc-500">{frame.fn ?? '(anonymous)'}</span>
                  <br />
                  {shortFile(frame.file)}:{frame.line}
                </button>
              </li>
            );
          })}
        </ol>

        <div className="flex min-h-0 flex-col rounded border border-zinc-800">
          <div className="flex items-center justify-between gap-2 border-b border-zinc-800 px-2 py-1">
            <code className="truncate font-mono text-zinc-400" title={selected?.file}>
              {snippet?.relative ?? (selected ? shortFile(selected.file) : '')}
            </code>
            <div className="flex shrink-0 items-center gap-2">
              {selected && onOpenSource && (
                <button
                  type="button"
                  onClick={() => onOpenSource(selected.file, selected.line)}
                  className="rounded border border-violet-700 bg-violet-500/15 px-2 py-0.5 text-violet-200 hover:bg-violet-500/25"
                  title="Show the file in the Sources view, where you can set breakpoints"
                >
                  Open in Sources
                </button>
              )}
              {selected && (
                <button
                  type="button"
                  onClick={() => void navigator.clipboard.writeText(`${selected.file}:${selected.line}:${selected.column}`)}
                  className="rounded border border-zinc-700 px-2 py-0.5 text-zinc-300 hover:bg-zinc-800"
                >
                  Copy path
                </button>
              )}
              {selected && (
                <button
                  type="button"
                  disabled={!appOrigin}
                  onClick={() => openInEditor(selected)}
                  title={appOrigin ? `${appOrigin}/__nextjs_launch-editor` : 'The dev server origin is unknown for this event'}
                  className="rounded border border-sky-700 bg-sky-500/15 px-2 py-0.5 text-sky-200 hover:bg-sky-500/25 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {opened ? 'Sent to editor' : 'Open in editor'}
                </button>
              )}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {error && <p className="p-2 text-amber-300">{error}</p>}
            {snippet && (
              <pre className="font-mono text-[11px] leading-5">
                {snippet.lines.map((text, index) => {
                  const number = snippet.start + index;
                  const highlight = number === snippet.line;

                  return (
                    <div key={number} className={`flex ${highlight ? 'bg-amber-500/15' : ''}`}>
                      <span className={`w-12 shrink-0 select-none pr-2 text-right ${highlight ? 'text-amber-300' : 'text-zinc-600'}`}>{number}</span>
                      <code className="whitespace-pre text-zinc-200">{text}</code>
                    </div>
                  );
                })}
              </pre>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
