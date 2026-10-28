import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ParseStackOptions } from '../../../agent/shared/initiator';
import type { DevtoolsEvent, LogLevel } from '../events';
import { CdpClient } from './cdp';
import { isForeignScriptStartPause, type RawPause } from './pauses';
import { type PropertyDescriptor, type RemoteObject, describe } from './remoteObject';
import { type ScriptRecord, fileFromScriptUrl, generatedPosition, isChunkScript, loadSources, mapLocation, originalPosition } from './sourceMaps';
import { type DebugTarget, targetKey, targetLabel, targetWsUrl } from './targets';

/**
 * The debugger: any number of sessions at once (an app's Node process and a Chrome page showing
 * it, typically), one shared set of breakpoints by original file and line, and the paused state
 * of whichever session stopped. Breakpoints are placed in every session that has the file, so a
 * line in a client component pauses the server while it renders on the server side and the page
 * while it hydrates, one after the other.
 */

export type SessionStatus = 'connecting' | 'connected' | 'paused';

export interface Breakpoint {
  key: string;
  file: string;
  line: number;
  /** CDP breakpoint ids per session key. A session with none has not resolved the line (yet). */
  ids: Record<string, string[]>;
}

export interface Scope {
  type: string;
  name?: string;
  objectId?: string;
}

export interface CallFrame {
  callFrameId: string;
  functionName: string;
  file?: string;
  line?: number;
  column?: number;
  url: string;
  isApp: boolean;
  scopes: Scope[];
}

export interface PausedState {
  reason: string;
  frames: CallFrame[];
  selected: number;
  exception?: RemoteObject;
}

/** What React sees of a session. */
export interface SessionView {
  key: string;
  target: DebugTarget;
  label: string;
  status: SessionStatus;
  paused?: PausedState;
  scriptCount: number;
  error?: string;
}

interface Session {
  key: string;
  target: DebugTarget;
  label: string;
  cdp: CdpClient;
  options: ParseStackOptions;
  scripts: Map<string, ScriptRecord>;
  scriptsByFile: Map<string, Set<string>>;
  status: SessionStatus;
  paused?: PausedState;
  scriptCount: number;
  instrumentation: boolean;
  /** This session asked for a pause or a step and has not paused since, so the next pause is its own. */
  requested: boolean;
  /** Counts resumes, so a pause resumed before it was shown is dropped. */
  resumes: number;
  error?: string;
}

interface RawLocation {
  scriptId: string;
  lineNumber: number;
  columnNumber?: number;
}

interface RawCallFrame {
  callFrameId: string;
  functionName: string;
  location: RawLocation;
  url: string;
  scopeChain: Array<{ type: string; name?: string; object: RemoteObject }>;
}

type RawStack = { callFrames?: Array<{ scriptId: string; lineNumber: number; columnNumber: number; functionName?: string }> };

export interface DebuggerApi {
  sessions: SessionView[];
  /** The session whose pause, scopes and console the panel shows. */
  active?: SessionView;
  error?: string;
  breakpoints: Breakpoint[];
  pauseOnExceptions: 'none' | 'uncaught' | 'all';
  connect: (target: DebugTarget) => Promise<void>;
  disconnect: (key: string) => void;
  disconnectAll: () => void;
  setActive: (key: string) => void;
  toggleBreakpoint: (file: string, line: number) => Promise<void>;
  removeBreakpoint: (key: string) => Promise<void>;
  resume: () => void;
  pause: () => void;
  stepOver: () => void;
  stepInto: () => void;
  stepOut: () => void;
  selectFrame: (index: number) => void;
  setPauseOnExceptions: (state: 'none' | 'uncaught' | 'all') => void;
  getProperties: (objectId: string) => Promise<PropertyDescriptor[]>;
  evaluate: (expression: string, options?: { sideEffectFree?: boolean }) => Promise<RemoteObject>;
}

const breakpointKey = (file: string, line: number): string => `${file}:${line}`;

export const isResolved = (breakpoint: Breakpoint): boolean => Object.values(breakpoint.ids).some((ids) => ids.length > 0);

export function useDebugger(onPausedAt?: (file: string, line: number) => void, initialBreakpoints: Array<{ file: string; line: number }> = []): DebuggerApi {
  const [views, setViews] = useState<SessionView[]>([]);
  const [activeKey, setActiveKey] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [breakpoints, setBreakpoints] = useState<Breakpoint[]>(() => initialBreakpoints.map(({ file, line }) => ({ key: breakpointKey(file, line), file, line, ids: {} })));
  const [pauseOnExceptions, setPauseOnExceptionsState] = useState<'none' | 'uncaught' | 'all'>('none');

  const sessions = useRef(new Map<string, Session>());
  const breakpointsRef = useRef<Breakpoint[]>(initialBreakpoints.map(({ file, line }) => ({ key: breakpointKey(file, line), file, line, ids: {} })));
  const activeRef = useRef<string | undefined>();
  const onPausedAtRef = useRef(onPausedAt);
  onPausedAtRef.current = onPausedAt;

  const publish = useCallback(() => {
    setViews(
      [...sessions.current.values()].map((session) => ({
        key: session.key,
        target: session.target,
        label: session.label,
        status: session.status,
        paused: session.paused,
        scriptCount: session.scriptCount,
        error: session.error,
      }))
    );
  }, []);

  const updateBreakpoints = useCallback((next: Breakpoint[]) => {
    breakpointsRef.current = next;
    setBreakpoints(next);
  }, []);

  const activate = useCallback((key: string | undefined) => {
    activeRef.current = key;
    setActiveKey(key);
  }, []);

  const applyBreakpointTo = useCallback(async (session: Session, breakpoint: Breakpoint): Promise<string[]> => {
    const ids: string[] = [];
    for (const scriptId of session.scriptsByFile.get(breakpoint.file) ?? []) {
      const script = session.scripts.get(scriptId);
      if (!script) continue;
      const generated = await generatedPosition(script, breakpoint.file, breakpoint.line, session.options);
      if (!generated) continue;

      try {
        const result = await session.cdp.send<{ breakpointId: string }>('Debugger.setBreakpointByUrl', {
          url: script.url,
          lineNumber: generated.lineNumber,
          columnNumber: generated.columnNumber,
        });
        ids.push(result.breakpointId);
      } catch (reason) {
        if (!(reason instanceof Error && /already exists/i.test(reason.message))) console.warn('setBreakpoint failed', reason);
      }
    }

    return ids;
  }, []);

  const recordIds = useCallback(
    (sessionKey: string, breakpointKeyToUpdate: string, ids: string[]) => {
      if (ids.length === 0) return;
      updateBreakpoints(
        breakpointsRef.current.map((entry) =>
          entry.key === breakpointKeyToUpdate ? { ...entry, ids: { ...entry.ids, [sessionKey]: [...new Set([...(entry.ids[sessionKey] ?? []), ...ids])] } } : entry
        )
      );
    },
    [updateBreakpoints]
  );

  /**
   * While any breakpoint is unresolved in a session, V8 pauses before each source-mapped script
   * runs; that pause places the pending breakpoints and resumes, so a breakpoint set before a
   * reload hits on the first render.
   */
  const syncInstrumentation = useCallback(async (session: Session) => {
    const wanted = breakpointsRef.current.some((breakpoint) => (breakpoint.ids[session.key] ?? []).length === 0);
    if (wanted === session.instrumentation) return;

    try {
      if (wanted) await session.cdp.send('Debugger.setInstrumentationBreakpoint', { instrumentation: 'beforeScriptWithSourceMapExecution' });
      else await session.cdp.send('Debugger.removeInstrumentationBreakpoint', { instrumentation: 'beforeScriptWithSourceMapExecution' });
      session.instrumentation = wanted;
    } catch {
      // Targets without instrumentation breakpoints still get them through scriptParsed.
    }
  }, []);

  /**
   * The application files a script holds, registered under `scriptsByFile` the first time: the one
   * a webpack module's URL names, or those listed by a chunk's map (fetched once, names only).
   */
  const ensureIndexed = useCallback(async (session: Session, scriptId: string): Promise<string[]> => {
    const script = session.scripts.get(scriptId);
    if (!script) return [];
    const files = script.file
      ? [script.file]
      : isChunkScript(script)
        ? (await loadSources(script, session.options)).map((source) => source.file).filter((file) => !file.includes('/node_modules/'))
        : [];
    for (const file of files) {
      let set = session.scriptsByFile.get(file);
      if (!set) {
        set = new Set();
        session.scriptsByFile.set(file, set);
      }
      set.add(scriptId);
    }

    return files;
  }, []);

  const applyPendingForScript = useCallback(
    async (session: Session, scriptId: string) => {
      const files = await ensureIndexed(session, scriptId);
      if (files.length === 0) return;
      for (const breakpoint of breakpointsRef.current) {
        if (!files.includes(breakpoint.file)) continue;
        recordIds(session.key, breakpoint.key, await applyBreakpointTo(session, breakpoint));
      }
    },
    [applyBreakpointTo, ensureIndexed, recordIds]
  );

  const removeSession = useCallback(
    (key: string, why?: string) => {
      const session = sessions.current.get(key);
      if (!session) return;
      sessions.current.delete(key);
      session.cdp.onClose = undefined;
      session.cdp.close();
      updateBreakpoints(breakpointsRef.current.map((entry) => ({ ...entry, ids: Object.fromEntries(Object.entries(entry.ids).filter(([sessionKey]) => sessionKey !== key)) })));
      if (why) setError(`${session.label}: ${why}`);
      if (activeRef.current === key) {
        const next = [...sessions.current.values()].find((candidate) => candidate.status === 'paused') ?? [...sessions.current.values()][0];
        activate(next?.key);
      }
      publish();
    },
    [activate, publish, updateBreakpoints]
  );

  const handlePaused = useCallback(
    (session: Session, params: unknown) => {
      const { reason: rawReason, callFrames, data, hitBreakpoints } = params as { reason: string; callFrames: RawCallFrame[]; data?: RemoteObject; hitBreakpoints?: string[] };

      if (rawReason === 'instrumentation') {
        const scriptId = (data as unknown as { scriptId?: string } | undefined)?.scriptId;
        void (scriptId ? applyPendingForScript(session, scriptId) : Promise.resolve()).finally(() => {
          void session.cdp.send('Debugger.resume').catch(() => undefined);
          void syncInstrumentation(session);
        });

        return;
      }

      const requested = session.requested;
      session.requested = false;
      const resumes = session.resumes;
      const readSource = (scriptId: string): Promise<string | undefined> =>
        session.cdp.send<{ scriptSource: string }>('Debugger.getScriptSource', { scriptId }).then((result) => result.scriptSource);

      const reason = hitBreakpoints?.length ? 'breakpoint' : rawReason;
      // Mapping may fetch a chunk's map, so the frames are built asynchronously. A chunk holding
      // only dependencies is left unmapped: its map is large and its frames are framework frames.
      const mapFrame = async (frame: RawCallFrame): Promise<CallFrame> => {
        const script = session.scripts.get(frame.location.scriptId);
        const worthMapping = script && (!isChunkScript(script) || (await ensureIndexed(session, frame.location.scriptId)).length > 0);
        const original = script && worthMapping ? await originalPosition(script, frame.location.lineNumber, frame.location.columnNumber ?? 0, session.options) : undefined;
        const file = original?.file;

        return {
          callFrameId: frame.callFrameId,
          functionName: frame.functionName || '(anonymous)',
          file,
          line: original?.line,
          column: original?.column,
          url: frame.url || script?.url || '',
          isApp: Boolean(file && !file.includes('/node_modules/') && !file.includes('/.next/')),
          scopes: frame.scopeChain.map((scope) => ({ type: scope.type, name: scope.name, objectId: scope.object.objectId })),
        };
      };

      // Another debugger's pause before a script runs is not this session's to show or resume, and a
      // pause resumed while its frames were being mapped is over.
      void isForeignScriptStartPause(params as RawPause, (scriptId) => session.scripts.get(scriptId), requested, readSource).then(async (foreign) => {
        if (foreign) return;
        const frames = await Promise.all(callFrames.map(mapFrame));
        if (!sessions.current.has(session.key) || session.resumes !== resumes) return;
        const selected = Math.max(0, frames.findIndex((frame) => frame.isApp));
        session.paused = { reason, frames, selected, exception: reason === 'exception' ? data : undefined };
        session.status = 'paused';
        activate(session.key);
        publish();

        const top = frames[selected];
        if (top?.file && top.line) onPausedAtRef.current?.(top.file, top.line);
      });
    },
    [activate, applyPendingForScript, ensureIndexed, publish, syncInstrumentation]
  );

  const forwardPageConsole = useCallback((session: Session) => {
    if (session.target.kind !== 'page' || !session.target.agent) return;
    const app = session.target.agent.app;
    // A page served by a dev server with the agent reports its own console through the page
    // script; forwarding it from here as well would log every line twice.
    let hasPageScript: Promise<boolean> | undefined;
    const pageReportsItself = (): Promise<boolean> =>
      (hasPageScript ??= session.cdp
        .send<{ result?: { value?: unknown } }>('Runtime.evaluate', { expression: 'Boolean(window.__qaisdebugs)', returnByValue: true })
        .then((response) => response.result?.value === true)
        .catch(() => false));
    session.cdp.on('Runtime.executionContextsCleared', () => {
      hasPageScript = undefined;
    });
    const forward = (event: DevtoolsEvent): void => {
      void pageReportsItself().then((reports) => {
        if (reports) return;
        void fetch('/ingest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ events: [event] }) }).catch(() => undefined);
      });
    };
    const initiatorOf = async (stack?: RawStack) => {
      for (const frame of stack?.callFrames ?? []) {
        const script = session.scripts.get(frame.scriptId);
        if (!script) continue;
        if (!script.file && (await ensureIndexed(session, frame.scriptId)).length === 0) continue;
        const original = await originalPosition(script, frame.lineNumber, frame.columnNumber, session.options);
        if (original && !original.file.includes('/node_modules/')) return { ...original, fn: frame.functionName || undefined };
      }

      return undefined;
    };

    session.cdp.on('Runtime.consoleAPICalled', (params) => {
      const { type, args, timestamp, stackTrace } = params as { type: string; args: RemoteObject[]; timestamp: number; stackTrace?: RawStack };
      const level: LogLevel = type === 'warning' ? 'warn' : type === 'error' ? 'error' : type === 'info' ? 'info' : type === 'debug' ? 'debug' : 'log';
      void initiatorOf(stackTrace).then((initiator) =>
        forward({
          kind: 'log',
          id: crypto.randomUUID(),
          app,
          origin: 'browser',
          level,
          args: args.map((arg) => (arg.type === 'string' || arg.type === 'number' || arg.type === 'boolean' ? arg.value : describe(arg))),
          at: Math.round(timestamp),
          initiator,
        })
      );
    });
    session.cdp.on('Runtime.exceptionThrown', (params) => {
      const { timestamp, exceptionDetails } = params as { timestamp: number; exceptionDetails: { text: string; exception?: RemoteObject } };
      forward({
        kind: 'error',
        id: crypto.randomUUID(),
        app,
        origin: 'browser',
        message: exceptionDetails.exception ? describe(exceptionDetails.exception) : exceptionDetails.text,
        stack: exceptionDetails.exception?.description,
        at: Math.round(timestamp),
      });
    });
  }, [ensureIndexed]);

  const connect = useCallback(
    async (target: DebugTarget) => {
      const key = targetKey(target);
      if (sessions.current.has(key)) {
        activate(key);

        return;
      }

      const wsUrl = targetWsUrl(target);
      if (!wsUrl) {
        setError(`${targetLabel(target)}: no inspector endpoint (started with QAISDEBUGS_INSPECT=0?)`);

        return;
      }
      const agent = target.kind === 'server' ? target.agent : target.agent;
      if (!agent) {
        setError(`${targetLabel(target)}: no running app with the agent matches this page, so its sources cannot be mapped. Start the app with "npx qaisdebugs dev" first.`);

        return;
      }

      setError(undefined);
      let cdp: CdpClient;
      try {
        cdp = await CdpClient.connect(wsUrl);
      } catch (reason) {
        setError(`${targetLabel(target)}: ${reason instanceof Error ? reason.message : String(reason)}`);

        return;
      }

      const session: Session = {
        key,
        target,
        label: targetLabel(target),
        cdp,
        options: { cwd: agent.cwd, repoRoot: agent.repoRoot, packageName: agent.packageName },
        scripts: new Map(),
        scriptsByFile: new Map(),
        status: 'connecting',
        scriptCount: 0,
        instrumentation: false,
        requested: false,
        resumes: 0,
      };
      sessions.current.set(key, session);
      // A new connection becomes the active one unless another session is paused: the pause is
      // what the developer is looking at.
      if (![...sessions.current.values()].some((candidate) => candidate.status === 'paused')) activate(key);
      publish();

      cdp.onClose = (why) => removeSession(key, `connection ${why}`);

      cdp.on('Debugger.scriptParsed', (params) => {
        const { scriptId, url, sourceMapURL, startLine, startColumn } = params as { scriptId: string; url: string; sourceMapURL?: string; startLine?: number; startColumn?: number };
        // React's server-reference stubs are `about://React/Server/...` scripts; nothing to debug there.
        if (!url || url.startsWith('about:')) return;
        const { file, layer } = fileFromScriptUrl(url, session.options);
        const map = file ? undefined : mapLocation(url, sourceMapURL);
        const record: ScriptRecord = { scriptId, url, sourceMapURL: sourceMapURL || undefined, startLine, startColumn, file, layer, map };
        session.scripts.set(scriptId, record);
        session.scriptCount = session.scripts.size;

        if (file || isChunkScript(record)) void applyPendingForScript(session, scriptId).then(() => syncInstrumentation(session));
      });
      cdp.on('Debugger.paused', (params) => handlePaused(session, params));
      // A dev server that exits (a crash, or Next restarting it) waits for every attached debugger
      // to go before it can; leave at once, or it keeps its port and answers nothing.
      cdp.on('NodeRuntime.waitingForDisconnect', () => removeSession(key));
      cdp.on('Debugger.resumed', () => {
        session.resumes += 1;
        session.paused = undefined;
        session.status = 'connected';
        publish();
      });
      forwardPageConsole(session);

      try {
        await cdp.send('Debugger.enable', { maxScriptsCacheSize: 10_000_000 });
        await cdp.send('Debugger.setPauseOnExceptions', { state: pauseOnExceptions });
        if (target.kind === 'page') await cdp.send('Runtime.enable');
        else await cdp.send('NodeRuntime.notifyWhenWaitingForDisconnect', { enabled: true }).catch(() => undefined);
        session.status = 'connected';
        publish();
        for (const breakpoint of breakpointsRef.current) recordIds(key, breakpoint.key, await applyBreakpointTo(session, breakpoint));
        await syncInstrumentation(session);
      } catch (reason) {
        removeSession(key, reason instanceof Error ? reason.message : String(reason));
      }

      // Script counts change constantly; refresh the view a little after the initial flood.
      window.setTimeout(publish, 1500);
    },
    [activate, applyBreakpointTo, applyPendingForScript, forwardPageConsole, handlePaused, pauseOnExceptions, publish, recordIds, removeSession, syncInstrumentation]
  );

  const disconnect = useCallback((key: string) => removeSession(key), [removeSession]);
  const disconnectAll = useCallback(() => {
    for (const key of [...sessions.current.keys()]) removeSession(key);
  }, [removeSession]);

  const toggleBreakpoint = useCallback(
    async (file: string, line: number) => {
      const key = breakpointKey(file, line);
      const existing = breakpointsRef.current.find((breakpoint) => breakpoint.key === key);

      if (existing) {
        for (const [sessionKey, ids] of Object.entries(existing.ids)) {
          const session = sessions.current.get(sessionKey);
          for (const id of ids) void session?.cdp.send('Debugger.removeBreakpoint', { breakpointId: id }).catch(() => undefined);
        }
        updateBreakpoints(breakpointsRef.current.filter((breakpoint) => breakpoint.key !== key));
        for (const session of sessions.current.values()) void syncInstrumentation(session);

        return;
      }

      const breakpoint: Breakpoint = { key, file, line, ids: {} };
      updateBreakpoints([...breakpointsRef.current, breakpoint]);
      for (const session of sessions.current.values()) {
        recordIds(session.key, key, await applyBreakpointTo(session, breakpoint));
        void syncInstrumentation(session);
      }
    },
    [applyBreakpointTo, recordIds, syncInstrumentation, updateBreakpoints]
  );

  const removeBreakpoint = useCallback(
    async (key: string) => {
      const existing = breakpointsRef.current.find((breakpoint) => breakpoint.key === key);
      if (existing) await toggleBreakpoint(existing.file, existing.line);
    },
    [toggleBreakpoint]
  );

  const activeSession = (): Session | undefined => (activeRef.current ? sessions.current.get(activeRef.current) : undefined);

  const command = useCallback((method: string) => {
    const session = activeSession();
    if (!session) return;
    session.requested = method !== 'Debugger.resume';
    void session.cdp.send(method).catch((reason) => setError(`${session.label}: ${reason instanceof Error ? reason.message : String(reason)}`));
  }, []);

  const setPauseOnExceptions = useCallback((state: 'none' | 'uncaught' | 'all') => {
    setPauseOnExceptionsState(state);
    for (const session of sessions.current.values()) void session.cdp.send('Debugger.setPauseOnExceptions', { state }).catch(() => undefined);
  }, []);

  const getProperties = useCallback(async (objectId: string): Promise<PropertyDescriptor[]> => {
    const session = activeSession();
    if (!session) return [];
    const result = await session.cdp.send<{ result: PropertyDescriptor[] }>('Runtime.getProperties', { objectId, ownProperties: true, generatePreview: true });

    return result.result.filter((property) => property.value || property.get);
  }, []);

  const evaluate = useCallback(async (expression: string, options?: { sideEffectFree?: boolean }): Promise<RemoteObject> => {
    const session = activeSession();
    if (!session) throw new Error('not connected');
    const frame = session.paused?.frames[session.paused.selected];
    const throwOnSideEffect = Boolean(options?.sideEffectFree);
    const result = frame
      ? await session.cdp.send<{ result: RemoteObject; exceptionDetails?: { text: string; exception?: RemoteObject } }>('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId, expression, generatePreview: true, throwOnSideEffect })
      : await session.cdp.send<{ result: RemoteObject; exceptionDetails?: { text: string; exception?: RemoteObject } }>('Runtime.evaluate', { expression, generatePreview: true, throwOnSideEffect });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);

    return result.result;
  }, []);

  const selectFrame = useCallback(
    (index: number) => {
      const session = activeSession();
      if (!session?.paused) return;
      session.paused = { ...session.paused, selected: index };
      publish();
      const frame = session.paused.frames[index];
      if (frame?.file && frame.line) onPausedAtRef.current?.(frame.file, frame.line);
    },
    [publish]
  );

  useEffect(() => () => disconnectAll(), [disconnectAll]);

  const active = useMemo(() => views.find((view) => view.key === activeKey), [views, activeKey]);

  return useMemo(
    () => ({
      sessions: views,
      active,
      error,
      breakpoints,
      pauseOnExceptions,
      connect,
      disconnect,
      disconnectAll,
      setActive: activate,
      toggleBreakpoint,
      removeBreakpoint,
      resume: () => command('Debugger.resume'),
      pause: () => command('Debugger.pause'),
      stepOver: () => command('Debugger.stepOver'),
      stepInto: () => command('Debugger.stepInto'),
      stepOut: () => command('Debugger.stepOut'),
      selectFrame,
      setPauseOnExceptions,
      getProperties,
      evaluate,
    }),
    [views, active, error, breakpoints, pauseOnExceptions, connect, disconnect, disconnectAll, activate, toggleBreakpoint, removeBreakpoint, command, selectFrame, setPauseOnExceptions, getProperties, evaluate]
  );
}
