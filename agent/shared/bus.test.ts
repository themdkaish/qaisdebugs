import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { type Bus, createBus } from './bus.js';
import type { DevtoolsEvent } from './events.js';

const event = (id: string): DevtoolsEvent => ({
  kind: 'log',
  id,
  app: 'web',
  origin: 'server',
  level: 'log',
  args: [],
  at: 0,
});

describe('createBus', () => {
  let fetchImpl: ReturnType<typeof vi.fn>;
  let warn: ReturnType<typeof vi.fn>;
  let bus: Bus;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    warn = vi.fn();
    bus = createBus({ collectorUrl: 'http://127.0.0.1:1/', fetchImpl, warn, flushIntervalMs: 10, retryIntervalMs: 100 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('posts queued events as one batch to /ingest after the flush interval', async () => {
    bus.enqueue(event('a'));
    bus.enqueue(event('b'));

    expect(fetchImpl).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:1/ingest');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body).events.map((e: DevtoolsEvent) => e.id)).toEqual(['a', 'b']);
    expect(bus.size()).toBe(0);
  });

  it('keeps events, warns once and retries slowly while the collector is down', async () => {
    fetchImpl.mockRejectedValue(new Error('ECONNREFUSED'));
    bus.enqueue(event('a'));

    await vi.advanceTimersByTimeAsync(10);
    expect(bus.size()).toBe(1);
    expect(warn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('npx qaisdebugs');

    await vi.advanceTimersByTimeAsync(100);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('delivers the buffer once the collector is back, quietly when it was only starting', async () => {
    fetchImpl.mockRejectedValueOnce(new Error('down'));
    bus.enqueue(event('a'));
    await vi.advanceTimersByTimeAsync(10);

    fetchImpl.mockResolvedValue({ ok: true });
    await vi.advanceTimersByTimeAsync(100);

    expect(bus.size()).toBe(0);
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('reachable again'));
  });

  it('treats a non-2xx answer as a failure', async () => {
    fetchImpl.mockResolvedValue({ ok: false, status: 500 });
    bus.enqueue(event('a'));

    await vi.advanceTimersByTimeAsync(10);

    expect(bus.size()).toBe(1);
  });

  it('drops the oldest events beyond the queue cap', async () => {
    fetchImpl.mockRejectedValue(new Error('down'));
    const small = createBus({ collectorUrl: 'http://c', fetchImpl, warn, maxQueue: 2, flushIntervalMs: 10 });
    small.enqueue(event('a'));
    small.enqueue(event('b'));
    small.enqueue(event('c'));

    expect(small.size()).toBe(2);
    await vi.advanceTimersByTimeAsync(10);
    small.enqueue(event('d'));
    expect(small.size()).toBe(2);
  });
});
