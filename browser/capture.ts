/**
 * QaisDebugs — the page script's pure helpers: which requests to record, how to describe a body
 * and how to read a capped response.
 */
/** `same`: this dev server (tagged so it merges with the server row). `cross`: another host. */
export type UrlKind = 'same' | 'cross' | 'skip';

/** Next's own dev traffic: static chunks, HMR, error overlay helpers. */
const FRAMEWORK_PATH = /^\/(_next\/|__nextjs|__webpack_hmr|on-demand-entries)/;

export function classifyUrl(url: URL, pageOrigin: string, collectorOrigin: string): UrlKind {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'skip';
  if (url.origin === collectorOrigin) return 'skip';
  if (url.origin !== pageOrigin) return 'cross';

  return FRAMEWORK_PATH.test(url.pathname) ? 'skip' : 'same';
}

/** A readable form of whatever was passed as a request body, capped at `cap` characters. */
export function describeBody(body: unknown, cap: number): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return capText(body, cap);
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return capText(body.toString(), cap);
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const lines: string[] = [];
    body.forEach((value, name) => {
      lines.push(typeof value === 'string' ? `${name}=${value}` : `${name}=[File ${(value as File).name} ${(value as File).size} bytes]`);
    });

    return capText(lines.join('\n'), cap);
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) return `[Blob ${body.type || 'binary'} ${body.size} bytes]`;
  if (body instanceof ArrayBuffer) return `[${body.byteLength} bytes]`;
  if (ArrayBuffer.isView(body)) return `[${body.byteLength} bytes]`;
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) return '[stream]';

  return capText(String(body), cap);
}

/** Whether a response body is text worth keeping. Event streams never end, so they are left alone. */
export function isTextual(contentType: string | null | undefined): boolean {
  if (!contentType) return true;
  if (/event-stream/i.test(contentType)) return false;

  return /json|text|xml|javascript|x-component|form-urlencoded|graphql/i.test(contentType);
}

/** Reads a response (a clone) up to `cap` bytes, cancelling the rest. */
export async function readCapped(response: Response, cap: number): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: await response.text(), truncated: false };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    text += decoder.decode(value, { stream: true });
    if (size > cap) {
      void reader.cancel().catch(() => undefined);

      return { text: text.slice(0, cap), truncated: true };
    }
  }

  return { text: text + decoder.decode(), truncated: false };
}

export function capText(text: string, cap: number): string {
  return text.length > cap ? `${text.slice(0, cap)}… [+${text.length - cap} chars]` : text;
}

/** Response headers from `XMLHttpRequest.getAllResponseHeaders()`. */
export function parseRawHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of raw.trim().split(/[\r\n]+/)) {
    const index = line.indexOf(':');
    if (index > 0) headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }

  return headers;
}
