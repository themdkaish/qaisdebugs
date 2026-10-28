import type { RequestContext } from '../context.js';
import { HOUSEKEEPING_HOSTS, PAGE_HEADER, SPAN_HEADER, TRACE_HEADER } from '../shared/constants.js';
import type { DevtoolsEvent, RequestOrigin } from '../shared/events.js';
import { newId } from '../shared/ids.js';
import { type ParseStackOptions, type ParsedStack, captureInitiator } from '../shared/initiator.js';
import { recordFetch } from '../shared/recorder.js';

/**
 * QaisDebugs — the outgoing side.
 *
 * Wraps `globalThis.fetch` before Next patches it, so every server-side fetch flows through here:
 * a server component calling the app's own API route (a loopback call to this same dev server), a
 * route handler calling a backend, and framework housekeeping. Loopback calls get the trace
 * headers so the hops they trigger nest under them; external calls get those headers stripped so
 * they never reach a backend.
 */

export interface FetchHookOptions {
  app: string;
  stackOptions: ParseStackOptions;
  collectorUrl: string;
  record: (event: DevtoolsEvent) => void;
  getContext: () => RequestContext | undefined;
  /** Whether a URL points at this dev server itself (a loopback call). */
  isSelf: (url: URL) => boolean;
  /** The fetch to wrap. Defaults to the current global. */
  original?: typeof fetch;
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function installFetchHook(options: FetchHookOptions): FetchLike {
  const original = options.original ?? globalThis.fetch;
  const wrapped = createFetchWrapper(options, original);

  globalThis.fetch = wrapped as typeof fetch;

  return original;
}

export function createFetchWrapper(options: FetchHookOptions, original: FetchLike): FetchLike {
  return async function nextDevtoolsFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = parseUrl(input);
    if (!url || isCollector(url, options.collectorUrl)) {
      return original(input, init);
    }

    const context = options.getContext();
    const stack = captureInitiator(options.stackOptions, 1);
    const self = options.isSelf(url);
    const origin = classifyOutgoing(url, self, stack);
    const id = newId();
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));

    let effectiveInit = init;
    if (self) {
      headers.set(SPAN_HEADER, id);
      if (context) {
        headers.set(TRACE_HEADER, context.traceId);
        if (context.pagePath) headers.set(PAGE_HEADER, context.pagePath);
      }
      effectiveInit = { ...init, headers };
    } else if (headers.has(TRACE_HEADER) || headers.has(SPAN_HEADER) || headers.has(PAGE_HEADER)) {
      headers.delete(TRACE_HEADER);
      headers.delete(SPAN_HEADER);
      headers.delete(PAGE_HEADER);
      effectiveInit = { ...init, headers };
    }

    return recordFetch(
      {
        id,
        app: options.app,
        origin,
        method,
        url: url.href,
        headers,
        body: init?.body,
        traceId: context?.traceId,
        parentId: context?.parentId,
        pagePath: context?.pagePath,
        stack,
        record: options.record,
      },
      () => original(input, effectiveInit)
    );
  };
}

/** Whether a URL is the collector's own: same origin, so port 4983 never matches 49830. */
export function isCollector(url: URL, collectorUrl: string): boolean {
  try {
    return url.origin === new URL(collectorUrl).origin;
  } catch {
    return false;
  }
}

export function classifyOutgoing(url: URL, self: boolean, stack: ParsedStack): RequestOrigin {
  if (self) return 'server';
  if (HOUSEKEEPING_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) return 'other';

  return stack.frames.length > 0 ? 'external' : 'other';
}

function parseUrl(input: RequestInfo | URL): URL | undefined {
  try {
    if (input instanceof URL) return input;
    if (typeof input === 'string') return new URL(input);

    return new URL(input.url);
  } catch {
    return undefined;
  }
}
