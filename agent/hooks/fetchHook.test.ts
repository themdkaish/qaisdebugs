import { describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '../context.js';
import { PAGE_HEADER, SPAN_HEADER, TRACE_HEADER } from '../shared/constants.js';
import type { DevtoolsEvent, RequestEvent } from '../shared/events.js';
import { classifyOutgoing, createFetchWrapper } from './fetchHook.js';

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function setup(context?: RequestContext) {
  const events: DevtoolsEvent[] = [];
  const original = vi.fn(async () => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }));
  const wrapped = createFetchWrapper(
    {
      app: 'web',
      stackOptions: { cwd: '/repo/apps/web', repoRoot: '/repo', packageName: '@acme/web' },
      collectorUrl: 'http://127.0.0.1:4983',
      record: (event) => events.push(event),
      getContext: () => context,
      isSelf: (url) => url.port === '3020',
    },
    original
  );

  return { events, original, wrapped };
}

const sentHeaders = (original: ReturnType<typeof vi.fn>): Headers => new Headers((original.mock.calls[0][1] as RequestInit).headers);

describe('fetch hook', () => {
  it('tags a loopback call with the trace, span and page headers and records it as server', async () => {
    const { events, original, wrapped } = setup({ traceId: 'trace-1', parentId: 'page-1', pagePath: '/en/contracts' });

    await wrapped('http://localhost:3020/api/me', { headers: { accept: 'application/json' } });
    await settle();

    const headers = sentHeaders(original);
    expect(headers.get(TRACE_HEADER)).toBe('trace-1');
    expect(headers.get(PAGE_HEADER)).toBe('/en/contracts');
    expect(headers.get('accept')).toBe('application/json');

    const event = events[0] as RequestEvent;
    expect(event).toMatchObject({ origin: 'server', traceId: 'trace-1', parentId: 'page-1', pagePath: '/en/contracts', status: 200 });
    expect(headers.get(SPAN_HEADER)).toBe(event.id);
  });

  it('strips the trace headers from an external call so they never reach a backend', async () => {
    const { events, original, wrapped } = setup({ traceId: 'trace-1', parentId: 'rsc-1' });

    await wrapped('https://api.test/v1/orders', { headers: { [TRACE_HEADER]: 'trace-1', [SPAN_HEADER]: 'rsc-1', authorization: 'Bearer x' } });
    await settle();

    const headers = sentHeaders(original);
    expect(headers.has(TRACE_HEADER)).toBe(false);
    expect(headers.has(SPAN_HEADER)).toBe(false);
    expect(headers.get('authorization')).toBe('Bearer x');
    expect((events[0] as RequestEvent).parentId).toBe('rsc-1');
  });

  it('passes the agent\'s own traffic to the collector through untouched', async () => {
    const { events, original, wrapped } = setup();

    await wrapped('http://127.0.0.1:4983/ingest', { method: 'POST' });
    await settle();

    expect(original).toHaveBeenCalledWith('http://127.0.0.1:4983/ingest', { method: 'POST' });
    expect(events).toHaveLength(0);
  });

  it('keeps the headers of a Request object when no init headers are given', async () => {
    const { original, wrapped } = setup({ traceId: 't', parentId: 'p' });

    await wrapped(new Request('http://localhost:3020/api/x', { headers: { cookie: 'a=1' } }));

    expect(sentHeaders(original).get('cookie')).toBe('a=1');
    expect(sentHeaders(original).get(TRACE_HEADER)).toBe('t');
  });
});

describe('classifyOutgoing', () => {
  const frame = { file: '/repo/apps/web/src/app/api/orders/route.ts', line: 1, column: 1 };

  it('names the hops', () => {
    expect(classifyOutgoing(new URL('http://localhost:3020/api/x'), true, { frames: [] })).toBe('server');
    expect(classifyOutgoing(new URL('https://api.test/v1/orders'), false, { frames: [frame], initiator: frame })).toBe('external');
  });

  it('files framework housekeeping and frameless calls under other', () => {
    expect(classifyOutgoing(new URL('https://telemetry.nextjs.org/api/v1/record'), false, { frames: [frame] })).toBe('other');
    expect(classifyOutgoing(new URL('https://o123.ingest.de.sentry.io/api/1/envelope/'), false, { frames: [] })).toBe('other');
    expect(classifyOutgoing(new URL('https://api.test/anything'), false, { frames: [] })).toBe('other');
  });
});
