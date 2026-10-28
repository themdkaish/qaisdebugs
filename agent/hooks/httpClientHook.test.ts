import http from 'node:http';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DevtoolsEvent, RequestEvent } from '../shared/events.js';
import { isCollector } from './fetchHook.js';
import { installHttpClientHook } from './httpClientHook.js';

let server: http.Server;
let base: string;
const received: http.IncomingHttpHeaders[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    received.push(req.headers);
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (req.url === '/gzip') {
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        res.end(zlib.gzipSync(JSON.stringify({ zipped: true, token: 'secret-token' })));
        return;
      }
      if (req.url === '/image') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(Buffer.from([1, 2, 3]));
        return;
      }
      res.writeHead(201, { 'content-type': 'application/json', 'set-cookie': 'session=abc' });
      res.end(JSON.stringify({ path: req.url, echo: body ? JSON.parse(body) : null, accessToken: 'abc123' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

let uninstall: (() => void) | undefined;
afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  received.length = 0;
});

function hook(overrides: { isSelf?: (url: URL) => boolean; collectorUrl?: string } = {}) {
  const events: RequestEvent[] = [];
  uninstall = installHttpClientHook({
    app: 'web',
    stackOptions: { cwd: '/repo/apps/web' },
    collectorUrl: overrides.collectorUrl ?? 'http://127.0.0.1:9',
    record: (event: DevtoolsEvent) => events.push(event as RequestEvent),
    getContext: () => ({ traceId: 'trace-1', parentId: 'span-0', pagePath: '/dashboard' }),
    isSelf: overrides.isSelf ?? (() => false),
  });

  return events;
}

/** Waits until `count` events were recorded, so assertions never race the response. */
async function settle(events: unknown[], count = 1): Promise<void> {
  for (let attempt = 0; attempt < 100 && events.length < count; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
}

function request(url: string, options: http.RequestOptions = {}, body?: string): Promise<{ status?: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('installHttpClientHook', () => {
  it('records a GET with its status, headers and JSON body, while the caller still gets the whole body', async () => {
    const events = hook();

    const result = await request(`${base}/users?page=2`, { headers: { authorization: 'Bearer real-token' } });
    await settle(events);

    expect(JSON.parse(result.text)).toMatchObject({ path: '/users?page=2', accessToken: 'abc123' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'request',
      app: 'web',
      method: 'GET',
      url: `${base}/users?page=2`,
      status: 201,
      traceId: 'trace-1',
      parentId: 'span-0',
      pagePath: '/dashboard',
      contentType: 'application/json',
    });
    expect(events[0].reqHeaders.authorization).not.toContain('real-token');
    expect(events[0].resHeaders['set-cookie']).not.toContain('abc');
    expect(events[0].resBody).toContain('/users?page=2');
    expect(events[0].resBody).not.toContain('abc123');
    expect(events[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records a POST body with credentials redacted', async () => {
    const events = hook();

    await request(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/json' } }, JSON.stringify({ email: 'a@b.c', password: 'hunter2' }));
    await settle(events);

    expect(events[0].method).toBe('POST');
    expect(events[0].reqBody).toContain('a@b.c');
    expect(events[0].reqBody).not.toContain('hunter2');
  });

  it('decodes a gzip response as axios receives it, and still redacts it', async () => {
    const events = hook();

    await new Promise<void>((resolve, reject) => {
      http
        .get(`${base}/gzip`, { headers: { 'accept-encoding': 'gzip' } }, (res) => {
          res.pipe(zlib.createGunzip()).on('data', () => undefined).on('end', () => resolve());
        })
        .on('error', reject);
    });
    await settle(events);

    expect(events[0].resBody).toContain('"zipped":true');
    expect(events[0].resBody).not.toContain('secret-token');
  });

  it('decodes the body even when the client deletes content-encoding, as axios does', async () => {
    const events = hook();

    await new Promise<void>((resolve, reject) => {
      http
        .get(`${base}/gzip`, { headers: { 'accept-encoding': 'gzip' } }, (res) => {
          delete res.headers['content-encoding'];
          res.pipe(zlib.createGunzip()).on('data', () => undefined).on('end', () => resolve());
        })
        .on('error', reject);
    });
    await settle(events);

    expect(events[0].resHeaders['content-encoding']).toBe('gzip');
    expect(events[0].resBody).toContain('"zipped":true');
  });

  it('skips bodies that are not text', async () => {
    const events = hook();

    await request(`${base}/image`);
    await settle(events);

    expect(events[0].resBody).toBeUndefined();
    expect(events[0].resBodySkipped).toBe('image/png');
  });

  it('records a refused connection without taking over the caller error handling', async () => {
    const events = hook();

    await expect(request('http://127.0.0.1:1/down')).rejects.toThrow(/ECONNREFUSED/);
    await settle(events);

    expect(events).toHaveLength(1);
    expect(events[0].error).toMatch(/ECONNREFUSED/);
    expect(events[0].status).toBeUndefined();
  });

  it('does not change how a caller that reads the body late receives it', async () => {
    const events = hook();

    const text = await new Promise<string>((resolve, reject) => {
      http
        .get(`${base}/late`, (res) => {
          setTimeout(() => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => (body += chunk));
            res.on('end', () => resolve(body));
          }, 50);
        })
        .on('error', reject);
    });
    await settle(events);

    expect(JSON.parse(text).path).toBe('/late');
    expect(events[0].resBody).toContain('/late');
  });

  it('adds the trace headers to a loopback call to this dev server', async () => {
    const events = hook({ isSelf: () => true });

    await request(`${base}/api/self`);
    await settle(events);

    expect(events[0].origin).toBe('server');
    expect(received[0]['x-qaisdebugs-trace']).toBe('trace-1');
    expect(received[0]['x-qaisdebugs-span']).toBe(events[0].id);
    expect(received[0]['x-qaisdebugs-page']).toBe('/dashboard');
  });

  it('treats only the exact collector origin as the collector, not a port that starts the same', () => {
    expect(isCollector(new URL('http://127.0.0.1:4983/ingest'), 'http://127.0.0.1:4983')).toBe(true);
    expect(isCollector(new URL('http://127.0.0.1:49830/api'), 'http://127.0.0.1:4983')).toBe(false);
  });

  it("ignores the agent's own calls to the collector", async () => {
    const events = hook({ collectorUrl: base });

    await request(`${base}/ingest`);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(events).toHaveLength(0);
  });
});
