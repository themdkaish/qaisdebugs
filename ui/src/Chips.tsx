import type { LogLevel, RequestEvent, RequestOrigin } from './events';
import { type StatusTone, statusTone } from './format';

const ORIGIN_STYLE: Record<RequestOrigin, string> = {
  page: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  browser: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
  server: 'bg-violet-500/15 text-violet-300 ring-violet-500/30',
  external: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  other: 'bg-zinc-500/15 text-zinc-400 ring-zinc-500/30',
};

export const ORIGIN_LABEL: Record<RequestOrigin, string> = {
  page: 'page request from the browser',
  browser: 'request from browser code',
  server: 'server code → own route',
  external: 'server code → external host',
  other: 'framework housekeeping',
};

const APP_PALETTE = [
  'bg-teal-500/15 text-teal-300 ring-teal-500/30',
  'bg-indigo-500/15 text-indigo-300 ring-indigo-500/30',
  'bg-orange-500/15 text-orange-300 ring-orange-500/30',
  'bg-fuchsia-500/15 text-fuchsia-300 ring-fuchsia-500/30',
  'bg-lime-500/15 text-lime-300 ring-lime-500/30',
  'bg-cyan-500/15 text-cyan-300 ring-cyan-500/30',
  'bg-rose-500/15 text-rose-300 ring-rose-500/30',
  'bg-yellow-500/15 text-yellow-300 ring-yellow-500/30',
];

const LEVEL_STYLE: Record<LogLevel, string> = {
  log: 'bg-zinc-500/15 text-zinc-300 ring-zinc-500/30',
  info: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
  debug: 'bg-zinc-500/15 text-zinc-400 ring-zinc-500/30',
  warn: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  error: 'bg-red-500/15 text-red-300 ring-red-500/30',
};

const TONE_STYLE: Record<StatusTone, string> = {
  ok: 'text-emerald-300',
  redirect: 'text-sky-300',
  client: 'text-amber-300',
  server: 'text-red-300',
  error: 'text-red-400',
  pending: 'text-zinc-500',
};

const base = 'inline-flex items-center whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium leading-4 ring-1 ring-inset';

/** A stable colour per app name, so several apps stay apart at a glance. */
export function appStyle(app: string): string {
  let hash = 0;
  for (const char of app) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;

  return APP_PALETTE[hash % APP_PALETTE.length];
}

export function OriginChip({ origin }: { origin: RequestOrigin }): JSX.Element {
  return <span className={`${base} ${ORIGIN_STYLE[origin] ?? ORIGIN_STYLE.other}`}>{origin}</span>;
}

export function AppChip({ app }: { app: string }): JSX.Element {
  return (
    <span className={`${base.replace('inline-flex items-center', 'inline-block align-middle')} ${appStyle(app)} max-w-[9rem] truncate`} title={app}>
      {app}
    </span>
  );
}

export function LevelChip({ level }: { level: LogLevel | 'error!' }): JSX.Element {
  const style = level === 'error!' ? LEVEL_STYLE.error : LEVEL_STYLE[level];

  return <span className={`${base} ${style}`}>{level === 'error!' ? 'captured' : level}</span>;
}

export function StatusText({ event }: { event: RequestEvent }): JSX.Element {
  const tone = statusTone(event);
  const text = event.error ? 'ERR' : event.status ?? '…';

  return (
    <span className={`font-mono text-xs font-semibold ${TONE_STYLE[tone]}`} title={event.error ?? event.statusText}>
      {text}
    </span>
  );
}
