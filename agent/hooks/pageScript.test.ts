import http, { type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { injectPageScript, insertAfterHead, isDocumentRequest, pageScriptTag } from './pageScript.js';

const TAG = '<script data-qaisdebugs-app="web">window.__x=1</script>';

function request(url: string, headers: Record<string, string> = {}, method = 'GET'): IncomingMessage {
  return { url, method, headers } as unknown as IncomingMessage;
}

describe('isDocumentRequest', () => {
  it('is true for a browser loading a page, and false for RSC payloads, API routes and assets', () => {
    expect(isDocumentRequest(request('/en/fleet', { accept: 'text/html,application/xhtml+xml' }))).toBe(true);
    expect(isDocumentRequest(request('/en/fleet?_rsc=1', { accept: '*/*', rsc: '1' }))).toBe(false);
    expect(isDocumentRequest(request('/api/user', { accept: 'text/html' }))).toBe(false);
    expect(isDocumentRequest(request('/_next/static/chunks/main.js', { accept: 'text/html' }))).toBe(false);
    expect(isDocumentRequest(request('/en/fleet', { accept: 'text/html' }, 'POST'))).toBe(false);
  });
});

describe('insertAfterHead', () => {
  it('puts the tag right after the opening head, attributes and all', () => {
    expect(insertAfterHead('<!DOCTYPE html><html><head lang="en"><meta charset="utf-8">', TAG)).toBe(`<!DOCTYPE html><html><head lang="en">${TAG}<meta charset="utf-8">`);
    expect(insertAfterHead('<html><header>', TAG)).toBeUndefined();
  });
});

describe('pageScriptTag', () => {
  it('escapes the settings and keeps the code from closing its own element', () => {
    const tag = pageScriptTag({ app: 'a"b', collectorUrl: 'http://127.0.0.1:4983', cwd: '/x/<y>', code: 'const s = "</script>";' });

    expect(tag).toContain('data-qaisdebugs-app="a&quot;b"');
    expect(tag).toContain('data-qaisdebugs-cwd="/x/&lt;y>"');
    expect(tag.match(/<\/script>/g)).toHaveLength(1);
  });

  it("points the source map at the collector, so the page carries only the code", () => {
    const tag = pageScriptTag({ app: 'web', collectorUrl: 'http://127.0.0.1:4983', cwd: '/x', code: 'run();\n//# sourceMappingURL=client.js.map' });

    expect(tag).toContain('//# sourceMappingURL=http://127.0.0.1:4983/client.js.map');
    expect(tag).not.toContain('sourceMappingURL=client.js.map');
  });
});

describe('injectPageScript', () => {
  let server: http.Server | undefined;
  afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

  /** A server that answers like Next: chunked writes, maybe compressed, maybe with a length. */
  async function serve(handler: (req: IncomingMessage, res: http.ServerResponse) => void): Promise<string> {
    server = http.createServer((req, res) => {
      injectPageScript(req, res, TAG);
      handler(req, res);
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));

    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('adds the script to a page streamed in chunks, even when <head> is split across them', async () => {
    const base = await serve((req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.write('<!DOCTYPE html><html><he');
      res.write('ad><title>x</title></head>');
      res.end('<body>hi</body></html>');
    });

    const html = await (await fetch(`${base}/en`, { headers: { accept: 'text/html' } })).text();

    expect(html).toBe(`<!DOCTYPE html><html><head>${TAG}<title>x</title></head><body>hi</body></html>`);
  });

  it('asks for a fresh page, so a cached copy without the script (or with an old one) is not reused', async () => {
    const seen: Array<string | undefined> = [];
    const base = await serve((req, res) => {
      seen.push(req.headers['if-none-match'], req.headers['if-modified-since']);
      res.setHeader('content-type', 'text/html');
      res.end('<html><head></head><body></body></html>');
    });

    const response = await fetch(`${base}/`, { headers: { accept: 'text/html', 'if-none-match': 'W/"253-abc"', 'if-modified-since': 'Wed, 28 Oct 2026 10:00:00 GMT' } });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain(TAG);
    expect(seen).toEqual([undefined, undefined]);
  });

  it('asks for an uncompressed page and drops a length that would now be wrong', async () => {
    const page = '<html><head></head><body>ok</body></html>';
    const base = await serve((req, res) => {
      const gzip = String(req.headers['accept-encoding'] ?? '').includes('gzip');
      res.writeHead(200, { 'content-type': 'text/html', 'content-length': String(gzip ? gzipSync(page).length : page.length), ...(gzip ? { 'content-encoding': 'gzip' } : {}) });
      res.end(gzip ? gzipSync(page) : page);
    });

    const response = await fetch(`${base}/en`, { headers: { accept: 'text/html', 'accept-encoding': 'gzip' } });

    expect(response.headers.get('content-encoding')).toBeNull();
    expect(await response.text()).toBe(`<html><head>${TAG}</head><body>ok</body></html>`);
  });

  it('leaves anything that is not a 200 HTML page untouched', async () => {
    const base = await serve((req, res) => {
      if (req.url === '/json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"head":"<head>"}');
      } else {
        res.writeHead(404, { 'content-type': 'text/html' });
        res.end('<html><head></head></html>');
      }
    });

    expect(await (await fetch(`${base}/json`)).text()).toBe('{"head":"<head>"}');
    expect(await (await fetch(`${base}/missing`)).text()).toBe('<html><head></head></html>');
  });
});
