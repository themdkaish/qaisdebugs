/**
 * QaisDebugs — how events read in a tool result: one line per item in lists, the full record on
 * request, bodies trimmed, and files relative to the repository so the model can open them.
 */
import type { DevtoolsEvent, ErrorEvent, LogEvent, RequestEvent, StackFrame } from '../agent/shared/events.js';

/** The 8-character id prefix shown in lists; any unique prefix works where a tool takes an id. */
export const shortId = (id: string): string => id.slice(0, 8);

export function clock(at: number): string {
  const date = new Date(at);
  const pad = (value: number, size = 2): string => String(value).padStart(size, '0');

  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

export function relative(file: string, root: string | undefined): string {
  if (!root) return file;
  const prefix = root.endsWith('/') ? root : `${root}/`;

  return file.startsWith(prefix) ? file.slice(prefix.length) : file;
}

export function where(frame: StackFrame | undefined, root: string | undefined): string {
  return frame ? `${relative(frame.file, root)}:${frame.line}` : '';
}

export function trim(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}… [+${value.length - max} chars; raise max_body_chars to see more]` : value;
}

export function duration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);

    return `${parsed.host}${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

export function requestLine(event: RequestEvent, root: string | undefined): string {
  const status = event.error ? `FAILED (${event.error})` : String(event.status ?? '…');
  const site = where(event.initiator, root);

  return `${shortId(event.id)}  ${clock(event.startedAt)}  ${event.app}  ${event.origin}${event.client ? '+page' : ''}  ${event.method} ${status}  ${duration(event.durationMs)}  ${shortUrl(event.url)}${site ? `  ← ${site}` : ''}`;
}

/** Console arguments as one line, the way a console prints them. */
export function argsText(args: unknown[], max = 600): string {
  const text = args
    .filter((arg, index) => !(index > 0 && typeof args[0] === 'string' && /%c/.test(args[0]) && typeof arg === 'string' && /:\s*[^;]+;/.test(arg)))
    .map((arg) => (typeof arg === 'string' ? arg.replace(/%[cs]/g, '').trim() : JSON.stringify(arg)))
    .filter(Boolean)
    .join(' ');

  return trim(text, max);
}

export function logLine(event: LogEvent | ErrorEvent, root: string | undefined): string {
  if (event.kind === 'error') {
    const firstStackLine = event.stack?.split('\n').find((line) => line.trim().startsWith('at '))?.trim();

    return `${shortId(event.id)}  ${clock(event.at)}  ${event.app}  ${event.origin}  ERROR  ${trim(event.message, 400)}${firstStackLine ? `  (${firstStackLine})` : ''}`;
  }
  const site = where(event.initiator, root);

  return `${shortId(event.id)}  ${clock(event.at)}  ${event.app}  ${event.origin}  ${event.level.toUpperCase()}  ${argsText(event.args)}${site ? `  ← ${site}` : ''}`;
}

function headerBlock(title: string, headers: Record<string, string>): string {
  const names = Object.keys(headers);
  if (!names.length) return `${title}: (none)`;

  return `${title}:\n${names.map((name) => `  ${name}: ${headers[name]}`).join('\n')}`;
}

export function requestDetail(event: RequestEvent, children: RequestEvent[], root: string | undefined, maxBody: number): string {
  const lines = [
    `${event.method} ${event.url}`,
    `id: ${event.id}   app: ${event.app}   origin: ${event.origin}${event.client ? ' (seen by the page and the server)' : ''}`,
    `status: ${event.error ? `FAILED: ${event.error}` : `${event.status ?? '…'} ${event.statusText ?? ''}`.trim()}   time: ${duration(event.durationMs)}   started: ${clock(event.startedAt)}`,
  ];
  if (event.pagePath) lines.push(`page: ${event.pagePath}${event.traceId ? `   trace: ${shortId(event.traceId)}` : ''}`);
  if (event.initiator) lines.push(`called from: ${where(event.initiator, root)}${event.initiator.fn ? ` (${event.initiator.fn})` : ''}`);
  if (event.frames && event.frames.length > 1) lines.push(`call stack:\n${event.frames.slice(0, 8).map((frame) => `  ${frame.fn ?? '(anonymous)'}  ${where(frame, root)}`).join('\n')}`);
  lines.push(headerBlock('request headers', event.reqHeaders));
  if (event.reqBody !== undefined) lines.push(`request body:\n${trim(event.reqBody, maxBody)}`);
  lines.push(headerBlock('response headers', event.resHeaders));
  if (event.resBody !== undefined) lines.push(`response body${event.resBodyTruncated ? ' (cut at capture)' : ''}:\n${trim(event.resBody, maxBody)}`);
  else if (event.resBodySkipped) lines.push(`response body: not captured (${event.resBodySkipped})`);
  if (children.length) lines.push(`calls made while handling it:\n${children.map((child) => `  ${requestLine(child, root)}`).join('\n')}`);

  return lines.join('\n');
}

/** A trace as an indented tree of requests, with the logs written while it ran. */
export function traceTree(events: DevtoolsEvent[], traceId: string, root: string | undefined): string {
  const inTrace = events.filter((event) => event.traceId === traceId);
  const requests = inTrace.filter((event): event is RequestEvent => event.kind === 'request').sort((a, b) => a.startedAt - b.startedAt);
  const ids = new Set(requests.map((request) => request.id));
  const childrenOf = (id: string | undefined): RequestEvent[] => requests.filter((request) => (id ? request.parentId === id : !request.parentId || !ids.has(request.parentId)));
  const lines: string[] = [];
  const walk = (request: RequestEvent, depth: number): void => {
    lines.push(`${'  '.repeat(depth)}${requestLine(request, root)}`);
    for (const child of childrenOf(request.id)) walk(child, depth + 1);
  };
  for (const top of childrenOf(undefined)) walk(top, 0);

  const logs = inTrace.filter((event): event is LogEvent | ErrorEvent => event.kind === 'log' || event.kind === 'error');
  if (logs.length) lines.push('', `logs in this trace (${logs.length}):`, ...logs.slice(0, 60).map((log) => `  ${logLine(log, root)}`));

  return lines.length ? lines.join('\n') : `no events recorded for trace ${traceId}`;
}
