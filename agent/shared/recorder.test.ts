import { describe, expect, it } from 'vitest';
import type { DevtoolsEvent, RequestEvent } from './events.js';
import { recordFetch } from './recorder.js';
import { REDACTED } from './redact.js';

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function sink(): { events: DevtoolsEvent[]; record: (event: DevtoolsEvent) => void } {
  const events: DevtoolsEvent[] = [];

  return { events, record: (event) => events.push(event) };
}

const last = (events: DevtoolsEvent[]): RequestEvent => events[events.length - 1] as RequestEvent;

describe('recordFetch', () => {
  it('returns the response untouched and records the hop with redacted headers and body', async () => {
    const { events, record } = sink();
    const response = new Response(JSON.stringify({ accessToken: 't', id: 1 }), {
      status: 201,
      headers: { 'content-type': 'application/json', 'set-cookie': 'tj-access-token=x' },
    });

    const result = await recordFetch(
      {
        id: 'req-1',
        app: 'web',
        origin: 'external',
        method: 'post',
        url: 'https://api.test/v1/x',
        headers: { authorization: 'Bearer t', cookie: 'tj-access-token=a; lang=en' },
        body: JSON.stringify({ refreshToken: 'r', note: 'n' }),
        traceId: 'trace',
        parentId: 'parent',
        pagePath: '/en/x',
        record,
      },
      async () => response
    );

    expect(result).toBe(response);
    await expect(result.json()).resolves.toEqual({ accessToken: 't', id: 1 });
    await settle();

    expect(last(events)).toMatchObject({
      kind: 'request',
      id: 'req-1',
      app: 'web',
      origin: 'external',
      method: 'POST',
      url: 'https://api.test/v1/x',
      traceId: 'trace',
      parentId: 'parent',
      pagePath: '/en/x',
      status: 201,
      contentType: 'application/json',
      reqHeaders: { authorization: REDACTED, cookie: `tj-access-token=${REDACTED}; lang=en` },
      resHeaders: { 'content-type': 'application/json', 'set-cookie': REDACTED },
      reqBody: `{"refreshToken":"${REDACTED}","note":"n"}`,
      resBody: `{"accessToken":"${REDACTED}","id":1}`,
    });
    expect(last(events).durationMs).toBeGreaterThanOrEqual(0);
  });

  it('keeps the body even when the caller never reads the original', async () => {
    const { events, record } = sink();

    await recordFetch({ app: 'web', origin: 'server', url: 'http://a', record }, async () => new Response('hello', { headers: { 'content-type': 'text/plain' } }));
    await settle();

    expect(last(events).resBody).toBe('hello');
  });

  it('skips binary and empty bodies instead of reading them', async () => {
    const { events, record } = sink();

    await recordFetch({ app: 'web', origin: 'external', url: 'http://a', record }, async () => new Response(new Uint8Array(10), { headers: { 'content-type': 'application/pdf' } }));
    await recordFetch({ app: 'web', origin: 'external', url: 'http://b', record }, async () => new Response(null, { status: 204 }));
    await settle();

    expect((events[0] as RequestEvent).resBodySkipped).toBe('application/pdf');
    expect((events[0] as RequestEvent).resBody).toBeUndefined();
    expect((events[1] as RequestEvent).resBodySkipped).toBe('no body');
  });

  it('truncates a long body and flags it', async () => {
    const { events, record } = sink();
    const big = 'a'.repeat(300 * 1024);

    const result = await recordFetch({ app: 'web', origin: 'server', url: 'http://a', record }, async () => new Response(big, { headers: { 'content-type': 'text/plain' } }));
    await expect(result.text()).resolves.toHaveLength(big.length);
    await settle();

    expect(last(events).resBodyTruncated).toBe(true);
    expect(last(events).resBody).toHaveLength(256 * 1024);
  });

  it('records a transport failure and rethrows it', async () => {
    const { events, record } = sink();
    const failure = new TypeError('fetch failed');

    await expect(recordFetch({ app: 'web', origin: 'external', url: 'http://a', record }, () => Promise.reject(failure))).rejects.toBe(failure);

    expect(last(events).error).toBe('TypeError: fetch failed');
    expect(last(events).status).toBeUndefined();
  });

  it('describes non-string request bodies without reading them', async () => {
    const { events, record } = sink();
    const form = new FormData();
    form.append('File', new Blob(['x']), 'x.txt');
    form.append('CompanyId', '5');
    const params = new URLSearchParams({ otp: '1234', page: '1' });

    await recordFetch({ app: 'web', origin: 'browser', url: 'http://a', body: form, record }, async () => new Response(null, { status: 204 }));
    await recordFetch({ app: 'web', origin: 'browser', url: 'http://b', body: params, record }, async () => new Response(null, { status: 204 }));
    await recordFetch({ app: 'web', origin: 'browser', url: 'http://c', body: new Uint8Array(3), record }, async () => new Response(null, { status: 204 }));
    await settle();

    expect((events[0] as RequestEvent).reqBody).toBe('[FormData: File, CompanyId]');
    expect((events[1] as RequestEvent).reqBody).toBe('otp=%5Bredacted%5D&page=1');
    expect((events[2] as RequestEvent).reqBody).toBe('[binary 3 bytes]');
  });

  it('never lets a throwing sink affect the caller', async () => {
    const response = new Response('ok', { headers: { 'content-type': 'text/plain' } });

    await expect(
      recordFetch(
        {
          app: 'web',
          origin: 'server',
          url: 'http://a',
          record: () => {
            throw new Error('sink broken');
          },
        },
        async () => response
      )
    ).resolves.toBe(response);
    await settle();
  });
});
