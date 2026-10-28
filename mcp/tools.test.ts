import { describe, expect, it } from 'vitest';
import type { DevtoolsEvent, RequestEvent } from '../agent/shared/events.js';
import { Debugger } from './debugger';
import type { ToolResult } from './protocol';
import { EventStore } from './store';
import { createTools } from './tools';

const request = (id: string, extra: Partial<RequestEvent>): RequestEvent => ({
  kind: 'request',
  id,
  app: 'rental',
  origin: 'browser',
  method: 'GET',
  url: 'http://localhost:3000/api/x',
  status: 200,
  startedAt: Date.now(),
  durationMs: 10,
  reqHeaders: {},
  resHeaders: {},
  ...extra,
});

/** A store already "connected", with these events, and a fake collector for the HTTP calls. */
function setup(events: DevtoolsEvent[], files: Record<string, string> = {}) {
  const store = new EventStore('http://collector');
  store.connected = true;
  store.receive({ event: 'hello', data: JSON.stringify({ startedAt: 1, agents: [] }) });
  store.add(events);
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === '/sources/tree') return Response.json({ repoRoot: '/repo', tree: [{ name: 'src', path: '/repo/src', children: Object.keys(files).map((file) => ({ name: file, path: file })) }] });
    if (url.pathname === '/sources/file') {
      const file = url.searchParams.get('file') ?? '';

      return files[file] !== undefined ? Response.json({ content: files[file], relative: file.replace('/repo/', '') }) : Response.json({ error: 'file not found' }, { status: 404 });
    }

    return Response.json({ running: false, targets: [] });
  }) as typeof fetch;
  const { handlers } = createTools({ store, debugger: new Debugger(() => store.agents, async () => []), collectorUrl: 'http://collector', fetchImpl });
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> => (handlers.get(name) as (args: Record<string, unknown>) => Promise<ToolResult>)(args);
  const output = (result: ToolResult): string => result.content[0].text;

  return { store, call, output };
}

describe('tools', () => {
  it('list_requests filters by status and hides framework housekeeping unless asked', async () => {
    const { call, output } = setup([
      request('ok000001', { url: 'http://localhost:3000/api/vehicles' }),
      request('bad00002', { url: 'http://localhost:3000/api/lookups', status: 500 }),
      request('tel00003', { origin: 'other', url: 'https://telemetry.nextjs.org/api/v1/record', status: 500 }),
    ]);

    const failed = output(await call('list_requests', { status: 'error' }));

    expect(failed).toContain('1 request(s) match');
    expect(failed).toContain('bad00002');
    expect(failed).not.toContain('telemetry');
    expect(output(await call('list_requests', { origin: 'other' }))).toContain('tel00003');
  });

  it('get_request takes an id prefix and shows bodies, trimmed', async () => {
    const { call, output } = setup([request('abcdef12-full-id', { method: 'POST', reqBody: '{"password":"[redacted]"}', resBody: 'x'.repeat(50) })]);

    const detail = output(await call('get_request', { id: 'abcdef12', max_body_chars: 10 }));

    expect(detail).toContain('POST http://localhost:3000/api/x');
    expect(detail).toContain('{"passwor');
    expect(detail).toContain('[+40 chars');
  });

  it('list_problems gathers failed requests, errors and warnings', async () => {
    const { call, output } = setup([
      request('bad00002', { status: 404 }),
      { kind: 'error', id: 'err00003', app: 'rental', origin: 'browser', message: 'TypeError: x is undefined', at: Date.now() },
      { kind: 'log', id: 'log00004', app: 'rental', origin: 'server', level: 'warn', args: ['slow query'], at: Date.now() },
      { kind: 'log', id: 'log00005', app: 'rental', origin: 'server', level: 'log', args: ['all good'], at: Date.now() },
    ]);

    const problems = output(await call('list_problems'));

    expect(problems).toContain('failed requests (1)');
    expect(problems).toContain('errors and warnings (2)');
    expect(problems).not.toContain('all good');
  });

  it('read_file numbers the lines of the range asked for', async () => {
    const { call, output } = setup([], { '/repo/src/a.ts': 'one\ntwo\nthree\nfour' });

    expect(output(await call('read_file', { file: '/repo/src/a.ts', start_line: 2, end_line: 3 }))).toBe('src/a.ts (lines 2-3 of 4)\n2  two\n3  three');
  });

  it('says how to start qaisdebugs when the collector is not running', async () => {
    const { store, call } = setup([]);
    store.connected = false;

    const result = await call('status');

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('qaisdebugs dev');
  });
});
