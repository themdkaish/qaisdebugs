/**
 * QaisDebugs — the debugger for the MCP server: the inspector page's debugger without React.
 *
 * It connects to every dev server's Node inspector and to the tabs of the qaisdebugs Chrome that
 * show one of those apps, keeps one set of breakpoints by original file and line, places them in
 * every session that has the file (through the same source-map helpers as the inspector page), and
 * reports the first pause as the original file, line, call stack and variables. It connects only
 * when a debugger tool is used, so reading network and logs never attaches a debugger.
 */
import type { ParseStackOptions } from '../agent/shared/initiator.js';
import type { AgentEvent } from '../agent/shared/events.js';
import { CdpClient } from '../ui/src/debugger/cdp';
import { type PropertyDescriptor, type RemoteObject, describe } from '../ui/src/debugger/remoteObject';
import { type ScriptRecord, fileFromScriptUrl, generatedPosition, isChunkScript, loadSources, mapLocation, originalPosition } from '../ui/src/debugger/sourceMaps';
import { type PageTarget, agentServingPage } from '../ui/src/debugger/targets';

export interface Breakpoint {
  file: string;
  line: number;
  condition?: string;
  /** CDP breakpoint ids per session. None anywhere: the line is not loaded yet, or has no code. */
  ids: Map<string, string[]>;
}

export interface Frame {
  callFrameId: string;
  functionName: string;
  file?: string;
  line?: number;
  column?: number;
  isApp: boolean;
  scopes: Array<{ type: string; objectId?: string }>;
}

export interface Pause {
  sessionKey: string;
  label: string;
  reason: string;
  frames: Frame[];
  /** The first frame in the app's own code. */
  selected: number;
  exception?: string;
  at: number;
}

interface Session {
  key: string;
  label: string;
  cdp: CdpClient;
  options: ParseStackOptions;
  scripts: Map<string, ScriptRecord>;
  scriptsByFile: Map<string, Set<string>>;
  /** Scripts whose files are still being worked out (a chunk's map is fetched for that). */
  indexing: Set<Promise<void>>;
  instrumentation: boolean;
  pause?: Pause;
}

interface RawCallFrame {
  callFrameId: string;
  functionName: string;
  location: { scriptId: string; lineNumber: number; columnNumber?: number };
  scopeChain: Array<{ type: string; object: RemoteObject }>;
}

const key = (file: string, line: number): string => `${file}:${line}`;

/** Names the bundler and React Refresh put in scope, which say nothing about the app. */
const BUNDLER_NAME = /^(__TURBOPACK__|__webpack_|__next_|_s\d*$|_c\d*$|\$Refresh|require$|module$|exports$|__dirname$|__filename$|__N_SSG$|__N_SSP$)/;

/** A variable's value in one line; functions by name only, not their source. */
export function describeValue(value: RemoteObject | undefined): string {
  if (value?.type === 'function') {
    const name = /^(?:async\s+)?function\*?\s*([\w$]*)/.exec(value.description ?? '')?.[1];

    return `ƒ ${name || 'anonymous'}()`;
  }

  return describe(value);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class Debugger {
  readonly breakpoints = new Map<string, Breakpoint>();
  private readonly sessions = new Map<string, Session>();
  private readonly connecting = new Set<string>();
  private readonly pauseWaiters = new Set<(pause: Pause) => void>();
  private pauseOnExceptions: 'none' | 'uncaught' | 'all' = 'none';
  private refresher?: ReturnType<typeof setInterval>;
  lastError?: string;

  constructor(
    private readonly agents: () => AgentEvent[],
    private readonly pages: () => Promise<PageTarget[]>
  ) {}

  /** Connects to every dev server and app tab not connected yet, and keeps doing so every 3 s. */
  async attach(): Promise<void> {
    if (typeof WebSocket === 'undefined') throw new Error('the debugger tools need Node 22 or later (no WebSocket in this Node)');
    await this.connectAll();
    if (!this.refresher) {
      this.refresher = setInterval(() => void this.connectAll(), 3000);
      this.refresher.unref?.();
    }
  }

  sessionLabels(): string[] {
    return [...this.sessions.values()].map((session) => session.label);
  }

  currentPause(): Pause | undefined {
    const paused = [...this.sessions.values()].map((session) => session.pause).filter((pause): pause is Pause => Boolean(pause));

    return paused.sort((a, b) => b.at - a.at)[0];
  }

  waitForPause(timeoutMs: number): Promise<Pause | undefined> {
    const current = this.currentPause();
    if (current) return Promise.resolve(current);

    return new Promise((resolve) => {
      const done = (pause: Pause | undefined): void => {
        clearTimeout(timer);
        this.pauseWaiters.delete(onPause);
        resolve(pause);
      };
      const onPause = (pause: Pause): void => done(pause);
      const timer = setTimeout(() => done(undefined), timeoutMs);
      this.pauseWaiters.add(onPause);
    });
  }

  async setBreakpoint(file: string, line: number, condition?: string): Promise<Breakpoint> {
    await this.attach();
    const existing = this.breakpoints.get(key(file, line));
    if (existing) await this.removeBreakpoint(file, line);
    const breakpoint: Breakpoint = { file, line, condition, ids: new Map() };
    this.breakpoints.set(key(file, line), breakpoint);
    for (const session of this.sessions.values()) {
      this.record(session, breakpoint, await this.place(session, breakpoint));
      await this.syncInstrumentation(session);
    }

    return breakpoint;
  }

  async removeBreakpoint(file: string, line: number): Promise<boolean> {
    const breakpoint = this.breakpoints.get(key(file, line));
    if (!breakpoint) return false;
    for (const [sessionKey, ids] of breakpoint.ids) {
      const session = this.sessions.get(sessionKey);
      for (const id of ids) await session?.cdp.send('Debugger.removeBreakpoint', { breakpointId: id }).catch(() => undefined);
    }
    this.breakpoints.delete(key(file, line));
    for (const session of this.sessions.values()) await this.syncInstrumentation(session);

    return true;
  }

  async removeAll(): Promise<number> {
    const all = [...this.breakpoints.values()];
    for (const breakpoint of all) await this.removeBreakpoint(breakpoint.file, breakpoint.line);

    return all.length;
  }

  /** Where each breakpoint is placed: session labels, or none yet. */
  placements(breakpoint: Breakpoint): string[] {
    return [...breakpoint.ids.entries()].filter(([, ids]) => ids.length).map(([sessionKey]) => this.sessions.get(sessionKey)?.label ?? sessionKey);
  }

  async setPauseOnExceptions(state: 'none' | 'uncaught' | 'all'): Promise<void> {
    await this.attach();
    this.pauseOnExceptions = state;
    for (const session of this.sessions.values()) await session.cdp.send('Debugger.setPauseOnExceptions', { state }).catch(() => undefined);
  }

  /** resume, over, into, out or pause, on the paused session (or every session for pause). */
  async step(action: 'resume' | 'over' | 'into' | 'out' | 'pause'): Promise<void> {
    if (action === 'pause') {
      await this.attach();
      for (const session of this.sessions.values()) await session.cdp.send('Debugger.pause').catch(() => undefined);

      return;
    }
    const pause = this.currentPause();
    if (!pause) throw new Error('nothing is paused');
    const session = this.sessions.get(pause.sessionKey);
    const method = { resume: 'Debugger.resume', over: 'Debugger.stepOver', into: 'Debugger.stepInto', out: 'Debugger.stepOut' }[action];
    if (session) session.pause = undefined;
    await session?.cdp.send(method);
  }

  /** Variables of a paused frame: every scope but the global one, values described in one line each. */
  async variables(frameIndex: number, maxPerScope = 40): Promise<Array<{ scope: string; names: Array<[string, string]> }>> {
    const pause = this.currentPause();
    const frame = pause?.frames[frameIndex];
    const session = pause && this.sessions.get(pause.sessionKey);
    if (!frame || !session) return [];
    const out: Array<{ scope: string; names: Array<[string, string]> }> = [];
    for (const scope of frame.scopes) {
      if (scope.type === 'global' || !scope.objectId) continue;
      const result = await session.cdp
        .send<{ result: PropertyDescriptor[] }>('Runtime.getProperties', { objectId: scope.objectId, ownProperties: true, generatePreview: true })
        .catch(() => ({ result: [] as PropertyDescriptor[] }));
      const names = result.result
        .filter((property) => property.value && !BUNDLER_NAME.test(property.name))
        .slice(0, maxPerScope)
        .map((property): [string, string] => [property.name, describeValue(property.value)]);
      if (names.length) out.push({ scope: scope.type, names });
    }

    return out;
  }

  /** Evaluates in the paused frame. The value comes back as JSON when it can, else as a summary. */
  async evaluate(expression: string, frameIndex?: number): Promise<string> {
    const pause = this.currentPause();
    if (!pause) throw new Error('nothing is paused: set a breakpoint and wait for the pause first');
    const session = this.sessions.get(pause.sessionKey);
    const frame = pause.frames[frameIndex ?? pause.selected];
    if (!session || !frame) throw new Error('that frame does not exist');
    type Evaluated = { result: RemoteObject; exceptionDetails?: { text: string; exception?: RemoteObject } };
    const run = (returnByValue: boolean): Promise<Evaluated> =>
      session.cdp.send<Evaluated>('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId, expression, generatePreview: true, returnByValue });
    let result = await run(true).catch(() => undefined);
    if (!result || (result.result.type === 'object' && result.result.value === undefined && result.result.subtype !== 'null')) result = await run(false);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    const value = result.result;
    if (value.value !== undefined && typeof value.value === 'object') return JSON.stringify(value.value, null, 2);

    return describe(value);
  }

  close(): void {
    if (this.refresher) clearInterval(this.refresher);
    for (const session of this.sessions.values()) session.cdp.close();
    this.sessions.clear();
  }

  // ---- sessions ------------------------------------------------------------------------------

  private async connectAll(): Promise<void> {
    const agents = this.agents();
    const targets: Array<{ key: string; label: string; wsUrl: string; agent: AgentEvent; page: boolean }> = [];
    for (const agent of agents) {
      if (agent.inspectorUrl) targets.push({ key: `server:${agent.app}:${agent.pid}`, label: `${agent.app} server (pid ${agent.pid})`, wsUrl: agent.inspectorUrl, agent, page: false });
    }
    for (const page of await this.pages().catch(() => [])) {
      const agent = agentServingPage(page, agents);
      if (agent) targets.push({ key: `page:${page.id}`, label: `${agent.app} page ${page.url}`, wsUrl: page.wsUrl, agent, page: true });
    }
    // Sessions whose process or tab is gone.
    for (const [sessionKey, session] of this.sessions) {
      if (!targets.some((target) => target.key === sessionKey)) {
        session.cdp.close();
        this.sessions.delete(sessionKey);
      }
    }
    await Promise.all(targets.filter((target) => !this.sessions.has(target.key) && !this.connecting.has(target.key)).map((target) => this.connect(target)));
  }

  private async connect(target: { key: string; label: string; wsUrl: string; agent: AgentEvent; page: boolean }): Promise<void> {
    this.connecting.add(target.key);
    try {
      const cdp = await CdpClient.connect(target.wsUrl);
      const session: Session = {
        key: target.key,
        label: target.label,
        cdp,
        options: { cwd: target.agent.cwd, repoRoot: target.agent.repoRoot, packageName: target.agent.packageName },
        scripts: new Map(),
        scriptsByFile: new Map(),
        indexing: new Set(),
        instrumentation: false,
      };
      this.sessions.set(target.key, session);
      cdp.onClose = () => this.sessions.delete(target.key);
      cdp.on('Debugger.scriptParsed', (params) => {
        const { scriptId, url, sourceMapURL } = params as { scriptId: string; url: string; sourceMapURL?: string };
        if (!url || url.startsWith('about:')) return;
        const { file, layer } = fileFromScriptUrl(url, session.options);
        const map = file ? undefined : mapLocation(url, sourceMapURL);
        session.scripts.set(scriptId, { scriptId, url, sourceMapURL: sourceMapURL || undefined, file, layer, map });
        if (file || map) {
          const indexed = this.placePending(session, scriptId)
            .then(() => this.syncInstrumentation(session))
            .finally(() => session.indexing.delete(indexed));
          session.indexing.add(indexed);
        }
      });
      cdp.on('Debugger.paused', (params) => void this.onPaused(session, params));
      cdp.on('Debugger.resumed', () => {
        session.pause = undefined;
      });
      await cdp.send('Debugger.enable', { maxScriptsCacheSize: 10_000_000 });
      await this.settle(session);
      await cdp.send('Debugger.setPauseOnExceptions', { state: this.pauseOnExceptions });
      for (const breakpoint of this.breakpoints.values()) this.record(session, breakpoint, await this.place(session, breakpoint));
      await this.syncInstrumentation(session);
    } catch (reason) {
      this.lastError = `${target.label}: ${reason instanceof Error ? reason.message : String(reason)}`;
      this.sessions.delete(target.key);
    } finally {
      this.connecting.delete(target.key);
    }
  }

  /**
   * Waits (up to 5 s) for the scripts already loaded to be reported and indexed after connecting,
   * so a breakpoint set right away finds the file instead of reporting it as not loaded.
   */
  private async settle(session: Session): Promise<void> {
    const deadline = Date.now() + 5000;
    let seen = -1;
    while (Date.now() < deadline && (seen !== session.scripts.size || session.indexing.size)) {
      seen = session.scripts.size;
      await sleep(250);
      await Promise.all([...session.indexing]);
    }
  }

  // ---- breakpoints ---------------------------------------------------------------------------

  private async place(session: Session, breakpoint: Breakpoint): Promise<string[]> {
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
          condition: breakpoint.condition,
        });
        ids.push(result.breakpointId);
      } catch {
        // Already placed at that position by an earlier pass.
      }
    }

    return ids;
  }

  private record(session: Session, breakpoint: Breakpoint, ids: string[]): void {
    if (!ids.length) return;
    breakpoint.ids.set(session.key, [...new Set([...(breakpoint.ids.get(session.key) ?? []), ...ids])]);
  }

  /** The application files a script holds, registered the first time it is seen. */
  private async indexScript(session: Session, scriptId: string): Promise<string[]> {
    const script = session.scripts.get(scriptId);
    if (!script) return [];
    const files = script.file
      ? [script.file]
      : isChunkScript(script)
        ? (await loadSources(script, session.options).catch(() => [])).map((source) => source.file).filter((file) => !file.includes('/node_modules/'))
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
  }

  private async placePending(session: Session, scriptId: string): Promise<void> {
    const files = await this.indexScript(session, scriptId);
    for (const breakpoint of this.breakpoints.values()) {
      if (files.includes(breakpoint.file)) this.record(session, breakpoint, await this.place(session, breakpoint));
    }
  }

  /**
   * While a breakpoint is unplaced in a session, V8 pauses before each source-mapped script runs,
   * so a breakpoint set before a reload is placed in time for the first render.
   */
  private async syncInstrumentation(session: Session): Promise<void> {
    const wanted = [...this.breakpoints.values()].some((breakpoint) => !(breakpoint.ids.get(session.key) ?? []).length);
    if (wanted === session.instrumentation) return;
    try {
      if (wanted) await session.cdp.send('Debugger.setInstrumentationBreakpoint', { instrumentation: 'beforeScriptWithSourceMapExecution' });
      else await session.cdp.send('Debugger.removeInstrumentationBreakpoint', { instrumentation: 'beforeScriptWithSourceMapExecution' });
      session.instrumentation = wanted;
    } catch {
      // Older targets: breakpoints still arrive through scriptParsed.
    }
  }

  // ---- pauses --------------------------------------------------------------------------------

  private async onPaused(session: Session, params: unknown): Promise<void> {
    const { reason: rawReason, callFrames, data, hitBreakpoints } = params as { reason: string; callFrames: RawCallFrame[]; data?: RemoteObject & { scriptId?: string }; hitBreakpoints?: string[] };
    if (rawReason === 'instrumentation') {
      // Another debugger (the inspector page) asked for this pause; it resumes when it is done.
      if (!session.instrumentation) return;
      if (data?.scriptId) await this.placePending(session, data.scriptId).catch(() => undefined);
      await session.cdp.send('Debugger.resume').catch(() => undefined);
      await this.syncInstrumentation(session);

      return;
    }

    const frames = await Promise.all(
      callFrames.map(async (frame): Promise<Frame> => {
        const script = session.scripts.get(frame.location.scriptId);
        const worthMapping = script && (!isChunkScript(script) || (await this.indexScript(session, frame.location.scriptId)).length > 0);
        const original = script && worthMapping ? await originalPosition(script, frame.location.lineNumber, frame.location.columnNumber ?? 0, session.options).catch(() => undefined) : undefined;

        return {
          callFrameId: frame.callFrameId,
          functionName: frame.functionName || '(anonymous)',
          file: original?.file,
          line: original?.line,
          column: original?.column,
          isApp: Boolean(original?.file && !original.file.includes('/node_modules/') && !original.file.includes('/.next/')),
          scopes: frame.scopeChain.map((scope) => ({ type: scope.type, objectId: scope.object.objectId })),
        };
      })
    );
    const pause: Pause = {
      sessionKey: session.key,
      label: session.label,
      reason: hitBreakpoints?.length ? 'breakpoint' : rawReason,
      frames,
      selected: Math.max(0, frames.findIndex((frame) => frame.isApp)),
      exception: rawReason === 'exception' ? describe(data) : undefined,
      at: Date.now(),
    };
    session.pause = pause;
    for (const waiter of [...this.pauseWaiters]) waiter(pause);
  }
}
