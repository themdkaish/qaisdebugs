/**
 * QaisDebugs — redaction applied at capture time, before an event leaves the process.
 *
 * The collector and the UI never see a bearer token, a session cookie value or a password field,
 * so a stray JSONL file or a shared screenshot of the inspector cannot leak a credential.
 */

export const REDACTED = '[redacted]';

const SENSITIVE_HEADERS = new Set(['authorization', 'proxy-authorization', 'x-api-key', 'set-cookie']);

/** Keys (JSON fields, cookie names, query params) whose values are replaced. */
export const SENSITIVE_KEY = /token|password|secret|otp|authorization|credential/i;

/** The headers as a plain object with sensitive values replaced. Tolerates any `HeadersInit`. */
export function redactHeaders(headers?: HeadersInit | null): Record<string, string> {
  const out: Record<string, string> = {};

  for (const [name, value] of headerEntries(headers)) {
    out[name.toLowerCase()] = redactHeader(name, value);
  }

  return out;
}

export function redactHeader(name: string, value: string): string {
  const key = name.toLowerCase();

  if (SENSITIVE_HEADERS.has(key)) {
    return REDACTED;
  }

  if (key === 'cookie') {
    return redactCookieHeader(value);
  }

  return value;
}

/** Keeps cookie names so you can see which cookies travelled, hides the values of token-like ones. */
export function redactCookieHeader(value: string): string {
  return value
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf('=');
      if (eq === -1) return part;

      const name = part.slice(0, eq).trim();
      const cookieValue = part.slice(eq + 1);

      return SENSITIVE_KEY.test(name) ? `${name}=${REDACTED}` : `${name}=${cookieValue}`;
    })
    .join('; ');
}

/** A deep copy with every sensitive key's value replaced. Non-objects pass through. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object' || depth > 32) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1));
  }

  const out: Record<string, unknown> = {};

  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = item != null && SENSITIVE_KEY.test(key) ? REDACTED : redactValue(item, depth + 1);
  }

  return out;
}

/**
 * Redacts a body when it is JSON. Anything else is returned as it was, since a form-encoded or
 * text body carries no structure to walk; the token-refresh call is JSON, so that one is covered.
 */
export function redactBodyText(text: string, contentType?: string | null): string {
  if (!text) return text;

  const isJson = /json/i.test(contentType ?? '') || /^\s*[[{]/.test(text);
  if (!isJson) return text;

  try {
    return JSON.stringify(redactValue(JSON.parse(text)));
  } catch {
    return text;
  }
}

function headerEntries(headers?: HeadersInit | null): Array<[string, string]> {
  if (!headers) return [];

  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    const entries: Array<[string, string]> = [];
    headers.forEach((value, name) => entries.push([name, value]));

    return entries;
  }

  if (Array.isArray(headers)) {
    return headers.map(([name, value]) => [String(name), String(value)]);
  }

  // A plain object may carry values `Headers` would reject or mangle (undefined, a number).
  return Object.entries(headers)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([name, value]) => [name, String(value)]);
}
