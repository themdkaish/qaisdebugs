import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * QaisDebugs — adds the page script to the HTML the dev server sends.
 *
 * The script goes right after `<head>`, before any of the app's scripts, so it sees the first
 * request and the first console message. Only full document loads get it; RSC payloads, API
 * routes and assets pass through untouched. The browser is asked for an uncompressed page (Next
 * compresses even in dev), which is what lets the HTML be edited on its way out.
 */

/** How much of a page is held back while looking for `<head>`, before giving up on it. */
const SEARCH_LIMIT = 256 * 1024;

export interface PageScriptConfig {
  app: string;
  collectorUrl: string;
  cwd: string;
  /** The built page script (`dist/browser/client.js`). */
  code: string;
}

/** The `<script>` element, configured through data attributes the script reads on start. */
export function pageScriptTag(config: PageScriptConfig): string {
  const attr = (value: string): string => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  // The code is inline, so it must not close its own element early. Its source map stays with the
  // collector, which DevTools fetches only when it is open.
  const code = config.code
    .replace(/\/\/# sourceMappingURL=\S+\s*$/, `//# sourceMappingURL=${config.collectorUrl}/client.js.map`)
    .replace(/<\/script/gi, '<\\/script');

  return (
    `<script data-qaisdebugs-app="${attr(config.app)}" data-qaisdebugs-collector="${attr(config.collectorUrl)}" data-qaisdebugs-cwd="${attr(config.cwd)}">` +
    `${code}\n//# sourceURL=qaisdebugs-client.js\n</script>`
  );
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];

  return Array.isArray(value) ? value[0] : value;
}

/** A browser loading a page: GET, wants HTML, and not an RSC payload or prefetch. */
export function isDocumentRequest(req: IncomingMessage): boolean {
  if (req.method !== 'GET') return false;
  const pathname = (req.url ?? '/').split('?')[0];
  if (pathname.startsWith('/_next') || pathname.startsWith('/__next') || pathname.startsWith('/api/')) return false;
  if (header(req, 'rsc') === '1' || header(req, 'next-router-prefetch') === '1') return false;

  return (header(req, 'accept') ?? '').includes('text/html');
}

/** `html` with `tag` inserted right after the opening `<head …>`, or undefined while there is none yet. */
export function insertAfterHead(html: string, tag: string): string | undefined {
  const match = /<head(\s[^>]*)?>/i.exec(html);
  if (!match) return undefined;
  const at = match.index + match[0].length;

  return html.slice(0, at) + tag + html.slice(at);
}

type WriteArgs = [chunk: unknown, encodingOrCallback?: unknown, callback?: unknown];

/**
 * Sets up `res` so the page script lands in the HTML it sends. Responses that turn out not to be
 * HTML, or HTML without a `<head>` in its first 256 KB, pass through unchanged.
 */
export function injectPageScript(req: IncomingMessage, res: ServerResponse, tag: string): void {
  delete req.headers['accept-encoding'];
  // A 304 would leave the browser on its cached copy: one without the script, or with an older one.
  delete req.headers['if-none-match'];
  delete req.headers['if-modified-since'];

  const originalWrite = res.write;
  const originalEnd = res.end;
  const originalWriteHead = res.writeHead;
  let state: 'undecided' | 'searching' | 'done' = 'undecided';
  let held: Buffer[] = [];
  let heldBytes = 0;

  const isHtml = (): boolean => /text\/html/i.test(String(res.getHeader('content-type') ?? ''));
  const decide = (status = res.statusCode): void => {
    if (state !== 'undecided') return;
    state = status === 200 && isHtml() ? 'searching' : 'done';
    // The page grows, so a length set up front would be wrong.
    if (state === 'searching' && !res.headersSent) res.removeHeader('content-length');
  };
  const toBuffer = (chunk: unknown, encoding: unknown): Buffer =>
    Buffer.isBuffer(chunk) ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(String(chunk), typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8');
  const callbackOf = (args: WriteArgs): ((error?: Error | null) => void) | undefined =>
    (typeof args[1] === 'function' ? args[1] : typeof args[2] === 'function' ? args[2] : undefined) as ((error?: Error | null) => void) | undefined;

  /** Adds the chunk to what is held back; returns the bytes to send now, if the search is over. */
  const take = (chunk: unknown, encoding: unknown): Buffer | undefined => {
    if (chunk === undefined || chunk === null || (typeof chunk === 'string' && chunk.length === 0)) return undefined;
    held.push(toBuffer(chunk, encoding));
    heldBytes += held[held.length - 1].length;
    const html = Buffer.concat(held).toString('utf8');
    const withTag = insertAfterHead(html, tag);
    if (withTag === undefined && heldBytes < SEARCH_LIMIT) return undefined;

    state = 'done';
    held = [];

    return Buffer.from(withTag ?? html, 'utf8');
  };

  res.writeHead = function qaisdebugsWriteHead(this: ServerResponse, ...args: unknown[]): ServerResponse {
    const headers = args.find((arg, index) => index > 0 && arg && typeof arg === 'object' && !Array.isArray(arg)) as Record<string, unknown> | undefined;
    if (headers) {
      for (const key of Object.keys(headers)) if (key.toLowerCase() === 'content-type' && !res.hasHeader('content-type')) res.setHeader('content-type', String(headers[key]));
    }
    decide(typeof args[0] === 'number' ? args[0] : res.statusCode);
    if (state === 'searching' && headers) {
      for (const key of Object.keys(headers)) if (key.toLowerCase() === 'content-length') delete headers[key];
    }

    return (originalWriteHead as (...a: unknown[]) => ServerResponse).apply(this, args);
  } as typeof res.writeHead;

  res.write = function qaisdebugsWrite(this: ServerResponse, ...args: WriteArgs): boolean {
    decide();
    if (state !== 'searching') return (originalWrite as (...a: unknown[]) => boolean).apply(this, args);

    const ready = take(args[0], args[1]);
    if (!ready) {
      const callback = callbackOf(args);
      if (callback) process.nextTick(callback);

      return true;
    }

    return (originalWrite as (...a: unknown[]) => boolean).call(this, ready, callbackOf(args));
  } as typeof res.write;

  res.end = function qaisdebugsEnd(this: ServerResponse, ...args: WriteArgs): ServerResponse {
    decide();
    if (state !== 'searching') return (originalEnd as (...a: unknown[]) => ServerResponse).apply(this, args);

    const chunk = typeof args[0] === 'function' ? undefined : args[0];
    const callback = callbackOf(typeof args[0] === 'function' ? [undefined, args[0]] : args);
    const ready = take(chunk, args[1]) ?? (held.length ? Buffer.concat(held) : undefined);
    state = 'done';
    held = [];

    return (originalEnd as (...a: unknown[]) => ServerResponse).call(this, ready, callback);
  } as typeof res.end;
}
