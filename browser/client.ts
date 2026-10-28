/**
 * QaisDebugs — the page script.
 *
 * The dev server adds this script to every HTML page it sends (dev only), so whatever browser the
 * app is open in reports to the inspector: every request the page makes (fetch and
 * XMLHttpRequest, to any host, with bodies), console output and uncaught errors. Requests to the
 * dev server carry `x-qaisdebugs-client`, so the server records them under the same id and the
 * inspector shows one row for both halves.
 *
 * Everything is wrapped so the page behaves exactly as without it: the original call always
 * runs, and a failure to record is swallowed.
 */
import { createBus } from '../agent/shared/bus.js';
import { BODY_CAP_BYTES, CLIENT_HEADER, REQUEST_BODY_CAP_CHARS } from '../agent/shared/constants.js';
import type { DevtoolsEvent, LogEvent, LogLevel, RequestEvent } from '../agent/shared/events.js';
import { LOG_LEVELS } from '../agent/shared/events.js';
import { redactBodyText, redactHeaders, redactValue } from '../agent/shared/redact.js';
import { toSerializable } from '../agent/shared/serialize.js';
import { type UrlKind, classifyUrl, describeBody, isTextual, parseRawHeaders, readCapped } from './capture.js';
import { createFrameResolver } from './frames.js';

interface ClientConfig {
  app: string;
  collector: string;
  cwd: string;
}

type ClientWindow = Window & { __qaisdebugs?: { app: string } };

/** Next's own dev chatter, not the app's. */
const FRAMEWORK_LOG = /^(\[(Fast Refresh|HMR)\]|%cDownload the React DevTools)/;

/**
 * React replays server console output in the browser with a " Server " badge
 * (`'%c%s%c …', style, ' Server ', style, …`). The server hook already recorded those lines.
 */
function isFrameworkLog(args: unknown[]): boolean {
  if (typeof args[0] !== 'string') return false;

  return FRAMEWORK_LOG.test(args[0]) || (args[0].startsWith('%c%s%c') && typeof args[2] === 'string' && args[2].trim() === 'Server');
}

function readConfig(): ClientConfig | undefined {
  const script = document.currentScript as HTMLScriptElement | null;
  const app = script?.dataset.qaisdebugsApp;
  const collector = script?.dataset.qaisdebugsCollector;
  if (!app || !collector) return undefined;

  return { app, collector, cwd: script.dataset.qaisdebugsCwd ?? '' };
}

function newId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function install(config: ClientConfig): void {
  const target = window as ClientWindow;
  if (target.__qaisdebugs) return;
  target.__qaisdebugs = { app: config.app };

  const originalFetch = window.fetch.bind(window);
  const bus = createBus({ collectorUrl: config.collector, fetchImpl: (input, init) => originalFetch(input, init), warn: () => undefined, schedule: scheduleUnthrottled() });
  const record = (event: DevtoolsEvent): void => {
    try {
      bus.enqueue(event);
    } catch {
      // Never break the page.
    }
  };
  const pageOrigin = location.origin;
  const collectorOrigin = new URL(config.collector).origin;
  const pagePath = (): string => location.pathname;
  const kindOf = (url: string): { url: URL; kind: UrlKind } | undefined => {
    try {
      const parsed = new URL(url, location.href);

      return { url: parsed, kind: classifyUrl(parsed, pageOrigin, collectorOrigin) };
    } catch {
      return undefined;
    }
  };
  const resolveFrames = createFrameResolver((input, init) => originalFetch(input, init), config.cwd, pageOrigin);
  /** The app's line that made the call, from the dev server's source maps; never fails. */
  const callSite = async (stack: string | undefined): Promise<Pick<RequestEvent, 'initiator' | 'frames'>> => {
    const frames = await resolveFrames(stack).catch(() => []);

    return frames.length ? { initiator: frames[0], frames } : {};
  };

  window.addEventListener('pagehide', () => void bus.flush());

  // ---- fetch ---------------------------------------------------------------------------------
  window.fetch = function qaisdebugsFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = typeof Request !== 'undefined' && input instanceof Request ? input : undefined;
    const target = kindOf(request ? request.url : String(input));
    if (!target || target.kind === 'skip') return originalFetch(input, init);

    const id = newId();
    const stack = new Error().stack;
    const startedAt = Date.now();
    const t0 = performance.now();
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    // `init.headers` replaces the request's own headers, as fetch itself does.
    const headers = new Headers(init?.headers ?? request?.headers);
    const reqHeaders = redactHeaders(headers);
    let callInit = init;
    if (target.kind === 'same') {
      headers.set(CLIENT_HEADER, id);
      callInit = { ...init, headers };
    }
    const bodyText = describeBody(init?.body, REQUEST_BODY_CAP_CHARS);
    const reqBody =
      bodyText !== undefined ? Promise.resolve(bodyText) : request && method !== 'GET' && method !== 'HEAD' ? request.clone().text().catch(() => undefined) : Promise.resolve(undefined);

    const base = (): RequestEvent => ({
      kind: 'request',
      id,
      app: config.app,
      pagePath: pagePath(),
      origin: 'browser',
      client: true,
      method,
      url: target.url.href,
      startedAt,
      durationMs: 0,
      reqHeaders,
      resHeaders: {},
    });

    const pending = originalFetch(input, callInit);
    pending.then(
      async (response) => {
        const event = base();
        event.status = response.status;
        event.statusText = response.statusText || undefined;
        event.resHeaders = redactHeaders(response.headers);
        const contentType = response.headers.get('content-type');
        event.contentType = contentType ?? undefined;
        try {
          if (isTextual(contentType) && method !== 'HEAD') {
            const { text, truncated } = await readCapped(response.clone(), BODY_CAP_BYTES);
            event.resBody = truncated ? text : redactBodyText(text, contentType);
            event.resBodyTruncated = truncated || undefined;
          } else {
            event.resBodySkipped = contentType ? `not text (${contentType})` : 'no body';
          }
        } catch {
          event.resBodySkipped = 'the body could not be read';
        }
        event.reqBody = redactRequestBody(await reqBody, headers.get('content-type'));
        event.durationMs = performance.now() - t0;
        record(Object.assign(event, await callSite(stack)));
      },
      async (error: unknown) => {
        const event = base();
        event.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        event.reqBody = redactRequestBody(await reqBody, headers.get('content-type'));
        event.durationMs = performance.now() - t0;
        record(Object.assign(event, await callSite(stack)));
      }
    );

    return pending;
  };

  // ---- XMLHttpRequest (axios and older clients) ----------------------------------------------
  interface Tracked {
    method: string;
    url: URL;
    kind: UrlKind;
    headers: Record<string, string>;
  }
  const tracked = new WeakMap<XMLHttpRequest, Tracked>();
  const proto = XMLHttpRequest.prototype;
  const originalOpen = proto.open as (this: XMLHttpRequest, ...args: unknown[]) => void;
  const originalSend = proto.send;
  const originalSetHeader = proto.setRequestHeader;

  proto.open = function qaisdebugsOpen(this: XMLHttpRequest, ...args: unknown[]): void {
    const target = kindOf(String(args[1]));
    if (target) tracked.set(this, { method: String(args[0]).toUpperCase(), url: target.url, kind: target.kind, headers: {} });

    return originalOpen.apply(this, args);
  } as typeof proto.open;

  proto.setRequestHeader = function qaisdebugsSetHeader(this: XMLHttpRequest, name: string, value: string): void {
    const entry = tracked.get(this);
    if (entry) entry.headers[name.toLowerCase()] = value;

    return originalSetHeader.call(this, name, value);
  };

  proto.send = function qaisdebugsSend(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null): void {
    const entry = tracked.get(this);
    if (entry && entry.kind !== 'skip') {
      const id = newId();
      const stack = new Error().stack;
      const startedAt = Date.now();
      const t0 = performance.now();
      if (entry.kind === 'same') originalSetHeader.call(this, CLIENT_HEADER, id);
      const reqBody = redactRequestBody(describeBody(body, REQUEST_BODY_CAP_CHARS), entry.headers['content-type']);

      this.addEventListener('loadend', async () => {
        const event: RequestEvent = {
          kind: 'request',
          id,
          app: config.app,
          pagePath: pagePath(),
          origin: 'browser',
          client: true,
          method: entry.method,
          url: entry.url.href,
          startedAt,
          durationMs: performance.now() - t0,
          reqHeaders: redactHeaders(entry.headers),
          resHeaders: {},
          reqBody,
        };
        if (this.status === 0) {
          event.error = 'the request did not complete (network error, CORS or aborted)';
        } else {
          event.status = this.status;
          event.statusText = this.statusText || undefined;
          event.resHeaders = redactHeaders(parseRawHeaders(this.getAllResponseHeaders()));
          const contentType = this.getResponseHeader('content-type');
          event.contentType = contentType ?? undefined;
          try {
            const text = this.responseType === '' || this.responseType === 'text' ? this.responseText : this.responseType === 'json' ? JSON.stringify(this.response) : undefined;
            if (text === undefined) {
              event.resBodySkipped = `not text (responseType ${this.responseType})`;
            } else {
              const truncated = text.length > BODY_CAP_BYTES;
              event.resBody = truncated ? text.slice(0, BODY_CAP_BYTES) : redactBodyText(text, contentType);
              event.resBodyTruncated = truncated || undefined;
            }
          } catch {
            event.resBodySkipped = 'the body could not be read';
          }
        }
        record(Object.assign(event, await callSite(stack)));
      });
    }

    return originalSend.call(this, body);
  };

  // ---- console and uncaught errors -----------------------------------------------------------
  for (const level of LOG_LEVELS) {
    const original = console[level];
    console[level] = function qaisdebugsConsole(...args: unknown[]): void {
      try {
        if (!isFrameworkLog(args)) {
          const event: LogEvent = {
            kind: 'log',
            id: newId(),
            app: config.app,
            pagePath: pagePath(),
            origin: 'browser',
            level: level as LogLevel,
            // Serialized now: the objects may change before the call site is known.
            args: args.map((arg) => redactValue(toSerializable(arg))),
            at: Date.now(),
          };
          void callSite(new Error().stack).then((site) => record(Object.assign(event, site)));
        }
      } catch {
        // Logging must never throw.
      }

      return original.apply(console, args);
    };
  }

  window.addEventListener('error', (event) => {
    record({
      kind: 'error',
      id: newId(),
      app: config.app,
      pagePath: pagePath(),
      origin: 'browser',
      message: event.message || String(event.error),
      stack: event.error instanceof Error ? event.error.stack : undefined,
      at: Date.now(),
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason as unknown;
    record({
      kind: 'error',
      id: newId(),
      app: config.app,
      pagePath: pagePath(),
      origin: 'browser',
      message: `Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`,
      stack: reason instanceof Error ? reason.stack : undefined,
      at: Date.now(),
    });
  });
}

/**
 * Short delays run as a message-channel task: browsers throttle timers in background tabs (to once
 * a minute after five minutes), and the app's tab is in the background whenever the inspector is
 * the tab being looked at. Long delays, the retries while the collector is down, stay timers.
 */
function scheduleUnthrottled(): (run: () => void, delayMs: number) => void {
  const channel = new MessageChannel();
  const queued: Array<() => void> = [];
  channel.port1.onmessage = () => queued.shift()?.();

  return (run, delayMs) => {
    if (delayMs >= 1000) {
      setTimeout(run, delayMs);

      return;
    }
    queued.push(run);
    channel.port2.postMessage(null);
  };
}

function redactRequestBody(body: string | undefined, contentType: string | null | undefined): string | undefined {
  return body === undefined ? undefined : redactBodyText(body, contentType);
}

const config = readConfig();
if (config) install(config);
