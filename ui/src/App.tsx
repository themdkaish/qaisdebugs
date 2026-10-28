import { useEffect, useMemo, useState } from 'react';
import { LogsView } from './LogsView';
import { NetworkList } from './NetworkList';
import { RequestDetail } from './RequestDetail';
import { type SourceLocation, SourcesView } from './sources/SourcesView';
import type { ErrorEvent, LogEvent, RequestEvent, RequestOrigin } from './events';
import { argsToText, originOf, statusTone } from './format';
import { useEvents } from './useEvents';

type View = 'network' | 'logs' | 'sources';
type StatusFilter = 'all' | '2xx' | '3xx' | '4xx' | '5xx' | 'error';

const ORIGINS: RequestOrigin[] = ['page', 'browser', 'server', 'external', 'other'];
const DEFAULT_ORIGINS: RequestOrigin[] = ['page', 'browser', 'server', 'external'];
const STATUS_FILTERS: StatusFilter[] = ['all', '2xx', '3xx', '4xx', '5xx', 'error'];

export function App(): JSX.Element {
  const feed = useEvents();
  const [brand, setBrand] = useState('qaisdebugs');
  // The collector knows which command name started it (qaisdebugs, or a personal one).
  useEffect(() => {
    void fetch('/health')
      .then((response) => response.json() as Promise<{ brand?: string }>)
      .then((health) => {
        if (!health.brand) return;
        setBrand(health.brand);
        document.title = health.brand;
      })
      .catch(() => undefined);
  }, []);
  const [view, setView] = useState<View>('network');
  const [app, setApp] = useState<string>('all');
  const [origins, setOrigins] = useState<Set<RequestOrigin>>(new Set(DEFAULT_ORIGINS));
  const [status, setStatus] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [requestedSource, setRequestedSource] = useState<(SourceLocation & { nonce: number }) | undefined>();

  const openSource = (file: string, line?: number): void => {
    setRequestedSource({ file, line, nonce: Date.now() });
    setView('sources');
  };

  // Events arrive when their body has been read, so a server-component hop lands after the proxy hop it
  // triggered. Order by when each hop started instead.
  const requests = useMemo(
    () => feed.events.filter((event): event is RequestEvent => event.kind === 'request').sort((a, b) => a.startedAt - b.startedAt),
    [feed.events]
  );
  const logs = useMemo(
    () => feed.events.filter((event): event is LogEvent | ErrorEvent => event.kind === 'log' || event.kind === 'error').sort((a, b) => a.at - b.at),
    [feed.events]
  );

  /** Every app that has reported anything, for the filter. */
  const apps = useMemo(() => [...new Set([...feed.events.map((event) => event.app), ...feed.agents.map((agent) => agent.app)])].sort(), [feed.events, feed.agents]);

  /** Each app's dev-server origin, learned from the URLs of the requests it received or made to itself. */
  const appOrigins = useMemo(() => {
    const map = new Map<string, string>();
    for (const event of requests) {
      if (map.has(event.app) || (event.origin !== 'server' && event.origin !== 'page' && event.origin !== 'browser')) continue;
      const origin = originOf(event.url);
      if (origin && /localhost|127\.0\.0\.1/.test(origin)) map.set(event.app, origin);
    }

    return map;
  }, [requests]);

  const needle = search.trim().toLowerCase();

  const visibleRequests = useMemo(
    () =>
      requests.filter((event) => {
        if (app !== 'all' && event.app !== app) return false;
        if (!origins.has(event.origin)) return false;
        if (status !== 'all') {
          const tone = statusTone(event);
          const wanted =
            status === 'error' ? tone === 'error' : status === '2xx' ? tone === 'ok' : status === '3xx' ? tone === 'redirect' : status === '4xx' ? tone === 'client' : tone === 'server';
          if (!wanted) return false;
        }
        if (needle) {
          const haystack = `${event.url} ${event.traceId ?? ''} ${event.pagePath ?? ''} ${event.method} ${event.status ?? ''} ${event.initiator?.file ?? ''}`.toLowerCase();
          if (!haystack.includes(needle)) return false;
        }

        return true;
      }),
    [requests, app, origins, status, needle]
  );

  const visibleLogs = useMemo(
    () =>
      logs.filter((entry) => {
        if (app !== 'all' && entry.app !== app) return false;
        if (needle) {
          const text = entry.kind === 'error' ? `${entry.message} ${entry.stack ?? ''}` : argsToText(entry.args);
          const haystack = `${text} ${entry.traceId ?? ''} ${entry.pagePath ?? ''} ${entry.kind === 'log' ? entry.initiator?.file ?? '' : ''}`.toLowerCase();
          if (!haystack.includes(needle)) return false;
        }

        return true;
      }),
    [logs, app, needle]
  );

  const selected = useMemo(() => requests.find((event) => event.id === selectedId), [requests, selectedId]);
  const selectedTrace = useMemo(
    () => (selected?.traceId ? requests.filter((event) => event.traceId === selected.traceId) : selected ? [selected] : []),
    [requests, selected]
  );

  useEffect(() => {
    if (selectedId && !selected) setSelectedId(undefined);
  }, [selectedId, selected]);

  const toggleOrigin = (origin: RequestOrigin): void => {
    setOrigins((current) => {
      const next = new Set(current);
      if (next.has(origin)) next.delete(origin);
      else next.add(origin);

      return next;
    });
  };

  const showTrace = (traceId: string): void => {
    setSearch(traceId);
    setView('network');
  };

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-3 border-b border-zinc-800 bg-zinc-900 px-3 py-2">
        <h1 className="text-sm font-semibold text-zinc-100">{brand}</h1>
        <span className={`inline-flex items-center gap-1 text-[11px] ${feed.connected ? 'text-emerald-300' : 'text-red-300'}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${feed.connected ? 'bg-emerald-400' : 'bg-red-400'}`} />
          {feed.connected ? 'live' : 'collector unreachable'}
        </span>
        <nav className="ml-4 flex rounded border border-zinc-700 text-xs">
          {(['network', 'logs', 'sources'] as View[]).map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setView(id)}
              className={`px-3 py-1 capitalize ${view === id ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'}`}
            >
              {id}{' '}
              <span className="text-zinc-500">{id === 'network' ? visibleRequests.length : id === 'logs' ? visibleLogs.length : feed.agents.length ? `${feed.agents.length} target${feed.agents.length === 1 ? '' : 's'}` : ''}</span>
            </button>
          ))}
        </nav>
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Filter by URL, trace id, page, file, status…"
          className="ml-2 w-80 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none"
        />
        <div className="ml-auto flex items-center gap-2 text-xs">
          <button
            type="button"
            onClick={feed.togglePause}
            className={`rounded border px-2 py-1 ${feed.paused ? 'border-amber-600 bg-amber-500/15 text-amber-200' : 'border-zinc-700 text-zinc-300 hover:bg-zinc-800'}`}
          >
            {feed.paused ? `Resume (${feed.pendingWhilePaused} queued)` : 'Pause'}
          </button>
          <button type="button" onClick={() => void feed.clear()} className="rounded border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-800">
            Clear
          </button>
        </div>
      </header>

      <div className={`flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-[11px] ${view === 'sources' ? 'hidden' : ''}`}>
        <FilterGroup label="App">
          <Toggle active={app === 'all'} onClick={() => setApp('all')}>
            all
          </Toggle>
          {apps.map((id) => (
            <Toggle key={id} active={app === id} onClick={() => setApp(id)}>
              {id}
            </Toggle>
          ))}
        </FilterGroup>
        {view === 'network' && (
          <>
            <FilterGroup label="Origin">
              {ORIGINS.map((id) => (
                <Toggle key={id} active={origins.has(id)} onClick={() => toggleOrigin(id)}>
                  {id}
                </Toggle>
              ))}
            </FilterGroup>
            <FilterGroup label="Status">
              {STATUS_FILTERS.map((id) => (
                <Toggle key={id} active={status === id} onClick={() => setStatus(id)}>
                  {id}
                </Toggle>
              ))}
            </FilterGroup>
          </>
        )}
      </div>

      <main className="min-h-0 flex-1">
        {/* The Sources view stays mounted so a debugger session survives switching views. */}
        <div className={view === 'sources' ? 'h-full' : 'hidden'}>
          <SourcesView agents={feed.agents} requested={requestedSource} visible={view === 'sources'} onPaused={() => setView('sources')} onShow={() => setView('sources')} />
        </div>
        {view === 'logs' && <LogsView entries={visibleLogs} onTrace={showTrace} onOpenSource={openSource} />}
        {view === 'network' && (
          <div className={`grid h-full min-h-0 ${selected ? 'grid-rows-[minmax(0,2fr)_minmax(0,3fr)] lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:grid-rows-1' : 'grid-cols-1'}`}>
            <div className="min-h-0 border-b border-zinc-800 lg:border-b-0 lg:border-r">
              <NetworkList requests={visibleRequests} selectedId={selectedId} onSelect={setSelectedId} />
            </div>
            {selected && (
              <RequestDetail
                event={selected}
                trace={selectedTrace}
                appOrigin={appOrigins.get(selected.app)}
                onSelect={setSelectedId}
                onClose={() => setSelectedId(undefined)}
                onOpenSource={openSource}
              />
            )}
          </div>
        )}
      </main>
    </div>
  );
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex items-center gap-1">
      <span className="mr-1 uppercase tracking-wide text-zinc-500">{label}</span>
      {children}
    </div>
  );
}

function Toggle({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-1.5 py-0.5 ${active ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300'}`}
    >
      {children}
    </button>
  );
}
