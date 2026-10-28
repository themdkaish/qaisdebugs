import { describe, expect, it } from 'vitest';
import type { RequestEvent } from './events';
import { mergeRequest } from './mergeRequests';

const server: RequestEvent = {
  kind: 'request',
  id: 'r1',
  app: 'web',
  traceId: 't1',
  pagePath: '/en/fleet',
  origin: 'browser',
  method: 'POST',
  url: 'http://localhost:3000/api/login',
  status: 200,
  startedAt: 1000,
  durationMs: 40,
  reqHeaders: { cookie: 'session=[redacted]', 'x-qaisdebugs-client': 'r1' },
  resHeaders: { 'content-type': 'application/json' },
  resBodySkipped: 'the server does not keep what it sends to the browser',
};

const browser: RequestEvent = {
  kind: 'request',
  id: 'r1',
  app: 'web',
  pagePath: '/en/fleet',
  origin: 'browser',
  client: true,
  method: 'POST',
  url: 'http://localhost:3000/api/login',
  status: 200,
  startedAt: 990,
  durationMs: 65,
  reqHeaders: { 'content-type': 'application/json' },
  resHeaders: { 'content-type': 'application/json', 'x-total': '1' },
  reqBody: '{"user":"kia","password":"[redacted]"}',
  resBody: '{"ok":true}',
  initiator: { file: '/work/src/views/Login.tsx', line: 12, column: 3 },
};

describe('mergeRequest', () => {
  it("keeps the server's trace and status and adds the browser's bodies, timing and call site", () => {
    for (const merged of [mergeRequest(server, browser), mergeRequest(browser, server)]) {
      expect(merged).toMatchObject({
        id: 'r1',
        traceId: 't1',
        client: true,
        status: 200,
        startedAt: 990,
        durationMs: 65,
        reqBody: '{"user":"kia","password":"[redacted]"}',
        resBody: '{"ok":true}',
        resBodySkipped: undefined,
        initiator: { file: '/work/src/views/Login.tsx', line: 12 },
        reqHeaders: { cookie: 'session=[redacted]', 'content-type': 'application/json' },
      });
      expect(merged.reqHeaders).not.toHaveProperty('x-qaisdebugs-client');
      expect(merged).toMatchObject({
        resHeaders: { 'x-total': '1' },
      });
    }
  });

  it('keeps the browser error when the request failed in the page', () => {
    expect(mergeRequest(server, { ...browser, resBody: undefined, error: 'TypeError: Failed to fetch' }).error).toBe('TypeError: Failed to fetch');
  });
});
