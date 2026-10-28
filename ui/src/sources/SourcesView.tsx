import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type PageTarget, agentForPage, agentServingPage, pagesToAutoConnect, serverRunKey, serversToAutoConnect, targetKey } from '../debugger/targets';
import { useDebugger } from '../debugger/useDebugger';
import type { AgentEvent } from '../events';
import { CodeViewer } from './CodeViewer';
import { DebugPanel } from './DebugPanel';
import { EditorTabs } from './EditorTabs';
import { FileTree, type TreeNode } from './FileTree';
import { type FindOptions, findMatches, findPattern, firstMatchFrom } from './find';
import { FindBar } from './FindBar';
import { ProjectPicker } from './ProjectPicker';
import { automaticProject, projectOf, runningProjects } from './projects';
import { ProjectSearch } from './ProjectSearch';
import { QuickOpen } from './QuickOpen';
import { type Shortcut, isMacPlatform, shortcutFor, shortcutLabel } from './shortcuts';
import { type EditorTab, closeTab, openTab } from './tabs';
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
  /** Whether the Sources view is the one on screen; it stays mounted while hidden. */
  visible: boolean;
  /** Called when a debugger pauses, so the inspector can bring this view forward. */
  onPaused?: () => void;
  /** Brings this view forward, for a shortcut pressed in another view. */
  onShow?: () => void;
}

interface LoadedFile {
  content?: string;
  error?: string;
}

/** The tabs of one project; `key` is the project they belong to, so they are saved under the right one. */
interface Editor {
  key: string;
  tabs: EditorTab[];
  active?: string;
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
const IS_MAC = isMacPlatform();

const sameUrl = (a: string, b: string): boolean => {
  try {
    const left = new URL(a);
    const right = new URL(b);

    return left.origin === right.origin && left.pathname === right.pathname;
  } catch {
    return a === b;
  }
};

/** The tabs saved for a project; the single file older versions remembered seeds them. */
function loadEditor(key: string): Editor {
  const saved = storage.tabs(key);
  if (saved) return { key, tabs: saved.files.map((file, index) => ({ file, usedAt: index })), active: saved.active ?? saved.files.at(-1) };
  const legacy = storage.file();
  if (legacy && (!key || legacy.file.startsWith(`${key}/`))) return { key, tabs: [{ file: legacy.file, usedAt: 0 }], active: legacy.file };

  return { key, tabs: [] };
}

/** Text selected on one line, to seed a search with. */
function selectedText(): string | undefined {
  const text = window.getSelection()?.toString() ?? '';

  return text && !text.includes('\n') && text.length <= 200 ? text : undefined;
}

export function SourcesView({ agents, requested, visible, onPaused, onShow }: SourcesViewProps): JSX.Element {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [repoRoot, setRepoRootState] = useState<string>('');
  const [pages, setPages] = useState<PageTarget[]>([]);
  const [chrome, setChrome] = useState<ChromeState>({ running: false, port: 9222 });
  const [layout, setLayout] = useState<StoredLayout>(() => storage.layout());
  const pendingTargets = useRef<StoredTarget[]>(storage.targets());
  const restoreStartedAt = useRef(Date.now());
  const triedServerRuns = useRef(new Set<string>());
  const triedPages = useRef(new Set<string>());
  const frame = useRef<HTMLDivElement>(null);

  // ---- which project ------------------------------------------------------------------------
  const projects = useMemo(() => runningProjects(agents), [agents]);
  const [chosenProject, setChosenProject] = useState<string | undefined>(() => storage.project());
  const [picking, setPicking] = useState(false);
  const automatic = automaticProject(projects, chosenProject);
  const projectRoot = automatic;
  const needsPick = projects.length > 1 && (!automatic || picking);
  const projectKey = projectRoot ?? '';
  const project = projects.find((candidate) => candidate.root === projectRoot);

  // ---- tabs and file contents -----------------------------------------------------------------
  const [editor, setEditor] = useState<Editor>(() => loadEditor(projectKey));
  const [contents, setContents] = useState<Record<string, LoadedFile>>({});
  const [focus, setFocus] = useState<{ file: string; line: number; nonce: number } | undefined>(() => {
    const remembered = storage.file();

    return remembered?.line ? { file: remembered.file, line: remembered.line, nonce: 0 } : undefined;
  });
  const scrollPositions = useRef(new Map<string, number>());
  /** A file to open once the project that holds it is shown. */
  const pendingOpen = useRef<SourceLocation | undefined>();
  const activeFile = editor.active;

  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const projectRootRef = useRef(projectRoot);
  projectRootRef.current = projectRoot;

  const showInEditor = useCallback((file: string, line?: number) => {
    setEditor((previous) => ({ ...previous, tabs: openTab(previous.tabs, file, previous.active, Date.now()), active: file }));
    if (line) setFocus({ file, line, nonce: Date.now() });
    storage.saveFile({ file, line });
  }, []);

  const openFile = useCallback(
    (file: string, line?: number) => {
      // A file of another running project shows that project first.
      const owner = projectOf(file, projectsRef.current);
      if (owner && owner.root !== projectRootRef.current) {
        pendingOpen.current = { file, line };
        storage.saveProject(owner.root);
        setChosenProject(owner.root);
        setPicking(false);

        return;
      }
      showInEditor(file, line);
    },
    [showInEditor]
  );

  useEffect(() => {
    if (editor.key === projectKey) return;
    setEditor(loadEditor(projectKey));
    setContents({});
  }, [projectKey, editor.key]);

  useEffect(() => {
    if (editor.key !== projectKey || !pendingOpen.current) return;
    const { file, line } = pendingOpen.current;
    pendingOpen.current = undefined;
    showInEditor(file, line);
  }, [editor.key, projectKey, showInEditor]);

  useEffect(() => {
    storage.saveTabs(editor.key, { files: editor.tabs.map((tab) => tab.file), active: editor.active });
  }, [editor]);

  const selectTab = useCallback((file: string) => {
    setEditor((previous) => ({ ...previous, tabs: openTab(previous.tabs, file, previous.active, Date.now()), active: file }));
    storage.saveFile({ file });
  }, []);

  const closeEditorTab = useCallback((file: string) => {
    setEditor((previous) => ({ ...previous, ...closeTab(previous.tabs, file, previous.active) }));
    setContents(({ [file]: _closed, ...rest }) => rest);
    scrollPositions.current.delete(file);
  }, []);

  // The shown file is read again each time its tab is shown, so edits made meanwhile appear.
  useEffect(() => {
    if (!activeFile) return;
    let cancelled = false;
    fetch(`/sources/file?file=${encodeURIComponent(activeFile)}`)
      .then(async (response) => {
        const payload = (await response.json()) as { content?: string; error?: string };
        if (cancelled) return;
        setContents((previous) => ({ ...previous, [activeFile]: { content: payload.content, error: response.ok ? undefined : payload.error ?? `failed (${response.status})` } }));
      })
      .catch((reason: Error) => {
        if (!cancelled) setContents((previous) => ({ ...previous, [activeFile]: { ...previous[activeFile], error: reason.message } }));
      });

    return () => {
      cancelled = true;
    };
  }, [activeFile]);

  const current = activeFile ? contents[activeFile] : undefined;
  const lines = useMemo(() => (current?.content ?? '').split('\n'), [current?.content]);

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

  /** Shows a project and connects the debugger to its dev servers and its tabs in the qaisdebugs Chrome. */
  const pickProject = (root: string): void => {
    storage.saveProject(root);
    setChosenProject(root);
    setPicking(false);
    const picked = projects.find((candidate) => candidate.root === root);
    if (!picked) return;
    const sessionKeys = new Set(api.sessions.map((session) => session.key));
    for (const agent of picked.agents) {
      if (agent.inspectorUrl && !sessionKeys.has(targetKey({ kind: 'server', agent }))) void api.connect({ kind: 'server', agent });
    }
    for (const page of pages) {
      const agent = agentServingPage(page, picked.agents);
      if (agent && !sessionKeys.has(targetKey({ kind: 'page', page }))) void api.connect({ kind: 'page', page, agent });
    }
  };

  // ---- data ---------------------------------------------------------------------------------
  useEffect(() => {
    if (needsPick) return;
    let cancelled = false;
    fetch(`/sources/tree${projectRoot ? `?root=${encodeURIComponent(projectRoot)}` : ''}`)
      .then(async (response) => (await response.json()) as { repoRoot?: string; tree?: TreeNode[] })
      .then((payload) => {
        if (cancelled) return;
        setTree(payload.tree ?? []);
        if (payload.repoRoot) {
          setRepoRoot(payload.repoRoot);
          setRepoRootState(payload.repoRoot);
        }
      })
      .catch(() => !cancelled && setTree([]));

    return () => {
      cancelled = true;
    };
  }, [projectRoot, needsPick]);

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

  // ---- find in file -------------------------------------------------------------------------
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findOptions, setFindOptions] = useState<FindOptions>({ matchCase: false, regex: false });
  const [findIndex, setFindIndex] = useState(0);
  const findInput = useRef<HTMLInputElement>(null);
  const pattern = useMemo(() => (findOpen ? findPattern(findQuery, findOptions) : undefined), [findOpen, findQuery, findOptions]);
  const matches = useMemo(() => (pattern instanceof RegExp ? findMatches(lines, pattern) : []), [lines, pattern]);

  const activePaused = api.active?.status === 'paused' ? api.active.paused : undefined;
  const pausedFrame = activePaused?.frames[activePaused.selected];
  const pausedLine = pausedFrame?.file === activeFile ? pausedFrame?.line : undefined;
  const focusLine = focus?.file === activeFile ? focus?.line : undefined;

  // A new search starts at the first match from the line you are looking at.
  useEffect(() => {
    setFindIndex(firstMatchFrom(matches, pausedLine ?? focusLine));
  }, [matches]);

  const find = useMemo(() => (findOpen && matches.length ? { matches, current: Math.min(findIndex, matches.length - 1) } : undefined), [findOpen, matches, findIndex]);
  const stepMatch = (delta: number): void => {
    if (matches.length) setFindIndex((index) => (index + delta + matches.length) % matches.length);
  };

  // ---- project search and quick open ----------------------------------------------------------
  const [leftMode, setLeftMode] = useState<'files' | 'search'>('files');
  const [searchFocus, setSearchFocus] = useState({ nonce: 0, seed: undefined as string | undefined });
  const [palette, setPalette] = useState<'' | ':' | undefined>();
  const files = useMemo(() => treeFiles(tree), [tree]);
  const recent = useMemo(
    () =>
      [...editor.tabs]
        .sort((a, b) => b.usedAt - a.usedAt)
        .map((tab) => tab.file)
        .filter((file) => file !== activeFile),
    [editor.tabs, activeFile]
  );

  // ---- keyboard -----------------------------------------------------------------------------
  const runShortcut = (shortcut: Shortcut): void => {
    if (shortcut === 'quickOpen') setPalette('');
    else if (shortcut === 'goToLine') setPalette(activeFile ? ':' : '');
    else if (shortcut === 'searchProject') {
      setLayout((previous) => ({ ...previous, treeOpen: true }));
      setLeftMode('search');
      setSearchFocus((previous) => ({ nonce: previous.nonce + 1, seed: selectedText() }));
    } else if (shortcut === 'find' && activeFile) {
      const seed = selectedText();
      if (seed) setFindQuery(seed);
      setFindOpen(true);
      window.requestAnimationFrame(() => {
        findInput.current?.focus();
        findInput.current?.select();
      });
    }
  };
  const shortcutState = useRef({ visible, needsPick, runShortcut, onShow });
  shortcutState.current = { visible, needsPick, runShortcut, onShow };

  useEffect(() => {
    // Capture phase, so the shortcuts work from inside inputs too, before the browser's own find or print.
    const onKey = (event: KeyboardEvent): void => {
      const shortcut = shortcutFor(event, IS_MAC);
      const state = shortcutState.current;
      if (!shortcut) return;
      // Find and go-to-line belong to the code; elsewhere the browser keeps its own.
      if (!state.visible && (shortcut === 'find' || shortcut === 'goToLine')) return;
      event.preventDefault();
      if (state.needsPick) return;
      if (!state.visible) state.onShow?.();
      state.runShortcut(shortcut);
    };
    window.addEventListener('keydown', onKey, true);

    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

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
    const lineMap = new Map<number, boolean>();
    for (const breakpoint of api.breakpoints) {
      if (breakpoint.file === activeFile) lineMap.set(breakpoint.line, Object.values(breakpoint.ids).some((ids) => ids.length > 0));
    }

    return lineMap;
  }, [api.breakpoints, activeFile]);
  const canBreak = api.sessions.length > 0;
  const pausedSessions = api.sessions.filter((session) => session.status === 'paused');

  const openInEditor = (): void => {
    if (!activeFile) return;
    const activeTarget = api.active?.target;
    const targetAgent = activeTarget ? activeTarget.agent : (project?.agents[0] ?? agents[0]);
    const port = targetAgent?.devServerPort;
    if (!port) return;
    const params = new URLSearchParams({ file: activeFile, lineNumber: String(pausedLine ?? focusLine ?? 1), column: '1' });
    void fetch(`http://localhost:${port}/__nextjs_launch-editor?${params}`, { mode: 'no-cors' }).catch(() => undefined);
  };

  const columns = `${layout.treeOpen ? `${layout.treeWidth}px 5px` : '0px 0px'} minmax(0,1fr) ${layout.panelOpen ? `5px ${layout.panelWidth}px` : '0px 0px'}`;

  if (needsPick) {
    return <ProjectPicker projects={projects} current={automatic ?? chosenProject} shown={visible} onPick={pickProject} onCancel={automatic ? () => setPicking(false) : undefined} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/70 px-2 text-xs">
        <div className="flex shrink-0 items-center gap-2 py-1">
          <PaneToggle open={layout.treeOpen} side="left" label="Files" onClick={() => setLayout((previous) => ({ ...previous, treeOpen: !previous.treeOpen }))} />
          {projects.length > 1 && project && (
            <button
              type="button"
              onClick={() => setPicking(true)}
              title={`${project.root}\nSwitch project`}
              className="flex items-center gap-1 rounded border border-zinc-700 px-2 py-0.5 text-zinc-200 hover:bg-zinc-800"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              {project.name}
              <span className="text-zinc-500">▾</span>
            </button>
          )}
        </div>
        <EditorTabs tabs={editor.tabs} active={activeFile} breakpointFiles={breakpointFiles} pausedFile={pausedFrame?.file} onSelect={selectTab} onClose={closeEditorTab} />
        <div className="flex shrink-0 items-center gap-2 py-1">
          {pausedSessions.length > 0 && (
            <span className="rounded-full border border-amber-700/60 bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-200">
              {pausedSessions.map((session) => (session.target.kind === 'server' ? 'server' : 'page')).join(' + ')} paused
            </span>
          )}
          {activeFile && (api.active || agents[0]) && (
            <button type="button" onClick={openInEditor} className="rounded border border-zinc-700 px-2 py-0.5 text-zinc-300 hover:bg-zinc-800" title="Open in your editor through the dev server">
              Open in editor
            </button>
          )}
          {!canBreak && <span className="hidden text-[11px] text-zinc-500 xl:inline">Connect a target to set breakpoints</span>}
          <PaneToggle open={layout.panelOpen} side="right" label="Debug" onClick={() => setLayout((previous) => ({ ...previous, panelOpen: !previous.panelOpen }))} />
        </div>
      </header>

      <div ref={frame} className="grid min-h-0 flex-1" style={{ gridTemplateColumns: columns }}>
        <aside className={`flex min-h-0 flex-col overflow-hidden ${layout.treeOpen ? 'border-r border-zinc-800' : ''}`}>
          <div className="flex shrink-0 gap-1 border-b border-zinc-800 px-2 pt-1.5 text-[11px]" role="tablist" aria-label="Side panel">
            {(['files', 'search'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                role="tab"
                aria-selected={leftMode === mode}
                onClick={() => {
                  setLeftMode(mode);
                  if (mode === 'search') setSearchFocus((previous) => ({ nonce: previous.nonce + 1, seed: undefined }));
                }}
                title={mode === 'files' ? `Open a file (${shortcutLabel('quickOpen', IS_MAC)})` : `Search in project (${shortcutLabel('searchProject', IS_MAC)})`}
                className={`-mb-px border-b-2 px-2 pb-1 capitalize ${leftMode === mode ? 'border-sky-400 text-zinc-100' : 'border-transparent text-zinc-400 hover:text-zinc-200'}`}
              >
                {mode}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1">
            {leftMode === 'files' ? (
              <FileTree tree={tree} selected={activeFile} breakpointFiles={breakpointFiles} onSelect={(file) => openFile(file)} />
            ) : (
              <ProjectSearch
                root={projectRoot}
                seed={searchFocus.seed}
                focusNonce={searchFocus.nonce}
                onOpen={(file, line, query, options) => {
                  openFile(file, line);
                  if (!options.wholeWord) {
                    setFindQuery(query);
                    setFindOptions({ matchCase: options.matchCase, regex: options.regex });
                    setFindOpen(true);
                  }
                }}
              />
            )}
          </div>
        </aside>
        <div onPointerDown={layout.treeOpen ? startResize('tree') : undefined} className={`overflow-hidden ${layout.treeOpen ? 'cursor-col-resize bg-zinc-800/40 hover:bg-sky-500/40' : ''}`} title={layout.treeOpen ? 'Drag to resize' : undefined} />
        <section className="relative flex min-h-0 flex-col">
          {activeFile ? (
            <>
              <div className="shrink-0 truncate border-b border-zinc-800/70 px-3 py-0.5 font-mono text-[11px] text-zinc-500" title={activeFile}>
                {repoRoot && activeFile.startsWith(`${repoRoot}/`) ? activeFile.slice(repoRoot.length + 1) : activeFile}
              </div>
              <div className="relative min-h-0 flex-1">
                {findOpen && (
                  <FindBar
                    inputRef={findInput}
                    query={findQuery}
                    options={findOptions}
                    count={matches.length}
                    index={find?.current ?? 0}
                    error={typeof pattern === 'string' ? pattern : undefined}
                    onQuery={setFindQuery}
                    onOptions={setFindOptions}
                    onNext={() => stepMatch(1)}
                    onPrevious={() => stepMatch(-1)}
                    onClose={() => setFindOpen(false)}
                  />
                )}
                <CodeViewer
                  file={activeFile}
                  content={current?.content}
                  error={current?.error}
                  focusLine={focusLine}
                  focusNonce={focus?.file === activeFile ? focus.nonce : undefined}
                  scrollTop={scrollPositions.current.get(activeFile)}
                  onScrollTop={(top) => scrollPositions.current.set(activeFile, top)}
                  find={find}
                  pausedLine={pausedLine}
                  breakpointLines={breakpointLines}
                  canBreak={canBreak}
                  onToggleBreakpoint={(line) => void api.toggleBreakpoint(activeFile, line)}
                  hover={activePaused ? { evaluate: api.evaluate, getProperties: api.getProperties } : undefined}
                />
              </div>
            </>
          ) : (
            <EmptyEditor fileCount={files.length} projectName={project?.name} />
          )}
        </section>
        <div onPointerDown={layout.panelOpen ? startResize('panel') : undefined} className={`overflow-hidden ${layout.panelOpen ? 'cursor-col-resize bg-zinc-800/40 hover:bg-sky-500/40' : ''}`} title={layout.panelOpen ? 'Drag to resize' : undefined} />
        <aside className={`min-h-0 overflow-hidden ${layout.panelOpen ? 'border-l border-zinc-800' : ''}`}>
          <DebugPanel agents={agents} pages={pages} chrome={chrome} onLaunchChrome={(url) => void launchChrome(url)} debuggerApi={api} onOpenFile={openFile} />
        </aside>
      </div>

      {palette !== undefined && (
        <QuickOpen
          files={files}
          recent={recent}
          root={repoRoot}
          initial={palette}
          lineCount={activeFile && current?.content !== undefined ? lines.length : undefined}
          onOpen={(file, line) => {
            setPalette(undefined);
            openFile(file, line);
          }}
          onGoToLine={(line) => {
            setPalette(undefined);
            if (activeFile) setFocus({ file: activeFile, line, nonce: Date.now() });
          }}
          onClose={() => setPalette(undefined)}
        />
      )}
    </div>
  );
}

/** What the editor shows with no file open: the ways to open one. */
function EmptyEditor({ fileCount, projectName }: { fileCount: number; projectName?: string }): JSX.Element {
  const rows: Array<[string, string]> = [
    ['Open a file', shortcutLabel('quickOpen', IS_MAC)],
    ['Search in project', shortcutLabel('searchProject', IS_MAC)],
    ['Find in file', shortcutLabel('find', IS_MAC)],
    ['Go to line', shortcutLabel('goToLine', IS_MAC)],
  ];

  return (
    <div className="grid h-full place-items-center p-6 text-xs text-zinc-500">
      <div className="grid gap-3 text-center">
        <p>
          {projectName ? <span className="text-zinc-300">{projectName}</span> : 'This project'} · {fileCount.toLocaleString()} files. Pick one on the left, or:
        </p>
        <dl className="mx-auto grid grid-cols-[auto_auto] gap-x-6 gap-y-1.5 text-left">
          {rows.map(([label, keys]) => (
            <div key={label} className="contents">
              <dt className="text-zinc-400">{label}</dt>
              <dd>
                <kbd className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 font-mono text-[11px] text-zinc-300">{keys}</kbd>
              </dd>
            </div>
          ))}
        </dl>
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

function treeFiles(nodes: TreeNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    if (node.children) treeFiles(node.children, out);
    else out.push(node.path);
  }

  return out;
}

function sameTarget(a: StoredTarget, b: StoredTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'server' && b.kind === 'server') return a.app === b.app;
  if (a.kind === 'page' && b.kind === 'page') return sameUrl(a.url, b.url);

  return false;
}
