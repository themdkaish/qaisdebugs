import type { DevtoolsEvent } from './events.js';

/**
 * QaisDebugs — batches events and posts them to the collector.
 *
 * Fire-and-forget by design: a dev server must never slow down or fail because the inspector is
 * not running. Events are queued, flushed on a short timer, and kept (up to a cap) while the
 * collector is unreachable, with a single warning and a slow retry.
 */

export interface BusOptions {
  collectorUrl: string;
  /** Resolved at call time so the agent is independent of how the host runtime patches `fetch`. */
  fetchImpl: (input: string, init: RequestInit) => Promise<Response>;
  warn: (message: string) => void;
  flushIntervalMs?: number;
  retryIntervalMs?: number;
  maxQueue?: number;
  batchSize?: number;
  /**
   * Runs `run` after about `delayMs`. Defaults to an unref'd timer. The page script passes its own:
   * browsers throttle timers in background tabs to once a minute.
   */
  schedule?: (run: () => void, delayMs: number) => void;
}

function scheduleWithTimer(run: () => void, delayMs: number): void {
  const timer = setTimeout(run, delayMs);
  // Never keep a Node process alive just to deliver debug events.
  (timer as { unref?: () => void }).unref?.();
}

export interface Bus {
  enqueue(event: DevtoolsEvent): void;
  flush(): Promise<void>;
  /** How many events are waiting. Exposed for tests. */
  size(): number;
}

export function createBus(options: BusOptions): Bus {
  const flushIntervalMs = options.flushIntervalMs ?? 250;
  const retryIntervalMs = options.retryIntervalMs ?? 5000;
  const maxQueue = options.maxQueue ?? 2000;
  const batchSize = options.batchSize ?? 200;
  const ingestUrl = `${options.collectorUrl.replace(/\/$/, '')}/ingest`;

  const queue: DevtoolsEvent[] = [];
  const scheduleRun = options.schedule ?? scheduleWithTimer;
  let scheduled = false;
  let flushing = false;
  let down = false;
  let warned = false;

  const trimQueue = (): void => {
    if (queue.length > maxQueue) {
      queue.splice(0, queue.length - maxQueue);
    }
  };

  const schedule = (delay: number): void => {
    if (scheduled) return;
    scheduled = true;

    scheduleRun(() => {
      scheduled = false;
      void flush();
    }, delay);
  };

  const flush = async (): Promise<void> => {
    if (flushing || queue.length === 0) return;

    flushing = true;
    const batch = queue.splice(0, batchSize);

    try {
      const body = JSON.stringify({ events: batch });
      const response = await options.fetchImpl(ingestUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        cache: 'no-store',
        // Browsers refuse keepalive bodies over 64 KB; Node ignores the flag.
        keepalive: body.length < 60_000,
      });

      if (!response.ok) {
        throw new Error(`collector answered ${response.status}`);
      }

      if (down) {
        down = false;
        options.warn('collector reachable again, buffered events delivered');
      }
    } catch (error) {
      queue.unshift(...batch);
      trimQueue();

      // The first failure is usually the collector still starting (the agent starts it on demand),
      // so the warning waits for a second consecutive failure.
      if (down && !warned) {
        warned = true;
        const reason = error instanceof Error ? error.message : String(error);
        options.warn(
          `cannot reach the collector at ${options.collectorUrl} (${reason}). ` +
            'Events are buffered; start it with `npx qaisdebugs`.'
        );
      }
      down = true;
    } finally {
      flushing = false;

      if (queue.length > 0) {
        schedule(down ? retryIntervalMs : flushIntervalMs);
      }
    }
  };

  return {
    enqueue(event) {
      queue.push(event);
      trimQueue();
      schedule(down ? retryIntervalMs : flushIntervalMs);
    },
    flush,
    size: () => queue.length,
  };
}
