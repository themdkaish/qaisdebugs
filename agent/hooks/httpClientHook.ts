import diagnosticsChannel from 'node:diagnostics_channel';
import type { ClientRequest, IncomingMessage } from 'node:http';
import zlib from 'node:zlib';
import type { RequestContext } from '../context.js';
import { BODY_CAP_BYTES, PAGE_HEADER, REQUEST_BODY_CAP_CHARS, SPAN_HEADER, TRACE_HEADER } from '../shared/constants.js';
import type { DevtoolsEvent, RequestEvent } from '../shared/events.js';
import { newId } from '../shared/ids.js';
import { type ParseStackOptions, captureInitiator } from '../shared/initiator.js';
import { redactBodyText, redactHeaders } from '../shared/redact.js';
import { classifyOutgoing, isCollector } from './fetchHook.js';
import { wallClock } from '../shared/clock.js';

/**
 * QaisDebugs — outgoing calls made through Node's `http` and `https` modules.
 *
 * `fetch` covers Next's own data fetching, but many API clients never touch it: axios, got,
 * node-fetch v2, `request`, and the clients openapi-generator and orval generate on top of axios.
 * They all end in `http.request`, and Node announces every client request on a diagnostics
 * channel. Subscribing there observes those calls without wrapping any module: the request and
 * response are only tapped (their `emit`, `write` and `end` are watched, never replaced in
 * behaviour), so streams, back-pressure and error handling stay exactly as the client expects.
 *
 * `http.client.request.created` (Node 22.12+) fires before the headers are sent, so a loopback
 * call to this dev server can still carry the trace headers. Older Node only has
 * `http.client.request.start`, which fires after; the call is recorded the same, without them.
 */

export interface HttpClientHookOptions {
  app: string;
  stackOptions: ParseStackOptions;
  collectorUrl: string;
  record: (event: DevtoolsEvent) => void;
  getContext: () => RequestContext | undefined;
  isSelf: (url: URL) => boolean;
}

const CHANNELS = ['http.client.request.created', 'http.client.request.start'] as const;
const TEXT_LIKE = /json|text|xml|javascript|x-www-form-urlencoded/i;

export function installHttpClientHook(options: HttpClientHookOptions): () => void {
  const seen = new WeakSet<object>();
  const listener = (message: unknown): void => {
    const request = (message as { request?: ClientRequest } | undefined)?.request;
    if (!request || seen.has(request)) return;
    seen.add(request);

    try {
      observe(request, options);
    } catch {
      // Observing must never affect the request.
    }
  };

  for (const name of CHANNELS) diagnosticsChannel.subscribe(name, listener);

  return () => {
    for (const name of CHANNELS) diagnosticsChannel.unsubscribe(name, listener);
  };
}

/** The absolute URL a client request goes to. */
export function requestUrl(request: ClientRequest): URL | undefined {
  const protocol = request.protocol || 'http:';
  const host = String(request.getHeader('host') ?? request.host ?? 'localhost');

  try {
    return new URL(`${protocol}//${host}${request.path || '/'}`);
  } catch {
    return undefined;
  }
}

function observe(request: ClientRequest, options: HttpClientHookOptions): void {
  const url = requestUrl(request);
  if (!url || isCollector(url, options.collectorUrl)) return;

  const context = options.getContext();
  const stack = captureInitiator(options.stackOptions, 1);
  const self = options.isSelf(url);
  const id = newId();

  if (self && !request.headersSent) {
    request.setHeader(SPAN_HEADER, id);
    if (context) {
      request.setHeader(TRACE_HEADER, context.traceId);
      if (context.pagePath) request.setHeader(PAGE_HEADER, context.pagePath);
    }
  }

  const startedAt = wallClock();
  const t0 = performance.now();
  const body = tapRequestBody(request);
  let finished = false;

  const base = (): Omit<RequestEvent, 'durationMs' | 'resHeaders'> => {
    const reqHeaders = redactHeaders(headerRecord(request.getHeaders()));

    return {
      kind: 'request',
      id,
      traceId: context?.traceId,
      parentId: context?.parentId,
      pagePath: context?.pagePath,
      app: options.app,
      origin: classifyOutgoing(url, self, stack),
      method: (request.method || 'GET').toUpperCase(),
      url: url.href,
      startedAt,
      reqHeaders,
      reqBody: body.text(reqHeaders['content-type']),
      initiator: stack.initiator,
      frames: stack.frames,
    };
  };

  const finish = (event: RequestEvent): void => {
    if (finished) return;
    finished = true;
    try {
      options.record(event);
    } catch {
      // Recording must never affect the request.
    }
  };

  let gotResponse = false;
  tapEmit(request, (event, args) => {
    if (event === 'response') {
      gotResponse = true;
      const response = args[0] as IncomingMessage;
      // Snapshot now: axios deletes content-encoding from the live headers once it starts decompressing.
      const arrived = { statusCode: response.statusCode, statusMessage: response.statusMessage, headers: { ...response.headers } };
      tapResponse(response, (resBody) => finish({ ...base(), ...responseFields(arrived, resBody), durationMs: performance.now() - t0 }));
    } else if (event === 'error') {
      const error = args[0];
      finish({ ...base(), durationMs: performance.now() - t0, resHeaders: {}, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
    } else if (event === 'close' && !gotResponse) {
      finish({ ...base(), durationMs: performance.now() - t0, resHeaders: {}, error: 'closed before a response arrived' });
    }
  });
}

/** Calls `onEvent` for every event the emitter emits, then emits it as before. */
export function tapEmit(emitter: { emit: (event: string | symbol, ...args: unknown[]) => boolean }, onEvent: (event: string | symbol, args: unknown[]) => void): void {
  const original = emitter.emit;
  emitter.emit = function tappedEmit(this: unknown, event: string | symbol, ...args: unknown[]): boolean {
    try {
      onEvent(event, args);
    } catch {
      // Observing must never affect the stream.
    }

    return original.call(this, event, ...args);
  };
}

/** Collects what the client writes as the request body, up to the cap. */
function tapRequestBody(request: ClientRequest): { text: (contentType?: string) => string | undefined } {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  const keep = (chunk: unknown): void => {
    if (chunk === undefined || chunk === null || typeof chunk === 'function') return;
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.isBuffer(chunk) ? chunk : ArrayBuffer.isView(chunk) ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength) : undefined;
    if (!buffer) return;
    if (size + buffer.length > REQUEST_BODY_CAP_CHARS) {
      truncated = true;
      if (size < REQUEST_BODY_CAP_CHARS) chunks.push(buffer.subarray(0, REQUEST_BODY_CAP_CHARS - size));
      size = REQUEST_BODY_CAP_CHARS;

      return;
    }
    chunks.push(buffer);
    size += buffer.length;
  };

  const write = request.write;
  request.write = function tappedWrite(this: ClientRequest, chunk: unknown, ...rest: unknown[]) {
    keep(chunk);

    return (write as (...args: unknown[]) => boolean).call(this, chunk, ...rest);
  } as typeof request.write;
  const end = request.end;
  request.end = function tappedEnd(this: ClientRequest, chunk?: unknown, ...rest: unknown[]) {
    keep(chunk);

    return (end as (...args: unknown[]) => ClientRequest).call(this, chunk, ...rest);
  } as typeof request.end;

  return {
    text: (contentType) => {
      if (size === 0) return undefined;
      const raw = Buffer.concat(chunks);
      if (contentType && !TEXT_LIKE.test(contentType)) return `[binary ${raw.length}${truncated ? '+' : ''} bytes]`;
      const text = redactBodyText(raw.toString('utf8'), contentType);

      return truncated ? `${text}… [truncated]` : text;
    },
  };
}

interface CapturedBody {
  buffer: Buffer;
  truncated: boolean;
}

/** Collects the response body as the client reads it, up to the cap, and reports once it ends. */
function tapResponse(response: IncomingMessage, onDone: (body: CapturedBody) => void): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  let done = false;
  const complete = (): void => {
    if (done) return;
    done = true;
    onDone({ buffer: Buffer.concat(chunks), truncated });
  };

  tapEmit(response as unknown as { emit: (event: string | symbol, ...args: unknown[]) => boolean }, (event, args) => {
    if (event === 'data') {
      const chunk = args[0];
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.isBuffer(chunk) ? chunk : undefined;
      if (!buffer || truncated) return;
      if (size + buffer.length > BODY_CAP_BYTES) {
        truncated = true;

        return;
      }
      chunks.push(buffer);
      size += buffer.length;
    } else if (event === 'end' || event === 'close' || event === 'error' || event === 'aborted') {
      complete();
    }
  });
}

/** Status, headers and the decoded, redacted body of a finished response. */
export function responseFields(response: Pick<IncomingMessage, 'statusCode' | 'statusMessage' | 'headers'>, body: CapturedBody): Pick<RequestEvent, 'status' | 'statusText' | 'resHeaders' | 'contentType' | 'resBody' | 'resBodyTruncated' | 'resBodySkipped'> {
  const contentType = headerValue(response.headers['content-type']);
  const fields: ReturnType<typeof responseFields> = {
    status: response.statusCode,
    statusText: response.statusMessage || undefined,
    resHeaders: redactHeaders(headerRecord(response.headers)),
    contentType,
  };

  if (body.buffer.length === 0) {
    fields.resBodySkipped = 'no body';
  } else if (!contentType || !TEXT_LIKE.test(contentType)) {
    fields.resBodySkipped = contentType ?? 'no content-type';
  } else if (body.truncated) {
    fields.resBodySkipped = `larger than ${Math.round(BODY_CAP_BYTES / 1024)} KB`;
    fields.resBodyTruncated = true;
  } else {
    try {
      const text = decode(body.buffer, headerValue(response.headers['content-encoding'])).toString('utf8');
      fields.resBody = redactBodyText(text, contentType);
    } catch (error) {
      fields.resBodySkipped = `unreadable: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  return fields;
}

/** Decompresses what the client received on the wire (axios asks for gzip, br and deflate). */
export function decode(buffer: Buffer, encoding: string | undefined): Buffer {
  switch ((encoding ?? '').trim().toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return zlib.gunzipSync(buffer);
    case 'br':
      return zlib.brotliDecompressSync(buffer);
    case 'deflate':
      try {
        return zlib.inflateSync(buffer);
      } catch {
        return zlib.inflateRawSync(buffer);
      }
    case 'zstd': {
      const zstd = (zlib as unknown as { zstdDecompressSync?: (input: Buffer) => Buffer }).zstdDecompressSync;
      if (!zstd) throw new Error('zstd is not supported by this Node version');

      return zstd(buffer);
    }
    default:
      return buffer;
  }
}

function headerValue(value: string | string[] | number | undefined): string | undefined {
  if (value === undefined) return undefined;

  return Array.isArray(value) ? value.join(', ') : String(value);
}

function headerRecord(headers: Record<string, string | string[] | number | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const text = headerValue(value);
    if (text !== undefined) out[name] = text;
  }

  return out;
}
