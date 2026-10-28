import { describe, expect, it } from 'vitest';
import type { LogEvent, RequestEvent } from '../agent/shared/events.js';
import { EventStore, parseSse } from './store';

const request = (id: string, extra: Partial<RequestEvent> = {}): RequestEvent => ({
  kind: 'request',
  id,
  app: 'web',
  origin: 'browser',
  method: 'POST',
  url: 'http://localhost:3000/api/login',
  status: 200,
  startedAt: 1000,
  durationMs: 40,
  reqHeaders: {},
  resHeaders: {},
  ...extra,
});
const log = (id: string, message: string): LogEvent => ({ kind: 'log', id, app: 'web', origin: 'server', level: 'log', args: [message], at: 1000 });

describe('parseSse', () => {
  it('returns complete messages and keeps a half-received one for later', () => {
    const { messages, rest } = parseSse('event: hello\ndata: {"a":1}\n\n: ping\n\nevent: events\ndata: [1]\n\nevent: ev');

    expect(messages).toEqual([
      { event: 'hello', data: '{"a":1}' },
      { event: 'events', data: '[1]' },
    ]);
    expect(rest).toBe('event: ev');
  });
});

describe('EventStore', () => {
  it("merges the page's and the server's half of a request, and drops repeated log lines", () => {
    const store = new EventStore('http://127.0.0.1:1');
    store.add([request('r1', { traceId: 't1' }), log('l1', 'hello')]);
    store.add([request('r1', { client: true, reqBody: '{"user":"kia"}', resBody: '{"ok":true}' }), log('l1', 'hello')]);

    expect(store.events).toHaveLength(2);
    expect(store.find('r1')).toMatchObject({ traceId: 't1', client: true, reqBody: '{"user":"kia"}', resBody: '{"ok":true}' });
  });

  it('finds events by a unique id prefix', () => {
    const store = new EventStore('http://127.0.0.1:1');
    store.add([request('abc12345-1'), request('abd99999-2')]);

    expect(store.find('abc1')?.id).toBe('abc12345-1');
    expect(store.find('ab')).toBeUndefined();
  });

  it('wakes a waiter on the next matching event, and times out otherwise', async () => {
    const store = new EventStore('http://127.0.0.1:1');
    const waiting = store.waitFor((event) => event.kind === 'log', 1000);
    store.add([request('r2'), log('l2', 'later')]);

    expect((await waiting)?.id).toBe('l2');
    expect(await store.waitFor(() => true, 20)).toBeUndefined();
  });

  it('keeps only the newest events', () => {
    const store = new EventStore('http://127.0.0.1:1', fetch, 3);
    store.add([log('a', '1'), log('b', '2'), log('c', '3'), log('d', '4')]);

    expect(store.events.map((event) => event.id)).toEqual(['b', 'c', 'd']);
    expect(store.find('a')).toBeUndefined();
  });
});
