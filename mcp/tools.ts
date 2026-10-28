/**
 * QaisDebugs — the MCP tools: everything the inspector shows (requests, traces, logs, errors,
 * source files) and everything it does (clear, open a page in the qaisdebugs Chrome, breakpoints,
 * stepping, evaluating), as tools a model can call.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { DevtoolsEvent, ErrorEvent, LogEvent, RequestEvent } from '../agent/shared/events.js';
import type { PageTarget } from '../ui/src/debugger/targets';
import type { Debugger, Pause } from './debugger';
import { clock, logLine, relative, requestDetail, requestLine, traceTree } from './format';
import { type ToolDefinition, type ToolHandler, type ToolResult, failure, text } from './protocol';
import type { EventStore } from './store';

export interface ToolContext {
  store: EventStore;
  debugger: Debugger;
  collectorUrl: string;
  fetchImpl?: typeof fetch;
}

const ORIGINS = ['page', 'browser', 'server', 'external', 'other'] as const;
const LEVEL_ORDER = ['debug', 'log', 'info', 'warn', 'error'];

// ---- argument helpers ------------------------------------------------------------------------

const str = (args: Record<string, unknown>, name: string): string | undefined => (typeof args[name] === 'string' && args[name] !== '' ? (args[name] as string) : undefined);
const num = (args: Record<string, unknown>, name: string, fallback: number, max: number): number => {
  const value = Number(args[name]);

  return Number.isFinite(value) && value > 0 ? Math.min(value, max) : fallback;
};
const contains = (haystack: string | undefined, needle: string | undefined): boolean => !needle || (haystack ?? '').toLowerCase().includes(needle.toLowerCase());

export function statusMatches(event: RequestEvent, wanted: string | undefined): boolean {
  if (!wanted) return true;
  if (wanted === 'error') return Boolean(event.error) || (event.status ?? 0) >= 400;
  if (/^[1-5]xx$/.test(wanted)) return Math.floor((event.status ?? 0) / 100) === Number(wanted[0]);

  return String(event.status) === wanted;
}

function sinceFilter(args: Record<string, unknown>): (at: number) => boolean {
  const seconds = Number(args.since_seconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return () => true;
  const from = Date.now() - seconds * 1000;

  return (at) => at >= from;
}

// ---- the tools -------------------------------------------------------------------------------

export function createTools(context: ToolContext): { tools: ToolDefinition[]; handlers: Map<string, ToolHandler> } {
  const { store, collectorUrl } = context;
  const fetchImpl = context.fetchImpl ?? fetch;
  let repoRootCache: string | undefined;

  const notRunning = (): ToolResult =>
    failure(`qaisdebugs is not running at ${collectorUrl}. Start the app with \`qaisdebugs dev\` in its folder (or \`qaisdebugs\` for the inspector alone), then try again.`);

  const repoRoot = async (): Promise<string | undefined> => {
    if (repoRootCache) return repoRootCache;
    try {
      const payload = (await (await fetchImpl(`${collectorUrl}/sources/tree`)).json()) as { repoRoot?: string };
      repoRootCache = payload.repoRoot;
    } catch {
      return store.agents[0]?.repoRoot ?? store.agents[0]?.cwd;
    }

    return repoRootCache;
  };

  /** A file the model named: absolute, relative to the repository, or relative to an app folder. */
  const resolveFile = async (file: string): Promise<string> => {
    if (path.isAbsolute(file)) return file;
    const candidates = [await repoRoot(), ...store.agents.map((agent) => agent.cwd)].filter((dir): dir is string => Boolean(dir)).map((dir) => path.resolve(dir, file));

    return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0] ?? path.resolve(file);
  };

  const chromeTargets = async (): Promise<{ running: boolean; port?: number; targets: PageTarget[] }> => {
    try {
      return (await (await fetchImpl(`${collectorUrl}/chrome/targets`)).json()) as { running: boolean; port?: number; targets: PageTarget[] };
    } catch {
      return { running: false, targets: [] };
    }
  };

  const requests = (): RequestEvent[] => store.events.filter((event): event is RequestEvent => event.kind === 'request');
  const logsAndErrors = (): Array<LogEvent | ErrorEvent> => store.events.filter((event): event is LogEvent | ErrorEvent => event.kind === 'log' || event.kind === 'error');

  const describePause = async (pause: Pause, frameIndex = pause.selected): Promise<string> => {
    const root = await repoRoot();
    const top = pause.frames[frameIndex];
    const lines = [
      `PAUSED (${pause.reason}) in ${pause.label}${top?.file ? ` at ${relative(top.file, root)}:${top.line} in ${top.functionName}` : ''}`,
      ...(pause.exception ? [`exception: ${pause.exception}`] : []),
      'call stack (app frames; #n is the frame index for evaluate and get_pause):',
    ];
    let hidden = 0;
    pause.frames.forEach((frame, index) => {
      if (!frame.isApp) {
        hidden += 1;

        return;
      }
      lines.push(`  #${index}${index === frameIndex ? ' ▶' : ''} ${frame.functionName}  ${frame.file ? `${relative(frame.file, root)}:${frame.line}` : ''}`);
    });
    if (hidden) lines.push(`  (${hidden} framework frames not shown)`);
    const scopes = await context.debugger.variables(frameIndex);
    for (const scope of scopes) {
      lines.push(`${scope.scope} variables:`);
      for (const [name, value] of scope.names) lines.push(`  ${name} = ${value.length > 300 ? `${value.slice(0, 300)}…` : value}`);
    }
    lines.push('', 'The app is frozen while paused. Use evaluate to inspect values, step to move on, and step with action "resume" when done.');

    return lines.join('\n');
  };

  const tools: ToolDefinition[] = [];
  const handlers = new Map<string, ToolHandler>();
  const tool = (definition: ToolDefinition, handler: ToolHandler): void => {
    tools.push(definition);
    handlers.set(definition.name, async (args) => {
      await store.ready();

      return handler(args);
    });
  };
  const readOnly = { readOnlyHint: true, openWorldHint: false };

  // -- overview --------------------------------------------------------------------------------

  tool(
    {
      name: 'status',
      title: 'What is running',
      description: 'Shows whether qaisdebugs is running, which Next.js dev servers report to it (app, pid, port, folder), the qaisdebugs Chrome and its tabs, how many requests and logs are recorded, and the debugger state. Call this first.',
      inputSchema: { type: 'object', properties: {} },
      annotations: readOnly,
    },
    async () => {
      if (!store.connected) return notRunning();
      const root = await repoRoot();
      const chrome = await chromeTargets();
      const counts = { requests: 0, logs: 0, errors: 0 };
      for (const event of store.events) {
        if (event.kind === 'request') counts.requests += 1;
        else if (event.kind === 'log') counts.logs += 1;
        else if (event.kind === 'error') counts.errors += 1;
      }
      const pause = context.debugger.currentPause();
      const lines = [
        `qaisdebugs is running at ${collectorUrl} (inspector page there too). Repository: ${root ?? 'unknown'}`,
        `recorded: ${counts.requests} requests, ${counts.logs} log lines, ${counts.errors} uncaught errors`,
        `dev servers (${store.agents.length}):`,
        ...(store.agents.length
          ? store.agents.map((agent) => `  ${agent.app}  pid ${agent.pid}  ${agent.devServerPort ? `http://localhost:${agent.devServerPort}` : 'port unknown'}  ${relative(agent.cwd, root) || agent.cwd}`)
          : ['  none: start the app with `qaisdebugs dev`']),
        chrome.running
          ? `qaisdebugs Chrome on port ${chrome.port}, ${chrome.targets.length} tab(s):${chrome.targets.map((target) => `\n  ${target.url}`).join('')}`
          : 'qaisdebugs Chrome: not running (needed only to pause client components; open_page starts it)',
        `debugger: ${context.debugger.sessionLabels().length ? `connected to ${context.debugger.sessionLabels().join(', ')}` : 'not connected (connects when a breakpoint is set)'}; ${context.debugger.breakpoints.size} breakpoint(s)${pause ? `; PAUSED in ${pause.label}` : ''}`,
      ];

      return text(lines.join('\n'));
    }
  );

  // -- network ---------------------------------------------------------------------------------

  tool(
    {
      name: 'list_requests',
      title: 'List network requests',
      description:
        'Lists recorded requests, oldest first, one line each: id, time, app, origin, method, status, duration, URL and the file:line that made the call. Origins: page (document and RSC loads), browser (calls from client code, "+page" when the page script saw it too), server (the server calling itself), external (server calls to other hosts), other (framework housekeeping, hidden unless asked). Use get_request with an id for headers and bodies.',
      inputSchema: {
        type: 'object',
        properties: {
          app: { type: 'string', description: 'Only this app (as shown by status).' },
          origin: { type: 'string', enum: [...ORIGINS], description: 'Only this origin.' },
          method: { type: 'string', description: 'GET, POST, …' },
          status: { type: 'string', description: '"error" (failed or 4xx/5xx), "2xx".."5xx", or an exact code like "404".' },
          url: { type: 'string', description: 'Text the URL contains.' },
          page: { type: 'string', description: 'Text the page path contains (the page the request belongs to).' },
          since_seconds: { type: 'number', description: 'Only the last N seconds.' },
          limit: { type: 'number', description: 'How many of the most recent matches (default 30, max 200).' },
        },
      },
      annotations: readOnly,
    },
    async (args) => {
      if (!store.connected && !store.events.length) return notRunning();
      const root = await repoRoot();
      const origin = str(args, 'origin');
      const method = str(args, 'method')?.toUpperCase();
      const since = sinceFilter(args);
      const matches = requests().filter(
        (event) =>
          (origin ? event.origin === origin : event.origin !== 'other') &&
          (!str(args, 'app') || event.app === str(args, 'app')) &&
          (!method || event.method === method) &&
          statusMatches(event, str(args, 'status')) &&
          contains(event.url, str(args, 'url')) &&
          contains(event.pagePath, str(args, 'page')) &&
          since(event.startedAt)
      );
      const limit = num(args, 'limit', 30, 200);
      const shown = matches.slice(-limit);
      if (!shown.length) return text('No requests match. Reproduce the problem in the app (or use wait_for), then list again.');

      return text([`${matches.length} request(s) match${matches.length > shown.length ? `, showing the last ${shown.length}` : ''}:`, ...shown.map((event) => requestLine(event, root))].join('\n'));
    }
  );

  tool(
    {
      name: 'get_request',
      title: 'Request details',
      description: 'Everything about one request: URL, status, timing, the file:line and call stack that made it, request and response headers and bodies (passwords, tokens and cookies are masked), and the calls the server made while handling it.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The id from list_requests (the 8-character prefix is enough).' },
          max_body_chars: { type: 'number', description: 'Cut each body after this many characters (default 6000, max 100000).' },
        },
        required: ['id'],
      },
      annotations: readOnly,
    },
    async (args) => {
      const event = store.find(String(args.id ?? ''));
      if (!event || event.kind !== 'request') return failure(`no request with id ${String(args.id)}; ids come from list_requests`);
      const children = requests().filter((candidate) => candidate.parentId === event.id);

      return text(requestDetail(event, children, await repoRoot(), num(args, 'max_body_chars', 6000, 100_000)));
    }
  );

  tool(
    {
      name: 'get_trace',
      title: 'Request trace',
      description: 'The whole tree of one page load or API call: the request from the browser, the calls the server made to itself and to external APIs, nested, plus the log lines written while it ran.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'A request id (any request in the trace) or a trace id.' } },
        required: ['id'],
      },
      annotations: readOnly,
    },
    async (args) => {
      const id = String(args.id ?? '');
      const event = store.find(id);
      const traceId = event && 'traceId' in event && event.traceId ? event.traceId : store.events.find((candidate) => candidate.traceId?.startsWith(id))?.traceId;
      if (!traceId) return failure(`no trace for ${id}`);

      return text(traceTree(store.events, traceId, await repoRoot()));
    }
  );

  // -- logs and errors -------------------------------------------------------------------------

  tool(
    {
      name: 'list_logs',
      title: 'List logs',
      description: 'Server and browser console output and uncaught errors, oldest first, with the file:line that wrote each line.',
      inputSchema: {
        type: 'object',
        properties: {
          app: { type: 'string' },
          origin: { type: 'string', enum: ['server', 'browser'] },
          level: { type: 'string', enum: ['debug', 'log', 'info', 'warn', 'error'], description: 'This level and above.' },
          text: { type: 'string', description: 'Text the line contains.' },
          since_seconds: { type: 'number' },
          limit: { type: 'number', description: 'Default 50, max 300.' },
        },
      },
      annotations: readOnly,
    },
    async (args) => {
      if (!store.connected && !store.events.length) return notRunning();
      const root = await repoRoot();
      const minimum = LEVEL_ORDER.indexOf(str(args, 'level') ?? 'debug');
      const since = sinceFilter(args);
      const matches = logsAndErrors().filter(
        (event) =>
          (!str(args, 'app') || event.app === str(args, 'app')) &&
          (!str(args, 'origin') || event.origin === str(args, 'origin')) &&
          (event.kind === 'error' || LEVEL_ORDER.indexOf(event.level) >= minimum) &&
          contains(logLine(event, root), str(args, 'text')) &&
          since(event.at)
      );
      const limit = num(args, 'limit', 50, 300);
      const shown = matches.slice(-limit);
      if (!shown.length) return text('No log lines match.');

      return text([`${matches.length} line(s) match${matches.length > shown.length ? `, showing the last ${shown.length}` : ''}:`, ...shown.map((event) => logLine(event, root))].join('\n'));
    }
  );

  tool(
    {
      name: 'list_problems',
      title: 'What went wrong',
      description: 'Everything that went wrong, newest last: uncaught errors, console.error and console.warn lines, and failed requests (network errors, 4xx and 5xx), each with where it came from. A good first call when the user reports a bug.',
      inputSchema: {
        type: 'object',
        properties: {
          app: { type: 'string' },
          since_seconds: { type: 'number', description: 'Only the last N seconds (default: everything recorded).' },
          limit: { type: 'number', description: 'Per section, default 25, max 200.' },
        },
      },
      annotations: readOnly,
    },
    async (args) => {
      if (!store.connected && !store.events.length) return notRunning();
      const root = await repoRoot();
      const since = sinceFilter(args);
      const limit = num(args, 'limit', 25, 200);
      const ofApp = (event: DevtoolsEvent): boolean => !str(args, 'app') || event.app === str(args, 'app');
      const failed = requests().filter((event) => ofApp(event) && event.origin !== 'other' && statusMatches(event, 'error') && since(event.startedAt));
      const problems = logsAndErrors().filter((event) => ofApp(event) && since(event.at) && (event.kind === 'error' || event.level === 'error' || event.level === 'warn'));
      const sections = [
        `failed requests (${failed.length}):`,
        ...(failed.length ? failed.slice(-limit).map((event) => `  ${requestLine(event, root)}`) : ['  none']),
        `errors and warnings (${problems.length}):`,
        ...(problems.length ? problems.slice(-limit).map((event) => `  ${logLine(event, root)}`) : ['  none']),
      ];

      return text(sections.join('\n'));
    }
  );

  tool(
    {
      name: 'wait_for',
      title: 'Wait for activity',
      description: 'Waits for the next request, log line or error that matches, for example while the user reproduces a bug in the app, and returns it in full. Only events from now on count.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['request', 'log', 'error', 'any'], description: 'Default "any". "error" also matches failed requests and console.error.' },
          text: { type: 'string', description: 'Text the URL (requests) or the line (logs) contains.' },
          app: { type: 'string' },
          timeout_seconds: { type: 'number', description: 'Default 60, max 300.' },
        },
      },
      annotations: readOnly,
    },
    async (args) => {
      if (!store.connected) return notRunning();
      const root = await repoRoot();
      const kind = str(args, 'kind') ?? 'any';
      const wanted = str(args, 'text');
      const matches = (event: DevtoolsEvent): boolean => {
        if (str(args, 'app') && event.app !== str(args, 'app')) return false;
        if (event.kind === 'request') {
          if (event.origin === 'other') return false;
          if (kind === 'log') return false;
          if (kind === 'error' && !statusMatches(event, 'error')) return false;

          return contains(event.url, wanted);
        }
        if (event.kind === 'log' || event.kind === 'error') {
          if (kind === 'request') return false;
          if (kind === 'error' && event.kind === 'log' && event.level !== 'error') return false;

          return contains(logLine(event, root), wanted);
        }

        return false;
      };
      const timeout = num(args, 'timeout_seconds', 60, 300);
      const event = await store.waitFor(matches, timeout * 1000);
      if (!event) return text(`Nothing matching arrived in ${timeout} s.`);
      if (event.kind === 'request') {
        // Give the other half of the request (page or server) a moment to arrive and merge.
        await new Promise((resolve) => setTimeout(resolve, 400));
        const merged = store.find(event.id) as RequestEvent;

        return text(requestDetail(merged, requests().filter((candidate) => candidate.parentId === merged.id), root, 6000));
      }

      return text(logLine(event as LogEvent | ErrorEvent, root));
    }
  );

  tool(
    {
      name: 'clear',
      title: 'Clear recorded events',
      description: 'Forgets every recorded request and log line (in the inspector page too), so the next reproduction starts from a clean slate.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const response = await fetchImpl(`${collectorUrl}/clear`, { method: 'POST' });
        if (!response.ok) return failure(`the collector answered ${response.status}`);
      } catch {
        return notRunning();
      }
      store.clear();

      return text(`Cleared at ${clock(Date.now())}. Ask the user to reproduce the problem, then use list_problems, list_requests or wait_for.`);
    }
  );

  // -- source code -----------------------------------------------------------------------------

  tool(
    {
      name: 'find_files',
      title: 'Find source files',
      description: "Finds source files in the app's repository whose path contains the text (case-insensitive).",
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Part of the path or file name, e.g. "borrowVehicle".' }, limit: { type: 'number', description: 'Default 50, max 300.' } },
        required: ['query'],
      },
      annotations: readOnly,
    },
    async (args) => {
      let payload: { repoRoot: string; tree: Array<{ path: string; children?: unknown[] }> };
      try {
        payload = (await (await fetchImpl(`${collectorUrl}/sources/tree`)).json()) as typeof payload;
      } catch {
        return notRunning();
      }
      const files: string[] = [];
      const walk = (nodes: Array<{ path: string; children?: unknown[] }>): void => {
        for (const node of nodes) {
          if (node.children) walk(node.children as Array<{ path: string; children?: unknown[] }>);
          else files.push(node.path);
        }
      };
      walk(payload.tree);
      const query = String(args.query ?? '').toLowerCase();
      const matches = files.filter((file) => relative(file, payload.repoRoot).toLowerCase().includes(query));
      const limit = num(args, 'limit', 50, 300);
      if (!matches.length) return text(`No files match "${String(args.query)}".`);

      return text([`${matches.length} file(s)${matches.length > limit ? `, first ${limit}` : ''}:`, ...matches.slice(0, limit).map((file) => relative(file, payload.repoRoot))].join('\n'));
    }
  );

  tool(
    {
      name: 'read_file',
      title: 'Read a source file',
      description: "Reads a file from the app's repository with line numbers, whole or a range. Paths may be relative to the repository or to an app folder.",
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          start_line: { type: 'number', description: 'First line (default 1).' },
          end_line: { type: 'number', description: 'Last line (default start + 399).' },
        },
        required: ['file'],
      },
      annotations: readOnly,
    },
    async (args) => {
      const file = await resolveFile(String(args.file ?? ''));
      let payload: { content?: string; relative?: string; error?: string };
      try {
        payload = (await (await fetchImpl(`${collectorUrl}/sources/file?file=${encodeURIComponent(file)}`)).json()) as typeof payload;
      } catch {
        return notRunning();
      }
      if (payload.content === undefined) return failure(`${file}: ${payload.error ?? 'not readable'}`);
      const all = payload.content.split('\n');
      const start = Math.max(1, Math.floor(Number(args.start_line) || 1));
      const end = Math.min(all.length, Math.floor(Number(args.end_line) || start + 399));
      const width = String(end).length;

      return text([`${payload.relative} (lines ${start}-${end} of ${all.length})`, ...all.slice(start - 1, end).map((line, index) => `${String(start + index).padStart(width)}  ${line}`)].join('\n'));
    }
  );

  // -- the browser -----------------------------------------------------------------------------

  tool(
    {
      name: 'open_page',
      title: 'Open a page in the qaisdebugs Chrome',
      description:
        'Opens a URL of the app in the qaisdebugs Chrome, starting it if needed. Breakpoints in client components (`use client`) pause only in this Chrome, never in an everyday Chrome window. The user may need to log in there once.',
      inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'e.g. http://localhost:3000/en/fleet-management/borrow' } }, required: ['url'] },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const response = await fetchImpl(`${collectorUrl}/chrome/launch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: String(args.url ?? '') }) });
        const payload = (await response.json()) as { started?: boolean; error?: string };
        if (!response.ok) return failure(payload.error ?? `the collector answered ${response.status}`);

        return text(`${payload.started ? 'Started the qaisdebugs Chrome and opened' : 'Opened'} ${String(args.url)}. Its tab connects to the debugger on its own when a breakpoint is set.`);
      } catch {
        return notRunning();
      }
    }
  );

  // -- debugger --------------------------------------------------------------------------------

  tool(
    {
      name: 'set_breakpoint',
      title: 'Set a breakpoint',
      description:
        'Pauses the app when it reaches a line of a source file: server code (Server Components, Route Handlers, Server Actions, API code) in the dev server, and client components in the qaisdebugs Chrome. Then call wait_for_pause while the user (or open_page) triggers the code. Setting it again on the same line replaces it.',
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Source file, relative to the repository or an app folder, or absolute.' },
          line: { type: 'number', description: '1-based line number.' },
          condition: { type: 'string', description: 'Optional JavaScript condition; pauses only when it is true.' },
        },
        required: ['file', 'line'],
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async (args) => {
      if (!store.agents.length) return failure('no dev server is running with qaisdebugs; start it with `qaisdebugs dev` first');
      const file = await resolveFile(String(args.file ?? ''));
      const line = Math.floor(Number(args.line));
      if (!line) return failure('line must be a number');
      const breakpoint = await context.debugger.setBreakpoint(file, line, str(args, 'condition'));
      const placed = context.debugger.placements(breakpoint);
      const root = await repoRoot();

      return text(
        placed.length
          ? `Breakpoint set at ${relative(file, root)}:${line}, active in: ${placed.join(', ')}. Now call wait_for_pause and have the code run.`
          : `Breakpoint set at ${relative(file, root)}:${line}, but no running code has loaded that file yet. It is placed as soon as the file loads (open the page that uses it). If it never becomes active, the line may have no code (a blank line or a type).${context.debugger.lastError ? ` Last connection problem: ${context.debugger.lastError}` : ''}`
      );
    }
  );

  tool(
    {
      name: 'remove_breakpoint',
      title: 'Remove breakpoints',
      description: 'Removes the breakpoint on a line, or all of them with all=true.',
      inputSchema: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'number' }, all: { type: 'boolean' } } },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async (args) => {
      if (args.all === true) return text(`Removed ${await context.debugger.removeAll()} breakpoint(s).`);
      if (!str(args, 'file') || !args.line) return failure('give file and line, or all=true');
      const removed = await context.debugger.removeBreakpoint(await resolveFile(String(args.file)), Math.floor(Number(args.line)));

      return text(removed ? 'Removed.' : 'There was no breakpoint on that line.');
    }
  );

  tool(
    {
      name: 'list_breakpoints',
      title: 'List breakpoints',
      description: 'The breakpoints set through this MCP server and where each is active.',
      inputSchema: { type: 'object', properties: {} },
      annotations: readOnly,
    },
    async () => {
      const root = await repoRoot();
      const all = [...context.debugger.breakpoints.values()];
      if (!all.length) return text('No breakpoints.');

      return text(
        all
          .map((breakpoint) => {
            const placed = context.debugger.placements(breakpoint);

            return `${relative(breakpoint.file, root)}:${breakpoint.line}${breakpoint.condition ? ` if ${breakpoint.condition}` : ''}  ${placed.length ? `active in ${placed.join(', ')}` : 'waiting for the file to load'}`;
          })
          .join('\n')
      );
    }
  );

  tool(
    {
      name: 'wait_for_pause',
      title: 'Wait for a pause',
      description: 'Waits until a breakpoint (or an exception, with pause_on_exceptions) pauses the app, then shows where: file, line, call stack and the variables in scope. Returns at once if already paused.',
      inputSchema: { type: 'object', properties: { timeout_seconds: { type: 'number', description: 'Default 60, max 300.' } } },
      annotations: readOnly,
    },
    async (args) => {
      const timeout = num(args, 'timeout_seconds', 60, 300);
      const pause = await context.debugger.waitForPause(timeout * 1000);
      if (!pause) return text(`Nothing paused in ${timeout} s. Make sure the code runs (ask the user to do the action, or open_page for client code) and that list_breakpoints shows it active.`);

      return text(await describePause(pause));
    }
  );

  tool(
    {
      name: 'get_pause',
      title: 'Paused state',
      description: 'Where the app is paused, with the variables of one stack frame (default: the first frame in app code).',
      inputSchema: { type: 'object', properties: { frame: { type: 'number', description: 'Frame index from the call stack.' } } },
      annotations: readOnly,
    },
    async (args) => {
      const pause = context.debugger.currentPause();
      if (!pause) return text('Nothing is paused.');
      const frame = Number.isInteger(Number(args.frame)) && args.frame !== undefined ? Number(args.frame) : pause.selected;

      return text(await describePause(pause, frame));
    }
  );

  tool(
    {
      name: 'evaluate',
      title: 'Evaluate an expression',
      description: 'Evaluates a JavaScript expression in the paused frame (its variables are in scope) and returns the value as JSON or a summary. It runs inside the app, so prefer reading values over changing them.',
      inputSchema: {
        type: 'object',
        properties: { expression: { type: 'string' }, frame: { type: 'number', description: 'Frame index (default: the first app frame).' } },
        required: ['expression'],
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async (args) => {
      const value = await context.debugger.evaluate(String(args.expression ?? ''), args.frame === undefined ? undefined : Number(args.frame));

      return text(value.length > 20_000 ? `${value.slice(0, 20_000)}… [cut]` : value);
    }
  );

  tool(
    {
      name: 'step',
      title: 'Resume or step',
      description: 'Controls a paused app: "resume" (continue), "over" (next line), "into" (into the call), "out" (to the caller), or "pause" (pause whatever runs next). After a step, shows the new position.',
      inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['resume', 'over', 'into', 'out', 'pause'] } }, required: ['action'] },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async (args) => {
      const action = String(args.action) as 'resume' | 'over' | 'into' | 'out' | 'pause';
      await context.debugger.step(action);
      if (action === 'resume') return text('Resumed; the app runs again.');
      const pause = await context.debugger.waitForPause(action === 'pause' ? 30_000 : 5000);

      return text(pause ? await describePause(pause) : action === 'pause' ? 'Asked to pause; nothing ran in 30 s.' : 'Running; it did not stop again within 5 s.');
    }
  );

  tool(
    {
      name: 'pause_on_exceptions',
      title: 'Pause on exceptions',
      description: 'Makes the app pause where an exception is thrown: "uncaught", "all", or "none" to stop. Then use wait_for_pause.',
      inputSchema: { type: 'object', properties: { state: { type: 'string', enum: ['none', 'uncaught', 'all'] } }, required: ['state'] },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async (args) => {
      const state = String(args.state) as 'none' | 'uncaught' | 'all';
      await context.debugger.setPauseOnExceptions(state);

      return text(state === 'none' ? 'No longer pausing on exceptions.' : `Pausing on ${state} exceptions in every dev server and app tab.`);
    }
  );

  return { tools, handlers };
}
