import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../events';
import { type PageTarget, pagesToAutoConnect, serverRunKey, serversToAutoConnect } from './targets';

function agent(app: string, pid: number, inspector = true, devServerPort?: number): AgentEvent {
  const inspectorUrl = inspector ? `ws://127.0.0.1:9229/${app}-${pid}` : undefined;

  return { id: `agent-${app}-${pid}`, kind: 'agent', app, pid, cwd: `/work/${app}`, inspectorUrl, devServerPort, version: 'test', at: 0 } as AgentEvent;
}

describe('serversToAutoConnect', () => {
  it('picks every dev server with an inspector that is not connected yet', () => {
    const agents = [agent('gov-portal', 10), agent('rental-portal', 20), agent('no-inspector', 30, false)];

    const picked = serversToAutoConnect(agents, new Set(['server:gov-portal']), new Set());

    expect(picked.map((entry) => entry.app)).toEqual(['rental-portal']);
  });

  it('tries each run once, so a disconnected or unreachable server is left alone', () => {
    const rental = agent('rental-portal', 20);

    expect(serversToAutoConnect([rental], new Set(), new Set([serverRunKey(rental)]))).toEqual([]);
  });

  it('connects again when the dev server restarts with a new pid', () => {
    const before = agent('rental-portal', 20);
    const after = agent('rental-portal', 21);

    expect(serversToAutoConnect([after], new Set(), new Set([serverRunKey(before)]))).toEqual([after]);
  });
});

describe('pagesToAutoConnect', () => {
  const page = (id: string, url: string): PageTarget => ({ id, title: id, url, wsUrl: `ws://127.0.0.1:9222/devtools/page/${id}` });
  const rental = agent('rental-portal', 20, true, 3000);

  it("connects the tabs showing a running app, matched by port, and nothing else", () => {
    const pages = [page('a', 'http://localhost:3000/en/fleet'), page('b', 'https://www.google.com/'), page('c', 'http://localhost:4000/'), page('d', 'chrome://newtab/')];

    expect(pagesToAutoConnect(pages, [rental], new Set(), new Set()).map(({ page: picked, agent: owner }) => [picked.id, owner.app])).toEqual([['a', 'rental-portal']]);
  });

  it('leaves alone a tab that is connected or was tried before', () => {
    const pages = [page('a', 'http://localhost:3000/'), page('b', 'http://localhost:3000/en')];

    expect(pagesToAutoConnect(pages, [rental], new Set(['page:a']), new Set(['b']))).toEqual([]);
  });
});
