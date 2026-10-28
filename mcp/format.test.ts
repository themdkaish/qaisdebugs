import { describe, expect, it } from 'vitest';
import type { LogEvent, RequestEvent } from '../agent/shared/events.js';
import { argsText, logLine, requestLine, traceTree } from './format';

const root = '/repo';
const base: RequestEvent = {
  kind: 'request',
  id: 'aaaaaaaa-1111',
  app: 'rental',
  traceId: 'trace-1',
  origin: 'page',
  method: 'GET',
  url: 'http://localhost:3000/en/fleet',
  status: 200,
  startedAt: new Date(2026, 9, 27, 13, 5, 1, 7).getTime(),
  durationMs: 1250,
  reqHeaders: {},
  resHeaders: {},
};

describe('requestLine', () => {
  it('shows id, time, app, origin, method, status, time, URL and call site on one line', () => {
    const line = requestLine({ ...base, origin: 'browser', client: true, initiator: { file: '/repo/src/views/Fleet.tsx', line: 42, column: 3 } }, root);

    expect(line).toBe('aaaaaaaa  13:05:01.007  rental  browser+page  GET 200  1.25 s  localhost:3000/en/fleet  ← src/views/Fleet.tsx:42');
  });

  it('says why a request failed', () => {
    expect(requestLine({ ...base, status: undefined, error: 'ECONNREFUSED' }, root)).toContain('GET FAILED (ECONNREFUSED)');
  });
});

describe('logLine and argsText', () => {
  it("prints console arguments the way the console shows them, without Next's styling", () => {
    expect(argsText(['%c%s%c Fetched user:', 'background: #e6e6e6; color: #000;', ' Server ', '', 'Kia', { id: 1 }])).toBe('Fetched user: Server Kia {"id":1}');
    const event: LogEvent = { kind: 'log', id: 'bbbbbbbb-2', app: 'rental', origin: 'browser', level: 'warn', args: ['low stock', 3], at: base.startedAt, initiator: { file: '/repo/app/Cart.tsx', line: 9, column: 1 } };
    expect(logLine(event, root)).toBe('bbbbbbbb  13:05:01.007  rental  browser  WARN  low stock 3  ← app/Cart.tsx:9');
  });
});

describe('traceTree', () => {
  it('nests the calls under the request that made them, with the trace logs below', () => {
    const child: RequestEvent = { ...base, id: 'cccccccc-3', parentId: base.id, origin: 'external', url: 'https://api.example.com/vehicles', durationMs: 300 };
    const tree = traceTree([base, child, { kind: 'log', id: 'dddddddd-4', app: 'rental', traceId: 'trace-1', origin: 'server', level: 'log', args: ['loaded'], at: base.startedAt }], 'trace-1', root);

    expect(tree.split('\n').slice(0, 2)).toEqual([expect.stringMatching(/^aaaaaaaa .* localhost:3000\/en\/fleet$/), expect.stringMatching(/^ {2}cccccccc .* api\.example\.com\/vehicles$/)]);
    expect(tree).toContain('logs in this trace (1):');
  });
});
