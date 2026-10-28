import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * QaisDebugs — the request context every hop inherits.
 *
 * Set once per incoming HTTP request by the http hook. The fetch hook reads it to tag outgoing
 * calls, and the console hook reads it so a log line written while serving a request carries the
 * page's trace id. It crosses the loopback hop (server component → `/api/tj` on the same server)
 * through the `x-tj-*` headers the fetch hook injects.
 */
export interface RequestContext {
  traceId: string;
  /** The event id that hops made while serving this request nest under. */
  parentId?: string;
  pagePath?: string;
}

export interface ContextStore {
  get(): RequestContext | undefined;
  run<T>(context: RequestContext, fn: () => T): T;
}

export function createContextStore(): ContextStore {
  const storage = new AsyncLocalStorage<RequestContext>();

  return {
    get: () => storage.getStore(),
    run: (context, fn) => storage.run(context, fn),
  };
}
