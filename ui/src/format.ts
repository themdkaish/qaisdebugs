import type { RequestEvent } from './events';

export function formatTime(ms: number): string {
  const date = new Date(ms);

  return `${date.toLocaleTimeString('en-GB', { hour12: false })}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

export function formatBytes(bytes?: number): string {
  if (bytes === undefined || Number.isNaN(bytes)) return '–';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;

  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function responseSize(event: RequestEvent): number | undefined {
  const length = event.resHeaders['content-length'];
  if (length) return Number(length);
  if (event.resBody) return new Blob([event.resBody]).size;

  return undefined;
}

export function displayPath(url: string): string {
  try {
    const parsed = new URL(url);

    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

export function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

export type StatusTone = 'ok' | 'redirect' | 'client' | 'server' | 'error' | 'pending';

export function statusTone(event: RequestEvent): StatusTone {
  if (event.error) return 'error';
  const status = event.status ?? 0;
  if (status >= 500) return 'server';
  if (status >= 400) return 'client';
  if (status >= 300) return 'redirect';
  if (status >= 200) return 'ok';

  return 'pending';
}

export function parseJson(text?: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

let knownRepoRoot = '';

/** Set once the collector reports where the repository is, so paths can be shown relative to it. */
export function setRepoRoot(root: string): void {
  knownRepoRoot = root.replace(/\/$/, '');
}

/** The path relative to the repository, else its last three segments. */
export function shortFile(file: string): string {
  if (knownRepoRoot && file.startsWith(`${knownRepoRoot}/`)) return file.slice(knownRepoRoot.length + 1);

  return file.split('/').slice(-3).join('/');
}

export function argsToText(args: unknown[]): string {
  return args
    .map((arg) => (typeof arg === 'string' ? arg : arg !== null && typeof arg === 'object' ? JSON.stringify(arg) : String(arg)))
    .join(' ');
}
