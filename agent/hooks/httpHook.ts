import type { IncomingMessage, ServerResponse } from 'node:http';
import http from 'node:http';
import type { ContextStore, RequestContext } from '../context.js';
import { CLIENT_HEADER, PAGE_HEADER, SPAN_HEADER, TRACE_HEADER } from '../shared/constants.js';
import type { DevtoolsEvent, RequestEvent, RequestOrigin } from '../shared/events.js';
import { newId } from '../shared/ids.js';
import { redactHeaders } from '../shared/redact.js';
import { wallClock } from '../shared/clock.js';
import { injectPageScript, isDocumentRequest } from './pageScript.js';

/**
 * QaisDebugs — the incoming side.
 *
 * Every request the dev server receives runs inside a request context. Requests from the browser
 * (page loads, RSC payloads, client-component API calls) are recorded as the roots of their trace.
 * Loopback requests, the ones this server made to itself through `ssrFetch`, are not recorded
 * again: the fetch hook already recorded that hop, so they only inherit its context from the
 * `x-tj-*` headers. Static assets and HMR traffic are ignored.
 */

export interface HttpHookOptions {
  app: string;
  record: (event: DevtoolsEvent) => void;
  context: ContextStore;
  /** Called once per port this server turns out to listen on. */
  onPort?: (port: number) => void;
  /** The page script's `<script>` element, added to every HTML page; omitted to leave pages alone. */
  pageScriptTag?: string;
}

export interface HttpHook {
  /** Whether a URL points at this server. Known once the first request has arrived. */
  isSelf: (url: URL) => boolean;
  uninstall: () => void;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function installHttpHook(options: HttpHookOptions): HttpHook {
  const ports = new Set<number>();
  type Emit = (this: http.Server, event: string | symbol, ...args: unknown[]) => boolean;
  const originalEmit = http.Server.prototype.emit as Emit;

  const notePort = (port: number): void => {
    if (ports.has(port)) return;
    ports.add(port);
    options.onPort?.(port);
  };

  const patched: Emit = function nextDevtoolsEmit(this: http.Server, event: string | symbol, ...args: unknown[]): boolean {
    if (event === 'listening') {
      // Known before the first request, so `qaisdebugs dev` can open the app as soon as it is up.
      const address = this.address();
      if (address && typeof address === 'object') notePort(address.port);
    }
    if (event !== 'request') {
      return originalEmit.call(this, event, ...args);
    }

    const [req, res] = args as [IncomingMessage, ServerResponse];
    const localPort = req.socket?.localPort;
    if (typeof localPort === 'number') notePort(localPort);

    if (options.pageScriptTag && isDocumentRequest(req)) {
      try {
        injectPageScript(req, res, options.pageScriptTag);
      } catch {
        // The page is served without the script.
      }
    }

    const context = contextFor(req, options.app, options.record, res);

    return options.context.run(context, () => originalEmit.call(this, event, ...args));
  };

  http.Server.prototype.emit = patched as typeof http.Server.prototype.emit;

  return {
    isSelf: (url) => LOCAL_HOSTS.has(url.hostname) && ports.has(Number(url.port || (url.protocol === 'https:' ? 443 : 80))),
    uninstall: () => {
      http.Server.prototype.emit = originalEmit as typeof http.Server.prototype.emit;
    },
  };
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];

  return Array.isArray(value) ? value[0] : value;
}

export function contextFor(
  req: IncomingMessage,
  app: string,
  record: (event: DevtoolsEvent) => void,
  res?: ServerResponse
): RequestContext {
  const traceHeader = header(req, TRACE_HEADER);
  const spanHeader = header(req, SPAN_HEADER);
  const pageHeader = header(req, PAGE_HEADER);
  const url = req.url ?? '/';

  // A loopback call made by this server: the fetch hook recorded it, so only inherit its context.
  if (spanHeader) {
    return { traceId: traceHeader ?? newId(), parentId: spanHeader, pagePath: pageHeader };
  }

  const origin = classifyIncoming(req);
  if (!origin) {
    return { traceId: traceHeader ?? newId(), pagePath: pageHeader };
  }

  // The page script's id for this request, so its record and this one merge into one row.
  const clientId = header(req, CLIENT_HEADER);
  const id = clientId && /^[\w-]{8,64}$/.test(clientId) ? clientId : newId();
  const traceId = traceHeader ?? newId();
  const pathname = url.split('?')[0];
  const pagePath = origin === 'page' ? pathname : pageHeader ?? refererPath(req);
  const startedAt = wallClock();
  const t0 = performance.now();

  if (res) {
    const finish = (): void => {
      res.removeListener('finish', finish);
      res.removeListener('close', finish);

      const event: RequestEvent = {
        kind: 'request',
        id,
        traceId,
        pagePath,
        app,
        origin,
        method: req.method ?? 'GET',
        url: absoluteUrl(req),
        status: res.statusCode,
        statusText: res.statusMessage || undefined,
        startedAt,
        durationMs: performance.now() - t0,
        reqHeaders: redactHeaders(req.headers as Record<string, string>),
        resHeaders: redactHeaders(res.getHeaders() as Record<string, string>),
        contentType: String(res.getHeader('content-type') ?? '') || undefined,
        resBodySkipped: 'the server does not keep what it sends to the browser; the page script records it when it runs in the page',
      };

      try {
        record(event);
      } catch {
        // Never interfere with the response.
      }
    };

    res.on('finish', finish);
    res.on('close', finish);
  }

  return { traceId, parentId: id, pagePath };
}

/** Fetch destinations of assets: scripts, styles, images and the like are never the app's own requests. */
const ASSET_DESTINATIONS = new Set(['script', 'style', 'image', 'font', 'audio', 'video', 'track', 'worker', 'sharedworker', 'serviceworker', 'manifest', 'audioworklet', 'paintworklet', 'object', 'embed']);

/** `page` for documents and RSC payloads, `browser` for API routes, nothing for assets and HMR. */
export function classifyIncoming(req: IncomingMessage): RequestOrigin | undefined {
  const url = req.url ?? '/';
  const pathname = url.split('?')[0];

  if (pathname.startsWith('/_next') || pathname.startsWith('/__next') || pathname.startsWith('/favicon')) return undefined;
  // Next's dev endpoints, also when locale middleware has redirected them under `/en/…`.
  if (pathname.includes('/__nextjs')) return undefined;
  // Vite's own modules (`/@vite/client`, `/@fs/…`, `/@id/…`, `/@react-refresh`) and endpoints.
  if (pathname.startsWith('/@') || pathname.startsWith('/__vite')) return undefined;
  if (ASSET_DESTINATIONS.has(header(req, 'sec-fetch-dest') ?? '')) return undefined;
  if (pathname.startsWith('/api/')) return 'browser';
  if (/\.[a-z0-9]{1,5}$/i.test(pathname)) return undefined;
  if (header(req, 'rsc') === '1' || header(req, 'next-router-prefetch') === '1') return 'page';

  const accept = header(req, 'accept') ?? '';
  if (accept.includes('text/html') || accept === '' || accept === '*/*') return 'page';

  return 'browser';
}

function absoluteUrl(req: IncomingMessage): string {
  const host = header(req, 'host') ?? 'localhost';
  const protocol = header(req, 'x-forwarded-proto') ?? 'http';

  return `${protocol}://${host}${req.url ?? '/'}`;
}

function refererPath(req: IncomingMessage): string | undefined {
  const referer = header(req, 'referer');
  if (!referer) return undefined;

  try {
    return new URL(referer).pathname;
  } catch {
    return undefined;
  }
}
