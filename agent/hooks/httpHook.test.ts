import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { CLIENT_HEADER, PAGE_HEADER, SPAN_HEADER, TRACE_HEADER } from '../shared/constants.js';
import type { DevtoolsEvent, RequestEvent } from '../shared/events.js';
import { classifyIncoming, contextFor } from './httpHook.js';

function request(url: string, headers: Record<string, string> = {}, method = 'GET'): IncomingMessage {
  return { url, method, headers: { host: 'localhost:3020', ...headers } } as unknown as IncomingMessage;
}

function response(status = 200): ServerResponse & { finish: () => void } {
  const emitter = new EventEmitter();
  const res = Object.assign(emitter, {
    statusCode: status,
    statusMessage: 'OK',
    getHeaders: () => ({ 'content-type': 'text/html' }),
    getHeader: (name: string) => (name === 'content-type' ? 'text/html' : undefined),
    finish: () => emitter.emit('finish'),
  });

  return res as unknown as ServerResponse & { finish: () => void };
}

describe('classifyIncoming', () => {
  it('treats documents and RSC payloads as pages, API routes as browser calls, assets as noise', () => {
    expect(classifyIncoming(request('/en/contracts', { accept: 'text/html,*/*' }))).toBe('page');
    expect(classifyIncoming(request('/en/contracts?_rsc=abc', { rsc: '1', accept: '*/*' }))).toBe('page');
    expect(classifyIncoming(request('/api/orders', { accept: 'application/json' }))).toBe('browser');
    expect(classifyIncoming(request('/_next/static/chunks/main.js'))).toBeUndefined();
    expect(classifyIncoming(request('/__nextjs_launch-editor?file=x'))).toBeUndefined();
    expect(classifyIncoming(request('/en/__nextjs_original-stack-frames', {}, 'POST'))).toBeUndefined();
    expect(classifyIncoming(request('/icon.png'))).toBeUndefined();
  });
});

describe('contextFor', () => {
  it('starts a trace for a page request and records it when the response finishes', () => {
    const events: DevtoolsEvent[] = [];
    const res = response(200);

    const context = contextFor(request('/en/contracts?x=1', { accept: 'text/html' }), 'web', (event) => events.push(event), res);

    expect(context.pagePath).toBe('/en/contracts');
    expect(context.parentId).toBeDefined();
    expect(events).toHaveLength(0);

    res.finish();

    const event = events[0] as RequestEvent;
    expect(event).toMatchObject({ origin: 'page', method: 'GET', url: 'http://localhost:3020/en/contracts?x=1', status: 200, traceId: context.traceId, pagePath: '/en/contracts' });
    expect(event.id).toBe(context.parentId);

    res.finish();
    expect(events).toHaveLength(1);
  });

  it('only inherits the context for a loopback call this server made to itself', () => {
    const events: DevtoolsEvent[] = [];
    const res = response();

    const context = contextFor(
      request('/api/me', { [TRACE_HEADER]: 'trace-1', [SPAN_HEADER]: 'rsc-1', [PAGE_HEADER]: '/en/contracts' }),
      'web',
      (event) => events.push(event),
      res
    );
    res.finish();

    expect(context).toEqual({ traceId: 'trace-1', parentId: 'rsc-1', pagePath: '/en/contracts' });
    expect(events).toHaveLength(0);
  });

  it('records a browser API call as its own trace root with the referring page', () => {
    const events: DevtoolsEvent[] = [];
    const res = response(401);

    const context = contextFor(request('/api/orders', { accept: 'application/json', referer: 'http://localhost:3020/en/contracts' }, 'POST'), 'web', (event) => events.push(event), res);
    res.finish();

    expect(events[0]).toMatchObject({ origin: 'browser', method: 'POST', status: 401, traceId: context.traceId, pagePath: '/en/contracts' });
  });

  it("records a request from the page script under the script's id, so both halves merge", () => {
    const events: DevtoolsEvent[] = [];
    const res = response();

    const context = contextFor(request('/api/orders', { accept: 'application/json', [CLIENT_HEADER]: 'c0ffee00-1234-4abc-9def-000000000001' }), 'web', (event) => events.push(event), res);
    res.finish();

    expect(events[0].id).toBe('c0ffee00-1234-4abc-9def-000000000001');
    expect(context.parentId).toBe('c0ffee00-1234-4abc-9def-000000000001');
  });

  it('ignores a client id that is not a plain id', () => {
    const events: DevtoolsEvent[] = [];
    const res = response();

    contextFor(request('/api/orders', { accept: 'application/json', [CLIENT_HEADER]: '<script>' }), 'web', (event) => events.push(event), res);
    res.finish();

    expect(events[0].id).not.toBe('<script>');
  });

  it('gives assets a context but records nothing', () => {
    const events: DevtoolsEvent[] = [];
    const res = response();

    contextFor(request('/_next/static/x.js'), 'web', (event) => events.push(event), res);
    res.finish();

    expect(events).toHaveLength(0);
  });
});
