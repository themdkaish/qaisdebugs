/**
 * QaisDebugs — the event model shared by the agent, the collector and the inspector UI.
 *
 * Types only. Keep this file free of runtime code so every runtime can import it.
 */

/**
 * Which hop produced a request event.
 * - `page`: a document or RSC-payload request arriving from the browser. The root of a trace.
 * - `browser`: a request arriving from the browser that is not a page: an API route or route
 *   handler called by client code.
 * - `server`: an outgoing fetch from server code to the dev server itself (a server component
 *   calling its own API route).
 * - `external`: an outgoing fetch from server code to another host (a backend, a third-party API).
 * - `other`: framework housekeeping (Next telemetry, version checks) or fetches with no application frame.
 */
export type RequestOrigin = 'page' | 'browser' | 'server' | 'external' | 'other';

export type LogOrigin = 'server' | 'browser';

export type LogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

export const LOG_LEVELS: readonly LogLevel[] = ['log', 'info', 'warn', 'error', 'debug'];

/** One source location from a parsed stack. `file` is absolute on the server. */
export interface StackFrame {
  file: string;
  line: number;
  column: number;
  fn?: string;
}

interface BaseEvent {
  id: string;
  /** The Next.js app that produced the event: its package name without scope, or its folder name. */
  app: string;
  /** The page request this event belongs to. */
  traceId?: string;
  /** The page path the trace started on. */
  pagePath?: string;
}

export interface RequestEvent extends BaseEvent {
  kind: 'request';
  /** The recorded hop this one was made from, when known. */
  parentId?: string;
  origin: RequestOrigin;
  method: string;
  url: string;
  status?: number;
  statusText?: string;
  /** Set when `fetch` rejected (transport failure, abort) instead of returning a response. */
  error?: string;
  /** Epoch ms when the hop started. */
  startedAt: number;
  durationMs: number;
  reqHeaders: Record<string, string>;
  resHeaders: Record<string, string>;
  reqBody?: string;
  resBody?: string;
  resBodyTruncated?: boolean;
  /** Why no response body was kept (binary content type, empty status, not captured for this hop). */
  resBodySkipped?: string;
  contentType?: string;
  /** The first application frame that made the call. */
  initiator?: StackFrame;
  /** Application frames of the call stack, innermost first. */
  frames?: StackFrame[];
  /** Recorded in the browser by the page script. A server event with the same id is the same request. */
  client?: boolean;
}

export interface LogEvent extends BaseEvent {
  kind: 'log';
  origin: LogOrigin;
  level: LogLevel;
  /** Console arguments, already made JSON-safe. */
  args: unknown[];
  at: number;
  initiator?: StackFrame;
  frames?: StackFrame[];
}

export interface ErrorEvent extends BaseEvent {
  kind: 'error';
  origin: LogOrigin;
  message: string;
  stack?: string;
  context?: unknown;
  at: number;
}

/** Sent once when an agent comes up, and again whenever its inspector endpoint changes. */
export interface AgentEvent extends BaseEvent {
  kind: 'agent';
  pid: number;
  /** The app directory the dev server runs in. */
  cwd: string;
  /** The repository (or workspace) root, when the app lives inside one. */
  repoRoot?: string;
  /** The top-level folders of the repository, for resolving source names that climb out of the app dir. */
  repoDirs?: string[];
  /** The app's package name, which webpack uses to name sources in its maps. */
  packageName?: string;
  /** Node's inspector WebSocket endpoint for this process, when it could be opened. */
  inspectorUrl?: string;
  devServerPort?: number;
  version: string;
  at: number;
}

export type DevtoolsEvent = RequestEvent | LogEvent | ErrorEvent | AgentEvent;
