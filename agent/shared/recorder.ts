import { BODY_CAP_BYTES, REQUEST_BODY_CAP_CHARS } from './constants.js';
import type { DevtoolsEvent, RequestEvent, RequestOrigin } from './events.js';
import { newId } from './ids.js';
import type { ParsedStack } from './initiator.js';
import { redactBodyText, redactHeaders } from './redact.js';
import { wallClock } from './clock.js';

/**
 * QaisDebugs — records one outgoing HTTP hop.
 *
 * Wraps the actual `fetch` call: the response is returned to the caller untouched and without
 * delay, while a clone of its body is read in the background, capped, redacted and recorded.
 */

export interface RecordFetchInput {
  id?: string;
  app: string;
  origin: RequestOrigin;
  method?: string;
  url: string;
  headers?: HeadersInit | null;
  body?: BodyInit | null;
  traceId?: string;
  parentId?: string;
  pagePath?: string;
  stack?: ParsedStack;
  record: (event: DevtoolsEvent) => void;
}

/** Response content types whose body is worth keeping. Anything else (files, images) is skipped. */
const TEXT_LIKE = /json|text|xml|javascript|x-www-form-urlencoded/i;

export async function recordFetch(input: RecordFetchInput, run: () => Promise<Response>): Promise<Response> {
  const startedAt = wallClock();
  const t0 = performance.now();
  const reqHeaders = redactHeaders(input.headers);
  const base: Omit<RequestEvent, 'durationMs' | 'resHeaders'> = {
    kind: 'request',
    id: input.id ?? newId(),
    traceId: input.traceId,
    parentId: input.parentId,
    pagePath: input.pagePath,
    app: input.app,
    origin: input.origin,
    method: (input.method ?? 'GET').toUpperCase(),
    url: input.url,
    startedAt,
    reqHeaders,
    reqBody: describeRequestBody(input.body, reqHeaders['content-type']),
    initiator: input.stack?.initiator,
    frames: input.stack?.frames,
  };

  let response: Response;
  try {
    response = await run();
  } catch (error) {
    safeRecord(input.record, {
      ...base,
      durationMs: performance.now() - t0,
      resHeaders: {},
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
    throw error;
  }

  const durationMs = performance.now() - t0;

  // Clone synchronously, before the caller gets the response and starts reading its body.
  let clone: Response | undefined;
  try {
    clone = response.clone();
  } catch {
    clone = undefined;
  }

  void captureResponse(input.record, base, response, clone, durationMs);

  return response;
}

async function captureResponse(
  record: (event: DevtoolsEvent) => void,
  base: Omit<RequestEvent, 'durationMs' | 'resHeaders'>,
  response: Response,
  clone: Response | undefined,
  durationMs: number
): Promise<void> {
  const contentType = response.headers.get('content-type') ?? undefined;
  const event: RequestEvent = {
    ...base,
    durationMs,
    status: response.status,
    statusText: response.statusText || undefined,
    resHeaders: redactHeaders(response.headers),
    contentType,
  };

  try {
    if (response.status === 204 || response.status === 304 || !clone?.body) {
      event.resBodySkipped = 'no body';
    } else if (!contentType || !TEXT_LIKE.test(contentType)) {
      event.resBodySkipped = contentType ?? 'no content-type';
    } else {
      const { text, truncated } = await readCapped(clone, BODY_CAP_BYTES);
      event.resBody = truncated ? text : redactBodyText(text, contentType);
      event.resBodyTruncated = truncated || undefined;
    }
  } catch (error) {
    event.resBodySkipped = `unreadable: ${error instanceof Error ? error.message : String(error)}`;
  }

  safeRecord(record, event);
}

async function readCapped(response: Response, cap: number): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) {
    return { text: await response.text(), truncated: false };
  }

  const decoder = new TextDecoder();
  let received = 0;
  let text = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    received += value.byteLength;

    if (received > cap) {
      const keep = value.byteLength - (received - cap);
      text += decoder.decode(value.subarray(0, keep), { stream: true });
      await reader.cancel();

      return { text, truncated: true };
    }

    text += decoder.decode(value, { stream: true });
  }

  text += decoder.decode();

  return { text, truncated: false };
}

export function describeRequestBody(body: BodyInit | null | undefined, contentType?: string): string | undefined {
  if (body === null || body === undefined) return undefined;

  if (typeof body === 'string') {
    return capText(redactBodyText(body, contentType));
  }

  if (body instanceof URLSearchParams) {
    const redacted = new URLSearchParams();
    body.forEach((value, key) => redacted.append(key, /token|password|secret|otp/i.test(key) ? '[redacted]' : value));

    return capText(redacted.toString());
  }

  if (body instanceof FormData) {
    const keys: string[] = [];
    body.forEach((_, key) => keys.push(key));

    return `[FormData: ${keys.join(', ')}]`;
  }

  if (body instanceof Blob) {
    return `[Blob ${body.type || 'unknown type'}, ${body.size} bytes]`;
  }

  if (body instanceof ArrayBuffer) return `[binary ${body.byteLength} bytes]`;
  if (ArrayBuffer.isView(body)) return `[binary ${body.byteLength} bytes]`;

  return '[stream]';
}

function capText(text: string): string {
  return text.length > REQUEST_BODY_CAP_CHARS
    ? `${text.slice(0, REQUEST_BODY_CAP_CHARS)}… [+${text.length - REQUEST_BODY_CAP_CHARS} chars]`
    : text;
}

function safeRecord(record: (event: DevtoolsEvent) => void, event: RequestEvent): void {
  try {
    record(event);
  } catch {
    // Recording must never affect the request.
  }
}
