import { useEffect, useRef, useState } from 'react';
import { AppChip, LevelChip } from './Chips';
import { JsonView } from './JsonView';
import type { ErrorEvent, LogEvent } from './events';
import { formatTime, shortFile } from './format';

interface LogsViewProps {
  entries: Array<LogEvent | ErrorEvent>;
  onTrace: (traceId: string) => void;
  onOpenSource?: (file: string, line: number) => void;
}

const MAX_ROWS = 2000;
const LONG_MESSAGE_CHARS = 400;
const LONG_MESSAGE_LINES = 4;

/** The first lines of a long message, so a React warning with a 60-frame stack stays one row tall. */
function clip(text: string): string {
  const lines = text.split('\n').slice(0, LONG_MESSAGE_LINES).join('\n');

  return lines.length > LONG_MESSAGE_CHARS ? `${lines.slice(0, LONG_MESSAGE_CHARS)}…` : `${lines}…`;
}

export function LogsView({ entries, onTrace, onOpenSource }: LogsViewProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const rows = entries.length > MAX_ROWS ? entries.slice(entries.length - MAX_ROWS) : entries;

  useEffect(() => {
    const element = scrollRef.current;
    if (element && stickToBottom.current) element.scrollTop = element.scrollHeight;
  }, [rows.length]);

  const onScroll = (): void => {
    const element = scrollRef.current;
    if (element) stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
  };

  return (
    <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-auto">
      {rows.length === 0 && <p className="px-4 py-10 text-center text-xs text-zinc-500">No log lines yet.</p>}
      <ol>
        {rows.map((entry) => (
          <LogRow key={entry.id} entry={entry} onTrace={onTrace} onOpenSource={onOpenSource} />
        ))}
      </ol>
    </div>
  );
}

function LogRow({ entry, onTrace, onOpenSource }: { entry: LogEvent | ErrorEvent; onTrace: (traceId: string) => void; onOpenSource?: (file: string, line: number) => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const isError = entry.kind === 'error';
  const level = isError ? 'error!' : entry.level;
  const tone = isError || level === 'error' ? 'bg-red-500/5' : level === 'warn' ? 'bg-amber-500/5' : '';
  const initiator = isError ? undefined : entry.initiator;
  const inline = isError ? [entry.message] : entry.args;
  const hasStructure = isError ? Boolean(entry.stack || entry.context) : entry.args.some((arg) => arg !== null && typeof arg === 'object');
  const text = inline.map((arg) => (typeof arg === 'string' ? arg : arg !== null && typeof arg === 'object' ? summarise(arg) : String(arg))).join(' ');
  const long = text.length > LONG_MESSAGE_CHARS || text.split('\n').length > LONG_MESSAGE_LINES;
  const shown = open || !long ? text : clip(text);

  return (
    <li className={`border-b border-zinc-800/60 px-2 py-1 text-xs ${tone}`}>
      <div className="flex items-start gap-2">
        <span className="mt-0.5 w-[92px] shrink-0 font-mono text-zinc-500">{formatTime(entry.at)}</span>
        <span className="mt-0.5 shrink-0">
          <AppChip app={entry.app} />
        </span>
        <span className="mt-0.5 w-[58px] shrink-0">
          <LevelChip level={level} />
        </span>
        <span className="mt-0.5 w-[52px] shrink-0 text-[11px] text-zinc-500">{entry.origin}</span>
        <div className="min-w-0 flex-1">
          <button type="button" onClick={() => (hasStructure || long) && setOpen((current) => !current)} className="block w-full text-left">
            <span className="whitespace-pre-wrap break-words font-mono text-zinc-200">{shown}</span>
            {long && <span className="ml-2 text-[11px] text-sky-300">{open ? 'show less' : 'show more'}</span>}
          </button>
          {open && (
            <div className="mt-1 rounded border border-zinc-800 bg-zinc-900/60 p-2">
              {isError ? (
                <>
                  {entry.stack && <pre className="whitespace-pre-wrap font-mono text-[11px] leading-5 text-zinc-400">{entry.stack}</pre>}
                  {entry.context !== undefined && <JsonView value={entry.context} name="context" />}
                </>
              ) : (
                entry.args.map((arg, index) =>
                  arg !== null && typeof arg === 'object' ? <JsonView key={index} value={arg} name={`arg ${index}`} /> : null
                )
              )}
            </div>
          )}
          <div className="mt-0.5 flex flex-wrap gap-3 text-[11px] text-zinc-500">
            {initiator && (
              <button type="button" onClick={() => onOpenSource?.(initiator.file, initiator.line)} className="font-mono hover:text-sky-300" title={`${initiator.file} — open in Sources`}>
                {shortFile(initiator.file)}:{initiator.line}
              </button>
            )}
            {entry.traceId && (
              <button type="button" onClick={() => onTrace(entry.traceId!)} className="font-mono hover:text-sky-300" title="Show this page load's requests">
                trace {entry.traceId.slice(0, 8)}
              </button>
            )}
            {entry.pagePath && <span className="font-mono">{entry.pagePath}</span>}
          </div>
        </div>
      </div>
    </li>
  );
}

function summarise(value: object): string {
  if (Array.isArray(value)) return `Array(${value.length})`;
  const record = value as Record<string, unknown>;
  if (typeof record.message === 'string' && typeof record.name === 'string') return `${record.name}: ${record.message}`;
  const text = JSON.stringify(value);

  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}
