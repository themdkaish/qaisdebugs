import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type PageTarget, agentForPage, pagesToAutoConnect, serverRunKey, serversToAutoConnect } from '../debugger/targets';
import { useDebugger } from '../debugger/useDebugger';
import type { AgentEvent } from '../events';
import { CodeViewer } from './CodeViewer';
import { DebugPanel } from './DebugPanel';
import { FileTree, type TreeNode } from './FileTree';
import { setRepoRoot } from '../format';
import { type StoredLayout, type StoredTarget, storage } from './storage';

export interface SourceLocation {
  file: string;
  line?: number;
}

interface SourcesViewProps {
  agents: AgentEvent[];
  /** Set by other views ("Open in Sources"); the view navigates when it changes. */
  requested?: SourceLocation & { nonce: number };
  /** Called when a debugger pauses, so the inspector can bring this view forward. */
  onPaused?: () => void;
}

interface LoadedFile {
  file: string;
  content?: string;
  error?: string;
}

interface ChromeState {
  running: boolean;
  port: number;
  browser?: string;
  launching?: boolean;
  error?: string;
}

const MIN_PANE = 180;
const MAX_PANE = 640;
const RESTORE_WINDOW_MS = 2 * 60 * 1000;

const sameUrl = (a: string, b: string): boolean => {
  try {
    const left = new URL(a);
    const right = new URL(b);

    return left.origin === right.origin && left.pathname === right.pathname;
  } catch {
    return a === b;
  }
};

export function SourcesView({ agents, requested, onPaused }: SourcesViewProps): JSX.Element {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [repoRoot, setRepoRootState] = useState<string>('');
  const [current, setCurrent] = useState<LoadedFile | undefined>(() => {
    const remembered = storage.file();

    return remembered ? { file: remembered.file } : undefined;
  });
  const [focusLine, setFocusLine] = useState<number | undefined>(() => storage.file()?.line);
  const [pages, setPages] = useState<PageTarget[]>([]);
  const [chrome, setChrome] = useState<ChromeState>({ running: false, port: 9222 });
  const [layout, setLayout] = useState<StoredLayout>(() => storage.layout());
  const pendingTargets = useRef<StoredTarget[]>(storage.targets());
  const restoreStartedAt = useRef(Date.now());
  const triedServerRuns = useRef(new Set<string>());
  const triedPages = useRef(new Set<string>());
  const frame = useRef<HTMLDivElement>(null);

  const openFile = useCallback((file: string, line?: number) => {
    setFocusLine(line);
    setCurrent((previous) => (previous?.file === file ? previous : { file }));
    storage.saveFile({ file, line });
  }, []);

  const rememberedBreakpoints = useMemo(() => storage.breakpoints(), []);
  const onPausedRef = useRef(onPaused);
  onPausedRef.current = onPaused;
  const showPause = useCallback(
    (file: string, line: number) => {
      openFile(file, line);
      onPausedRef.current?.();
    },
    [openFile]
  );
  const api = useDebugger(showPause, rememberedBreakpoints);

  // ---- what survives a reload -------------------------------------------------------------
  useEffect(() => {
    storage.saveBreakpoints(api.breakpoints.map(({ file, line }) => ({ file, line })));
  }, [api.breakpoints]);

  useEffect(() => {
    const connected: StoredTarget[] = api.sessions.map((session) =>
      session.target.kind === 'server' ? { kind: 'server', app: session.target.agent.app } : { kind: 'page', url: session.target.page.url }
    );
    // Targets still waiting to be restored stay remembered, so an app that is down right now is
    // reconnected the next time it is up.
    storage.saveTargets([...connected, ...pendingTargets.current.filter((pending) => !connected.some((entry) => sameTarget(entry, pending)))]);
  }, [api.sessions]);

  useEffect(() => {
    storage.saveLayout(layout);
  }, [layout]);

  // ---- connect to every dev server on its own, so a server breakpoint just pauses -------------
  useEffect(() => {
    const sessionKeys = new Set(api.sessions.map((session) => session.key));
    for (const agent of serversToAutoConnect(agents, sessionKeys, triedServerRuns.current)) {
      triedServerRuns.current.add(serverRunKey(agent));
      void api.connect({ kind: 'server', agent });
    }
  }, [agents, api.sessions, api.connect]);

  // ---- and to every tab of the qaisdebugs Chrome that shows one of those apps ----------------
  useEffect(() => {
    const sessionKeys = new Set(api.sessions.map((session) => session.key));
    for (const { page, agent } of pagesToAutoConnect(pages, agents, sessionKeys, triedPages.current)) {
      triedPages.current.add(page.id);
      void api.connect({ kind: 'page', page, agent });
    }
  }, [pages, agents, api.sessions, api.connect]);

  // ---- reconnect the pages that were connected before the reload ----------------------------
  useEffect(() => {
    if (pendingTargets.current.length === 0) return;
    if (Date.now() - restoreStartedAt.current > RESTORE_WINDOW_MS) {
      pendingTargets.current = [];

      return;
    }

    const remaining: StoredTarget[] = [];
    for (const stored of pendingTargets.current) {
      // Dev servers connect on their own (above).
      if (stored.kind === 'server') continue;
      const page = pages.find((candidate) => sameUrl(candidate.url, stored.url));
      if (page) {
        void api.connect({ kind: 'page', page, agent: agentForPage(page, agents) });
        continue;
      }
      remaining.push(stored);
    }
    pendingTargets.current = remaining;
  }, [agents, pages, api.connect]);

  // ---- data ---------------------------------------------------------------------------------
  useEffect(() => {
    fetch('/sources/tree')
      .then(async (response) => (await response.json()) as { repoRoot: string; tree: TreeNode[] })
      .then((payload) => {
        setTree(payload.tree);
        setRepoRoot(payload.repoRoot);
        setRepoRootState(payload.repoRoot);
      })
      .catch(() => setTree([]));
  }, []);

  useEffect(() => {
    if (requested) openFile(requested.file, requested.line);
  }, [requested, openFile]);

  const refreshTargets = useCallback(async () => {
    try {
      const payload = (await (await fetch('/chrome/targets')).json()) as { port: number; running: boolean; browser?: string; targets: PageTarget[]; error?: string };
      setPages(payload.targets);
      setChrome((previous) => ({ ...previous, running: payload.running, port: payload.port, browser: payload.browser, error: payload.error }));
    } catch {
      // Collector unreachable; the feed shows that already.
    }
  }, []);

  useEffect(() => {
    void refreshTargets();
    // Often enough that a tab opened in the qaisdebugs Chrome is connected before it is used.
    const timer = window.setInterval(() => void refreshTargets(), 2000);

    return () => window.clearInterval(timer);
  }, [refreshTargets]);

  const launchChrome = useCallback(
    async (url: string) => {
      setChrome((previous) => ({ ...previous, launching: true, error: undefined }));
      try {
        const response = await fetch('/chrome/launch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) });
        const payload = (await response.json()) as { error?: string };
        if (!response.ok) throw new Error(payload.error ?? `launch failed (${response.status})`);
      } catch (reason) {
        setChrome((previous) => ({ ...previous, error: reason instanceof Error ? reason.message : String(reason) }));
      } finally {
        setChrome((previous) => ({ ...previous, launching: false }));
        window.setTimeout(() => void refreshTargets(), 1000);
      }
    },
    [refreshTargets]
  );

  useEffect(() => {
    if (!current || current.content !== undefined || current.error) return;
    let cancelled = false;
    fetch(`/sources/file?file=${encodeURIComponent(current.file)}`)
      .then(async (response) => {
        const payload = (await response.json()) as { content?: string; error?: string };
        if (cancelled) return;
        setCurrent((previous) => (previous?.file === current.file ? { ...previous, content: payload.content, error: response.ok ? undefined : payload.error ?? `failed (${response.status})` } : previous));
      })
      .catch((reason: Error) => {
        if (!cancelled) setCurrent((previous) => (previous?.file === current.file ? { ...previous, error: reason.message } : previous));
      });

    return () => {
      cancelled = true;
    };
  }, [current]);

  // ---- keyboard -----------------------------------------------------------------------------
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const isPaused = api.active?.status === 'paused';
      if (!isPaused && !(event.key === 'F8' && api.active)) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return;

      if (event.key === 'F8') isPaused ? api.resume() : api.pause();
      else if (event.key === 'F10') api.stepOver();
      else if (event.key === 'F11' && event.shiftKey) api.stepOut();
      else if (event.key === 'F11') api.stepInto();
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, [api]);

  // ---- resizable panes ----------------------------------------------------------------------
  const startResize = (side: 'tree' | 'panel') => (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const bounds = frame.current?.getBoundingClientRect();
    if (!bounds) return;
    const move = (pointer: PointerEvent): void => {
      const width = side === 'tree' ? pointer.clientX - bounds.left : bounds.right - pointer.clientX;
      const clamped = Math.round(Math.min(MAX_PANE, Math.max(MIN_PANE, width)));
      setLayout((previous) => (side === 'tree' ? { ...previous, treeWidth: clamped } : { ...previous, panelWidth: clamped }));
    };
    const stop = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
  };

  const breakpointFiles = useMemo(() => new Set(api.breakpoints.map((breakpoint) => breakpoint.file)), [api.breakpoints]);
  const breakpointLines = useMemo(() => {
    const lines = new Map<number, boolean>();
    for (const breakpoint of api.breakpoints) {
      if (breakpoint.file === current?.file) lines.set(breakpoint.line, Object.values(breakpoint.ids).some((ids) => ids.length > 0));
    }

    return lines;
  }, [api.breakpoints, current?.file]);
  const activePaused = api.active?.status === 'paused' ? api.active.paused : undefined;
  const pausedFrame = activePaused?.frames[activePaused.selected];
  const pausedLine = pausedFrame?.file === current?.file ? pausedFrame?.line : undefined;
  const canBreak = api.sessions.length > 0;
  const pausedSessions = api.sessions.filter((session) => session.status === 'paused');

  const openInEditor = (): void => {
    if (!current) return;
    const activeTarget = api.active?.target;
    const targetAgent = activeTarget ? (activeTarget.kind === 'server' ? activeTarget.agent : activeTarget.agent) : agents[0];
    const port = targetAgent?.devServerPort;
    if (!port) return;
    const params = new URLSearchParams({ file: current.file, lineNumber: String(pausedLine ?? focusLine ?? 1), column: '1' });
    void fetch(`http://localhost:${port}/__nextjs_launch-editor?${params}`, { mode: 'no-cors' }).catch(() => undefined);
  };

  const columns = `${layout.treeOpen ? `${layout.treeWidth}px 5px` : '0px 0px'} minmax(0,1fr) ${layout.panelOpen ? `5px ${layout.panelWidth}px` : '0px 0px'}`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/70 px-2 py-1 text-xs">
        <PaneToggle open={layout.treeOpen} side="left" label="Files" onClick={() => setLayout((previous) => ({ ...previous, treeOpen: !previous.treeOpen }))} />
        <code className="min-w-0 flex-1 truncate font-mono text-zinc-300" title={current?.file}>
          {current ? current.file.replace(`${repoRoot}/`, '') : 'No file open'}
        </code>
        {pausedSessions.length > 0 && (
          <span className="rounded-full border border-amber-700/60 bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-200">
            {pausedSessions.map((session) => (session.target.kind === 'server' ? 'server' : 'page')).join(' + ')} paused
          </span>
        )}
        {current && (api.active || agents[0]) && (
          <button type="button" onClick={openInEditor} className="rounded border border-zinc-700 px-2 py-0.5 text-zinc-300 hover:bg-zinc-800" title="Open in your editor through the dev server">
            Open in editor
          </button>
        )}
        {!canBreak && <span className="hidden text-[11px] text-zinc-500 lg:inline">Connect a target to set breakpoints</span>}
        <PaneToggle open={layout.panelOpen} side="right" label="Debug" onClick={() => setLayout((previous) => ({ ...previous, panelOpen: !previous.panelOpen }))} />
      </header>

      <div ref={frame} className="grid min-h-0 flex-1" style={{ gridTemplateColumns: columns }}>
        <aside className={`min-h-0 overflow-hidden ${layout.treeOpen ? 'border-r border-zinc-800' : ''}`}>
          <FileTree tree={tree} selected={current?.file} breakpointFiles={breakpointFiles} onSelect={(file) => openFile(file)} />
        </aside>
        <div onPointerDown={layout.treeOpen ? startResize('tree') : undefined} className={`overflow-hidden ${layout.treeOpen ? 'cursor-col-resize bg-zinc-800/40 hover:bg-sky-500/40' : ''}`} title={layout.treeOpen ? 'Drag to resize' : undefined} />
        <section className="min-h-0">
          <CodeViewer
            file={current?.file}
            content={current?.content}
            error={current?.error}
            focusLine={focusLine}
            pausedLine={pausedLine}
            breakpointLines={breakpointLines}
            canBreak={canBreak}
            onToggleBreakpoint={(line) => current && void api.toggleBreakpoint(current.file, line)}
            hover={activePaused ? { evaluate: api.evaluate, getProperties: api.getProperties } : undefined}
          />
        </section>
        <div onPointerDown={layout.panelOpen ? startResize('panel') : undefined} className={`overflow-hidden ${layout.panelOpen ? 'cursor-col-resize bg-zinc-800/40 hover:bg-sky-500/40' : ''}`} title={layout.panelOpen ? 'Drag to resize' : undefined} />
        <aside className={`min-h-0 overflow-hidden ${layout.panelOpen ? 'border-l border-zinc-800' : ''}`}>
          <DebugPanel agents={agents} pages={pages} chrome={chrome} onLaunchChrome={(url) => void launchChrome(url)} debuggerApi={api} onOpenFile={openFile} />
        </aside>
      </div>
    </div>
  );
}

function PaneToggle({ open, side, label, onClick }: { open: boolean; side: 'left' | 'right'; label: string; onClick: () => void }): JSX.Element {
  const glyph = side === 'left' ? (open ? '⟨' : '⟩') : open ? '⟩' : '⟨';

  return (
    <button type="button" onClick={onClick} className={`rounded border px-2 py-0.5 text-[11px] ${open ? 'border-zinc-700 text-zinc-300 hover:bg-zinc-800' : 'border-sky-700 bg-sky-500/15 text-sky-200 hover:bg-sky-500/25'}`} title={`${open ? 'Hide' : 'Show'} ${label}`}>
      {side === 'left' ? `${glyph} ${label}` : `${label} ${glyph}`}
    </button>
  );
}

function sameTarget(a: StoredTarget, b: StoredTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'server' && b.kind === 'server') return a.app === b.app;
  if (a.kind === 'page' && b.kind === 'page') return sameUrl(a.url, b.url);

  return false;
}
