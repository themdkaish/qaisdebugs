import { useMemo, useState } from 'react';
import { AppChip, ORIGIN_LABEL, OriginChip, StatusText } from './Chips';
import { Initiator } from './Initiator';
import { JsonView } from './JsonView';
import type { RequestEvent } from './events';
import { formatBytes, formatDuration, formatTime, parseJson, responseSize } from './format';

interface RequestDetailProps {
  event: RequestEvent;
  /** Every request in the same trace, for the Trace tab. */
  trace: RequestEvent[];
  appOrigin?: string;
  onSelect: (id: string) => void;
  onClose: () => void;
  onOpenSource?: (file: string, line: number) => void;
}

type Tab = 'headers' | 'request' | 'response' | 'initiator' | 'trace';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'headers', label: 'Headers' },
  { id: 'request', label: 'Request' },
  { id: 'response', label: 'Response' },
  { id: 'initiator', label: 'Initiator' },
  { id: 'trace', label: 'Trace' },
];

export function RequestDetail({ event, trace, appOrigin, onSelect, onClose, onOpenSource }: RequestDetailProps): JSX.Element {
  const [tab, setTab] = useState<Tab>('headers');

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-zinc-800 px-3 py-2">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-mono font-semibold text-zinc-200">{event.method}</span>
              <StatusText event={event} />
              <AppChip app={event.app} />
              <OriginChip origin={event.origin} />
              <span className="text-zinc-500">{ORIGIN_LABEL[event.origin]}</span>
              <span className="text-zinc-500">· {formatTime(event.startedAt)}</span>
              <span className="text-zinc-500">· {formatDuration(event.durationMs)}</span>
              <span className="text-zinc-500">· {formatBytes(responseSize(event))}</span>
            </div>
            <UrlLine label="URL" url={event.url} highlight={event.origin === 'external'} />
            {event.error && <p className="mt-1 font-mono text-xs text-red-300">{event.error}</p>}
          </div>
          <button type="button" onClick={onClose} className="rounded px-2 py-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" title="Close">
            ✕
          </button>
        </div>
      </header>

      <nav className="flex gap-1 border-b border-zinc-800 px-2">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`border-b-2 px-2 py-1.5 text-xs ${tab === id ? 'border-sky-400 text-zinc-100' : 'border-transparent text-zinc-500 hover:text-zinc-300'}`}
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-auto">
        {tab === 'headers' && (
          <div className="space-y-4 p-3">
            <HeaderTable title="Request headers" headers={event.reqHeaders} />
            <HeaderTable title="Response headers" headers={event.resHeaders} />
          </div>
        )}
        {tab === 'request' && <Body text={event.reqBody} contentType={event.reqHeaders['content-type']} empty="No request body." />}
        {tab === 'response' && (
          <Body
            text={event.resBody}
            contentType={event.contentType}
            truncated={event.resBodyTruncated}
            skipped={event.resBodySkipped}
            empty="No response body was captured."
          />
        )}
        {tab === 'initiator' && <Initiator initiator={event.initiator} frames={event.frames} appOrigin={appOrigin} onOpenSource={onOpenSource} />}
        {tab === 'trace' && <TraceTree current={event} trace={trace} onSelect={onSelect} />}
      </div>
    </div>
  );
}

function UrlLine({ label, url, highlight }: { label: string; url: string; highlight?: boolean }): JSX.Element {
  return (
    <div className="mt-1 flex items-baseline gap-2 text-xs">
      <span className="w-24 shrink-0 text-zinc-500">{label}</span>
      <code className={`min-w-0 flex-1 break-all font-mono ${highlight ? 'text-amber-200' : 'text-zinc-200'}`}>{url}</code>
      <button
        type="button"
        onClick={() => void navigator.clipboard.writeText(url)}
        className="shrink-0 rounded border border-zinc-700 px-1.5 text-[11px] text-zinc-400 hover:bg-zinc-800"
      >
        copy
      </button>
    </div>
  );
}

function HeaderTable({ title, headers }: { title: string; headers: Record<string, string> }): JSX.Element {
  const entries = Object.entries(headers).sort(([a], [b]) => a.localeCompare(b));

  return (
    <section>
      <h3 className="mb-1 text-[11px] uppercase tracking-wide text-zinc-500">
        {title} <span className="text-zinc-600">({entries.length})</span>
      </h3>
      {entries.length === 0 ? (
        <p className="text-xs text-zinc-500">None.</p>
      ) : (
        <table className="w-full text-xs">
          <tbody>
            {entries.map(([name, value]) => (
              <tr key={name} className="align-top">
                <td className="w-56 py-0.5 pr-3 font-mono text-sky-300">{name}</td>
                <td className={`break-all py-0.5 font-mono ${value === '[redacted]' ? 'italic text-zinc-500' : 'text-zinc-200'}`}>{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Body({
  text,
  contentType,
  truncated,
  skipped,
  empty,
}: {
  text?: string;
  contentType?: string;
  truncated?: boolean;
  skipped?: string;
  empty: string;
}): JSX.Element {
  const [raw, setRaw] = useState(false);
  const json = useMemo(() => (truncated ? undefined : parseJson(text)), [text, truncated]);

  if (!text) {
    return (
      <p className="p-3 text-xs text-zinc-500">
        {empty}
        {skipped && <span className="ml-1 text-zinc-600">({skipped})</span>}
      </p>
    );
  }

  return (
    <div className="p-3">
      <div className="mb-2 flex items-center gap-2 text-[11px] text-zinc-500">
        <span>{contentType ?? 'unknown content type'}</span>
        <span>· {formatBytes(new Blob([text]).size)}</span>
        {truncated && <span className="text-amber-300">· truncated at 256 KB</span>}
        {json !== undefined && (
          <button type="button" onClick={() => setRaw((current) => !current)} className="ml-auto rounded border border-zinc-700 px-1.5 text-zinc-300 hover:bg-zinc-800">
            {raw ? 'Tree' : 'Raw'}
          </button>
        )}
        <button
          type="button"
          onClick={() => void navigator.clipboard.writeText(text)}
          className={`rounded border border-zinc-700 px-1.5 text-zinc-300 hover:bg-zinc-800 ${json === undefined ? 'ml-auto' : ''}`}
        >
          Copy
        </button>
      </div>
      {json !== undefined && !raw ? (
        <JsonView value={json} expandDepth={3} />
      ) : (
        <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-5 text-zinc-200">{json !== undefined ? JSON.stringify(json, null, 2) : text}</pre>
      )}
    </div>
  );
}

interface TraceNode {
  event: RequestEvent;
  children: TraceNode[];
}

function TraceTree({ current, trace, onSelect }: { current: RequestEvent; trace: RequestEvent[]; onSelect: (id: string) => void }): JSX.Element {
  const roots = useMemo(() => buildTree(trace), [trace]);
  const first = trace[0]?.startedAt ?? current.startedAt;
  const span = Math.max(1, ...trace.map((event) => event.startedAt + event.durationMs - first));

  if (!current.traceId) {
    return <p className="p-3 text-xs text-zinc-500">This request carries no trace id, so it cannot be placed in a page load.</p>;
  }

  return (
    <div className="p-3 text-xs">
      <p className="mb-2 text-zinc-500">
        Page <code className="font-mono text-zinc-300">{current.pagePath ?? '?'}</code> · trace <code className="font-mono text-zinc-400">{current.traceId}</code> ·{' '}
        {trace.length} hops
      </p>
      <ol>
        {roots.map((node) => (
          <TraceRow key={node.event.id} node={node} depth={0} currentId={current.id} first={first} span={span} onSelect={onSelect} />
        ))}
      </ol>
    </div>
  );
}

function TraceRow({
  node,
  depth,
  currentId,
  first,
  span,
  onSelect,
}: {
  node: TraceNode;
  depth: number;
  currentId: string;
  first: number;
  span: number;
  onSelect: (id: string) => void;
}): JSX.Element {
  const { event } = node;
  const left = ((event.startedAt - first) / span) * 100;
  const width = Math.max(0.5, (event.durationMs / span) * 100);

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(event.id)}
        className={`grid w-full grid-cols-[minmax(0,1fr)_160px] items-center gap-2 rounded px-1 py-0.5 text-left ${event.id === currentId ? 'bg-sky-500/15' : 'hover:bg-zinc-800/60'}`}
      >
        <span className="flex min-w-0 items-center gap-2" style={{ paddingInlineStart: depth * 16 }}>
          <OriginChip origin={event.origin} />
          <span className="font-mono text-zinc-300">{event.method}</span>
          <StatusText event={event} />
          <span className="truncate font-mono text-zinc-400" title={event.url}>
            {pathOf(event.url)}
          </span>
        </span>
        <span className="relative h-3 rounded bg-zinc-800" title={formatDuration(event.durationMs)}>
          <span className="absolute inset-y-0 rounded bg-sky-500/60" style={{ left: `${left}%`, width: `${width}%` }} />
        </span>
      </button>
      {node.children.length > 0 && (
        <ol>
          {node.children.map((child) => (
            <TraceRow key={child.event.id} node={child} depth={depth + 1} currentId={currentId} first={first} span={span} onSelect={onSelect} />
          ))}
        </ol>
      )}
    </li>
  );
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function buildTree(events: RequestEvent[]): TraceNode[] {
  const nodes = new Map<string, TraceNode>();
  for (const event of events) nodes.set(event.id, { event, children: [] });

  const roots: TraceNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.event.parentId ? nodes.get(node.event.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const byStart = (a: TraceNode, b: TraceNode): number => a.event.startedAt - b.event.startedAt;
  const sortDeep = (list: TraceNode[]): void => {
    list.sort(byStart);
    list.forEach((node) => sortDeep(node.children));
  };
  sortDeep(roots);

  return roots;
}
