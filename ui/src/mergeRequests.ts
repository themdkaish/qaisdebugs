import type { RequestEvent } from './events';

/**
 * One row for a request the page made to its own dev server. The page script records the
 * browser's half (what was sent, the body that came back, the line that called it, the time the
 * user waited) and the dev server records its half under the same id (status as served, request
 * headers as received, and the calls it made, which nest under this id). Either may arrive first.
 */
export function mergeRequest(a: RequestEvent, b: RequestEvent): RequestEvent {
  const browser = a.client ? a : b.client ? b : undefined;
  const server = browser === a ? b : a;
  if (!browser || browser === server) return { ...a, ...b };

  return {
    ...server,
    client: true,
    // The server knows which page the request belongs to and how it classifies it.
    origin: server.origin,
    pagePath: server.pagePath ?? browser.pagePath,
    startedAt: browser.startedAt,
    durationMs: browser.durationMs,
    status: server.status ?? browser.status,
    statusText: server.statusText ?? browser.statusText,
    error: browser.error ?? server.error,
    reqHeaders: withoutClientHeader({ ...browser.reqHeaders, ...server.reqHeaders }),
    resHeaders: Object.keys(browser.resHeaders).length ? browser.resHeaders : server.resHeaders,
    reqBody: browser.reqBody ?? server.reqBody,
    resBody: browser.resBody ?? server.resBody,
    resBodyTruncated: browser.resBody !== undefined ? browser.resBodyTruncated : server.resBodyTruncated,
    resBodySkipped: browser.resBody !== undefined ? undefined : browser.resBodySkipped ?? server.resBodySkipped,
    contentType: browser.contentType ?? server.contentType,
    initiator: browser.initiator ?? server.initiator,
    frames: browser.frames ?? server.frames,
  };
}

/** The header that links the two halves is qaisdebugs' own, not something the app sent. */
function withoutClientHeader(headers: Record<string, string>): Record<string, string> {
  const { 'x-qaisdebugs-client': _linked, ...rest } = headers;

  return rest;
}
