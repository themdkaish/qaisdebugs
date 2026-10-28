/** QaisDebugs — constants shared by the agent, the collector and the UI. */

/** Carries the page request's trace id across the loopback hop and, when a browser agent exists, from the page. */
export const TRACE_HEADER = 'x-qaisdebugs-trace';

/** The recorded outgoing hop that made a loopback request, so the hops inside it nest under it. */
export const SPAN_HEADER = 'x-qaisdebugs-span';

/** The page the trace started on, forwarded across the loopback hop. */
export const PAGE_HEADER = 'x-qaisdebugs-page';

/**
 * Set by the page script on same-origin requests. The dev server records the request under this id,
 * so the browser's half (bodies, call site) and the server's half (status, what it called) merge
 * into one row.
 */
export const CLIENT_HEADER = 'x-qaisdebugs-client';

export const DEFAULT_COLLECTOR_URL = 'http://127.0.0.1:4983';

/** Largest response body kept per request. Longer bodies are cut and flagged `resBodyTruncated`. */
export const BODY_CAP_BYTES = 256 * 1024;

/** Largest request body kept per request. */
export const REQUEST_BODY_CAP_CHARS = 64 * 1024;

/** Hosts whose traffic is framework housekeeping, not application traffic. */
export const HOUSEKEEPING_HOSTS = ['telemetry.nextjs.org', 'registry.npmjs.org', 'sentry.io'];
