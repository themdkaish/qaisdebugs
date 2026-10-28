import { useEffect, useState } from 'react';
import { AppChip } from '../Chips';
import type { PropertyDescriptor, RemoteObject } from '../debugger/remoteObject';
import { describe, isExpandable } from '../debugger/remoteObject';
import { type DebugTarget, type PageTarget, agentForPage, targetKey, targetLabel } from '../debugger/targets';
import { type DebuggerApi, isResolved } from '../debugger/useDebugger';
import type { AgentEvent } from '../events';
import { shortFile } from '../format';
import { ObjectTree } from './ObjectTree';

/** `Dashboard360/DashboardView.tsx`: the last two path segments, enough to tell files apart. */
const tailOf = (file: string): string => file.split('/').slice(-2).join('/');

/** A readable name for a frame outside application code. */
const frameWhere = (url: string): string => {
  const index = url.indexOf('/node_modules/');
  if (index >= 0) return url.slice(index + 1).replace(/^node_modules\/\.pnpm\/[^/]+\/node_modules\//, 'node_modules/');

  return url.replace(/^webpack-internal:\/\/\//, '').split('/').slice(-2).join('/') || '(native)';
};

interface DebugPanelProps {
  agents: AgentEvent[];
  pages: PageTarget[];
  chrome: { running: boolean; port: number; browser?: string; launching?: boolean; error?: string };
  onLaunchChrome: (url: string) => void;
  debuggerApi: DebuggerApi;
  onOpenFile: (file: string, line?: number) => void;
}

export function DebugPanel({ agents, pages, chrome, onLaunchChrome, debuggerApi: api, onOpenFile }: DebugPanelProps): JSX.Element {
  const targets: DebugTarget[] = [
    ...agents.map((agent): DebugTarget => ({ kind: 'server', agent })),
    ...pages.map((page): DebugTarget => ({ kind: 'page', page, agent: agentForPage(page, agents) })),
  ];
  const [expression, setExpression] = useState('');
  const [results, setResults] = useState<Array<{ expression: string; text: string; error?: boolean }>>([]);

  const sessionOf = (target: DebugTarget) => api.sessions.find((session) => session.key === targetKey(target));
  const connected = api.sessions.length > 0;
  const active = api.active;
  const pausedSessions = api.sessions.filter((session) => session.status === 'paused');
  const paused = active?.status === 'paused' ? active.paused : undefined;
  const frame = paused?.frames[paused.selected];
  const launchUrl = `http://localhost:${agents[0]?.devServerPort ?? 3000}`;
  const unconnected = targets.filter((target) => !sessionOf(target));

  useEffect(() => {
    setResults([]);
  }, [active?.key]);

  const run = async (): Promise<void> => {
    const text = expression.trim();
    if (!text) return;
    try {
      const value = await api.evaluate(text);
      setResults((current) => [...current.slice(-19), { expression: text, text: describe(value) }]);
    } catch (reason) {
      setResults((current) => [...current.slice(-19), { expression: text, text: reason instanceof Error ? reason.message : String(reason), error: true }]);
    }
    setExpression('');
  };

  return (
    <div className="flex h-full min-h-0 flex-col text-xs">
      <section className="border-b border-zinc-800 p-2">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-wide text-zinc-500">Debug targets</span>
          <span className="flex gap-1">
            {unconnected.length > 0 && (
              <button type="button" onClick={() => unconnected.forEach((target) => void api.connect(target))} className="rounded border border-sky-700 bg-sky-500/15 px-2 py-0.5 text-[11px] text-sky-200 hover:bg-sky-500/25">
                Connect all
              </button>
            )}
            {connected && (
              <button type="button" onClick={api.disconnectAll} className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800">
                Disconnect all
              </button>
            )}
          </span>
        </div>
        {targets.length === 0 && <p className="text-zinc-500">No dev server with the agent is running. Run <code>npx qaisdebugs dev</code> in your app.</p>}
        <ul className="space-y-1">
          {targets.map((target) => {
            const key = targetKey(target);
            const session = sessionOf(target);
            const isActive = active?.key === key;
            const dot = session?.status === 'paused' ? 'bg-amber-400' : session?.status === 'connected' ? 'bg-emerald-400' : session ? 'bg-sky-400' : 'bg-zinc-600';

            return (
              <li key={key} className={`flex items-center gap-2 rounded px-1.5 py-1 ${isActive ? 'bg-zinc-800/70 ring-1 ring-zinc-700' : ''}`}>
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
                <button type="button" onClick={() => session && api.setActive(key)} className="min-w-0 flex-1 truncate text-left text-zinc-300" title={`${targetLabel(target)}${session ? ` · ${session.scriptCount} scripts` : ''}`}>
                  {target.kind === 'server' ? (
                    <>
                      <AppChip app={target.agent.app} /> server · pid {target.agent.pid}
                    </>
                  ) : (
                    <>page · {targetLabel(target)}</>
                  )}
                  {session?.status === 'paused' && <span className="ml-1 rounded bg-amber-500/20 px-1 text-[10px] uppercase tracking-wide text-amber-200">paused</span>}
                </button>
                {session ? (
                  <button type="button" onClick={() => api.disconnect(key)} className="shrink-0 rounded border border-zinc-700 px-1.5 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800">
                    Disconnect
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={target.kind === 'server' ? !target.agent.inspectorUrl : !target.agent}
                    onClick={() => void api.connect(target)}
                    className="shrink-0 rounded border border-sky-700 bg-sky-500/15 px-1.5 py-0.5 text-[11px] text-sky-200 hover:bg-sky-500/25 disabled:cursor-not-allowed disabled:opacity-50"
                    title={target.kind === 'page' && !target.agent ? 'No running dev server with the agent matches this page' : undefined}
                  >
                    Connect
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        {api.error && <p className="mt-1 text-amber-300">{api.error}</p>}
        <div className="mt-2 flex items-center gap-2 text-[11px]">
          <button
            type="button"
            disabled={chrome.launching}
            onClick={() => onLaunchChrome(launchUrl)}
            className="rounded border border-zinc-700 px-2 py-0.5 text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
            title={`Starts a separate Chrome profile with remote debugging on port ${chrome.port}, opening ${launchUrl}`}
          >
            {chrome.launching ? 'Starting Chrome…' : chrome.running ? 'Open a page in the debug Chrome' : 'Launch debug Chrome'}
          </button>
          <span className="text-zinc-500">
            {chrome.running ? `${chrome.browser ?? 'Chrome'} on :${chrome.port}, ${pages.length} page${pages.length === 1 ? '' : 's'}` : `no debug Chrome on :${chrome.port}`}
          </span>
        </div>
        {chrome.error && <p className="mt-1 text-amber-300">{chrome.error}</p>}
      </section>

      <section className="border-b border-zinc-800 p-2">
        {pausedSessions.length > 1 && (
          <div className="mb-1 flex flex-wrap gap-1 text-[11px]">
            {pausedSessions.map((session) => (
              <button key={session.key} type="button" onClick={() => api.setActive(session.key)} className={`rounded border px-2 py-0.5 ${active?.key === session.key ? 'border-amber-600 bg-amber-500/15 text-amber-200' : 'border-zinc-700 text-zinc-300 hover:bg-zinc-800'}`}>
                {session.target.kind === 'server' ? 'server' : 'page'} paused
              </button>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-1">
          <Control label={paused ? 'Resume (F8)' : 'Pause'} glyph={paused ? '▶' : '⏸'} disabled={!active} onClick={paused ? api.resume : api.pause} primary />
          <Control label="Step over (F10)" glyph="⤼" disabled={!paused} onClick={api.stepOver} />
          <Control label="Step into (F11)" glyph="⤵" disabled={!paused} onClick={api.stepInto} />
          <Control label="Step out (Shift+F11)" glyph="⤴" disabled={!paused} onClick={api.stepOut} />
          <label className="ml-auto flex items-center gap-1 text-[11px] text-zinc-400">
            on exceptions
            <select value={api.pauseOnExceptions} onChange={(event) => api.setPauseOnExceptions(event.target.value as 'none' | 'uncaught' | 'all')} className="rounded border border-zinc-700 bg-zinc-950 px-1 py-0.5 text-zinc-300">
              <option value="none">off</option>
              <option value="uncaught">uncaught</option>
              <option value="all">all</option>
            </select>
          </label>
        </div>
        {paused && active && (
          <p className="mt-2 rounded border border-amber-700/50 bg-amber-500/10 px-2 py-1 text-amber-200">
            {active.target.kind === 'server' ? 'Server' : 'Page'} paused on {paused.reason}
            {paused.exception && <>: {describe(paused.exception)}</>}.{' '}
            {active.target.kind === 'server' ? 'The dev server is frozen until you resume.' : 'The page is frozen until you resume.'}
          </p>
        )}
        {!paused && active && <p className="mt-2 text-[11px] text-zinc-500">Acting on: {active.label}</p>}
      </section>

      <div className="min-h-0 flex-1 overflow-auto">
        <Section title={`Breakpoints (${api.breakpoints.length})`}>
          {api.breakpoints.length === 0 && <p className="px-2 text-zinc-500">Click a line number in the code to add one.</p>}
          {api.breakpoints.map((breakpoint) => {
            const where = api.sessions.filter((session) => (breakpoint.ids[session.key] ?? []).length > 0).map((session) => (session.target.kind === 'server' ? 'server' : 'page'));

            return (
            <div key={breakpoint.key} className="flex items-center gap-2 px-2 py-0.5">
              <span className={`h-2 w-2 rounded-full ${isResolved(breakpoint) ? 'bg-red-400' : 'bg-zinc-600'}`} title={isResolved(breakpoint) ? `Set in: ${where.join(', ')}` : 'Not resolved yet: the module is not loaded, or the line has no code'} />
              <button type="button" onClick={() => onOpenFile(breakpoint.file, breakpoint.line)} className="min-w-0 flex-1 truncate text-left font-mono text-zinc-300 hover:text-sky-300" title={`${shortFile(breakpoint.file)}:${breakpoint.line}`}>
                {tailOf(breakpoint.file)}:{breakpoint.line}
              </button>
              {where.length > 0 && <span className="text-[10px] text-zinc-500">{where.join('+')}</span>}
              <button type="button" onClick={() => void api.removeBreakpoint(breakpoint.key)} className="text-zinc-500 hover:text-red-300" title="Remove">
                ✕
              </button>
            </div>
            );
          })}
        </Section>

        {paused && (
          <Section title={`Call stack (${paused.frames.length})`}>
            <CallStack frames={paused.frames} selected={paused.selected} onSelect={api.selectFrame} />
          </Section>
        )}

        {frame && (
          <Section title="Scope">
            {frame.scopes
              .filter((scope) => scope.objectId && scope.type !== 'global')
              .map((scope) => (
                <ObjectTree key={scope.objectId} label={scope.name ? `${scope.type}: ${scope.name}` : scope.type} objectId={scope.objectId!} getProperties={api.getProperties} depth={0} defaultOpen={scope.type === 'local' || scope.type === 'block'} />
              ))}
          </Section>
        )}

        <Section title="Console">
          <div className="px-2">
            {results.map((entry, index) => (
              <div key={index} className="border-b border-zinc-800/60 py-1 font-mono">
                <div className="text-zinc-500">› {entry.expression}</div>
                <div className={`whitespace-pre-wrap break-all ${entry.error ? 'text-red-300' : 'text-zinc-200'}`}>{entry.text}</div>
              </div>
            ))}
            <input
              value={expression}
              onChange={(event) => setExpression(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void run();
              }}
              disabled={!connected}
              placeholder={paused ? 'Evaluate in the selected frame…' : active ? (active.target.kind === 'page' ? 'Evaluate in the page…' : 'Evaluate in the server process…') : 'Connect first'}
              className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-zinc-200 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none disabled:opacity-50"
            />
          </div>
        </Section>
      </div>
    </div>
  );
}

/** Application frames always; runs of framework frames folded behind one row each. */
function CallStack({ frames, selected, onSelect }: { frames: Array<{ callFrameId: string; functionName: string; file?: string; line?: number; url: string; isApp: boolean }>; selected: number; onSelect: (index: number) => void }): JSX.Element {
  const [opened, setOpened] = useState<Set<number>>(new Set());
  const groups: Array<{ start: number; end: number; app: boolean }> = [];
  frames.forEach((frame, index) => {
    const last = groups[groups.length - 1];
    if (last && last.app === frame.isApp) last.end = index;
    else groups.push({ start: index, end: index, app: frame.isApp });
  });

  const row = (index: number): JSX.Element => {
    const frame = frames[index];

    return (
      <button
        key={frame.callFrameId}
        type="button"
        onClick={() => onSelect(index)}
        className={`block w-full px-2 py-0.5 text-left ${index === selected ? 'bg-sky-500/15 text-zinc-100' : frame.isApp ? 'text-zinc-300 hover:bg-zinc-800/60' : 'text-zinc-500 hover:bg-zinc-800/60'}`}
        title={frame.file ?? frame.url}
      >
        <div className="truncate font-mono">{frame.functionName}</div>
        <div className="truncate font-mono text-[11px] text-zinc-500">{frame.file ? `${tailOf(frame.file)}:${frame.line}` : frameWhere(frame.url)}</div>
      </button>
    );
  };

  return (
    <>
      {groups.map((group) => {
        const size = group.end - group.start + 1;
        if (group.app || size <= 2 || opened.has(group.start) || (selected >= group.start && selected <= group.end)) {
          return Array.from({ length: size }, (_, offset) => row(group.start + offset));
        }

        return (
          <button key={`fold-${group.start}`} type="button" onClick={() => setOpened((current) => new Set(current).add(group.start))} className="block w-full px-2 py-0.5 text-left text-[11px] text-zinc-500 hover:bg-zinc-800/60 hover:text-zinc-300">
            ▸ {size} framework frames
          </button>
        );
      })}
    </>
  );
}

function Control({ label, glyph, disabled, onClick, primary }: { label: string; glyph: string; disabled: boolean; onClick: () => void; primary?: boolean }): JSX.Element {
  return (
    <button
      type="button"
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`rounded border px-2 py-0.5 text-sm leading-5 disabled:cursor-not-allowed disabled:opacity-40 ${primary ? 'border-amber-700 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25' : 'border-zinc-700 text-zinc-300 hover:bg-zinc-800'}`}
    >
      {glyph}
    </button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  const [open, setOpen] = useState(true);

  return (
    <section className="border-b border-zinc-800">
      <button type="button" onClick={() => setOpen((current) => !current)} className="flex w-full items-center gap-1 px-2 py-1 text-left text-[11px] uppercase tracking-wide text-zinc-500 hover:text-zinc-300">
        <span className="w-3">{open ? '▾' : '▸'}</span>
        {title}
      </button>
      {open && <div className="pb-1">{children}</div>}
    </section>
  );
}
