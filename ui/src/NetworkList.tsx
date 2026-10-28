import { useEffect, useRef } from 'react';
import { AppChip, OriginChip, StatusText } from './Chips';
import type { RequestEvent } from './events';
import { displayPath, formatBytes, formatDuration, formatTime, responseSize } from './format';

interface NetworkListProps {
  requests: RequestEvent[];
  selectedId?: string;
  onSelect: (id: string) => void;
}

const MAX_ROWS = 2000;

export function NetworkList({ requests, selectedId, onSelect }: NetworkListProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const rows = requests.length > MAX_ROWS ? requests.slice(requests.length - MAX_ROWS) : requests;

  useEffect(() => {
    const element = scrollRef.current;
    if (element && stickToBottom.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [rows.length]);

  const onScroll = (): void => {
    const element = scrollRef.current;
    if (!element) return;
    stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
  };

  return (
    <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-auto">
      <table className="w-full table-fixed border-collapse text-xs">
        <thead className="sticky top-0 z-10 bg-zinc-900 text-[11px] uppercase tracking-wide text-zinc-500">
          <tr className="border-b border-zinc-800">
            <th className="w-[92px] px-2 py-1.5 text-left font-medium">Time</th>
            <th className="w-[120px] px-2 py-1.5 text-left font-medium">App</th>
            <th className="w-[72px] px-2 py-1.5 text-left font-medium">Origin</th>
            <th className="w-[58px] px-2 py-1.5 text-left font-medium">Method</th>
            <th className="w-[48px] px-2 py-1.5 text-left font-medium">Status</th>
            <th className="px-2 py-1.5 text-left font-medium">Path</th>
            <th className="w-[72px] px-2 py-1.5 text-right font-medium">Time</th>
            <th className="w-[72px] px-2 py-1.5 text-right font-medium">Size</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={8} className="px-4 py-10 text-center text-zinc-500">
                No requests yet. Run <code className="text-zinc-300">npx qaisdebugs dev</code> in your Next.js app and load a page.
              </td>
            </tr>
          )}
          {rows.map((event) => {
            const selected = event.id === selectedId;
            const path = displayPath(event.url);

            return (
              <tr
                key={event.id}
                onClick={() => onSelect(event.id)}
                className={`cursor-pointer border-b border-zinc-800/60 ${selected ? 'bg-sky-500/15' : 'hover:bg-zinc-800/50'}`}
              >
                <td className="px-2 py-1 font-mono text-zinc-500">{formatTime(event.startedAt)}</td>
                <td className="px-2 py-1">
                  <AppChip app={event.app} />
                </td>
                <td className="px-2 py-1">
                  <OriginChip origin={event.origin} />
                </td>
                <td className="px-2 py-1 font-mono font-semibold text-zinc-300">{event.method}</td>
                <td className="px-2 py-1">
                  <StatusText event={event} />
                </td>
                <td className="truncate px-2 py-1 font-mono text-zinc-200" title={event.url}>
                  {path}
                </td>
                <td className="px-2 py-1 text-right font-mono text-zinc-400">{formatDuration(event.durationMs)}</td>
                <td className="px-2 py-1 text-right font-mono text-zinc-400">{formatBytes(responseSize(event))}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {requests.length > MAX_ROWS && (
        <p className="px-3 py-2 text-center text-[11px] text-zinc-500">Showing the last {MAX_ROWS} of {requests.length} requests.</p>
      )}
    </div>
  );
}
