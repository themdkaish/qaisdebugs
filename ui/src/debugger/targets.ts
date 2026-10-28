import type { AgentEvent } from '../events';

/** A page in the remote-debugging Chrome, as the collector lists it. */
export interface PageTarget {
  id: string;
  title: string;
  url: string;
  wsUrl: string;
}

export type DebugTarget = { kind: 'server'; agent: AgentEvent } | { kind: 'page'; page: PageTarget; agent?: AgentEvent };

export function targetKey(target: DebugTarget): string {
  return target.kind === 'server' ? `server:${target.agent.app}` : `page:${target.page.id}`;
}

export function targetLabel(target: DebugTarget): string {
  if (target.kind === 'server') return `${target.agent.app} server · pid ${target.agent.pid}`;
  const url = shortUrl(target.page.url);

  return `${target.page.title || url} · ${url}`;
}

export function targetWsUrl(target: DebugTarget): string | undefined {
  return target.kind === 'server' ? target.agent.inspectorUrl : target.page.wsUrl;
}

/** One run of a dev server: a restart gets a new pid, and a new inspector endpoint gets a new URL. */
export function serverRunKey(agent: AgentEvent): string {
  return `${agent.app}:${agent.pid}:${agent.inspectorUrl ?? ''}`;
}

/**
 * The dev servers to connect to on their own: every server with an inspector endpoint that has no
 * session yet and whose current run was not tried before. Trying each run once means a server the
 * developer disconnected stays disconnected, a failed connection is not retried in a loop, and a
 * restarted server is connected again.
 */
export function serversToAutoConnect(agents: AgentEvent[], sessionKeys: Set<string>, tried: Set<string>): AgentEvent[] {
  return agents.filter((agent) => agent.inspectorUrl && !sessionKeys.has(targetKey({ kind: 'server', agent })) && !tried.has(serverRunKey(agent)));
}

/** The agent whose dev server serves this page, by the port in its URL; no guessing. */
export function agentServingPage(page: PageTarget, agents: AgentEvent[]): AgentEvent | undefined {
  try {
    const url = new URL(page.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));

    return agents.find((agent) => agent.devServerPort === port);
  } catch {
    return undefined;
  }
}

/**
 * The tabs of the qaisdebugs Chrome to connect to on their own: the ones showing an app whose dev
 * server runs with the agent, not connected yet, and not tried before (a tab the developer
 * disconnected stays disconnected).
 */
export function pagesToAutoConnect(pages: PageTarget[], agents: AgentEvent[], sessionKeys: Set<string>, tried: Set<string>): Array<{ page: PageTarget; agent: AgentEvent }> {
  const picked: Array<{ page: PageTarget; agent: AgentEvent }> = [];
  for (const page of pages) {
    const agent = agentServingPage(page, agents);
    if (!agent || sessionKeys.has(targetKey({ kind: 'page', page })) || tried.has(page.id)) continue;
    picked.push({ page, agent });
  }

  return picked;
}

/** The app agent serving a page, matched by the dev server port in the page URL. */
export function agentForPage(page: PageTarget, agents: AgentEvent[]): AgentEvent | undefined {
  try {
    const url = new URL(page.url);
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    const byPort = agents.find((agent) => agent.devServerPort === port);
    if (byPort) return byPort;
  } catch {
    // Not a URL we can parse.
  }

  return agents.length === 1 ? agents[0] : undefined;
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);

    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return url;
  }
}
