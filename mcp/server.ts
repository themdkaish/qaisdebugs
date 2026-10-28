/**
 * QaisDebugs — the MCP server (`qaisdebugs mcp`). An MCP client such as Claude Code starts it and
 * talks to it over stdin/stdout; it reads everything from the running collector, the way the
 * inspector page does.
 */
import { readFileSync } from 'node:fs';
import { setCollectorBase } from '../ui/src/debugger/sourceMaps';
import type { PageTarget } from '../ui/src/debugger/targets';
import { Debugger } from './debugger';
import { serveStdio } from './protocol';
import { EventStore } from './store';
import { createTools } from './tools';

const INSTRUCTIONS = `qaisdebugs records what a Next.js app does while it runs in development: every request (page loads, client calls, the server's calls to its own API and to external APIs) with headers, bodies and the file:line that made it; server and browser console output; uncaught errors; and it can pause the app on breakpoints.

To investigate a bug: call status, then clear, ask the user to reproduce the problem (or wait_for it), then list_problems and list_requests, open details with get_request or get_trace, and read the code with read_file (or your own file tools).

To debug a value: set_breakpoint on the line, wait_for_pause while the user triggers it, read the variables, evaluate expressions, step, and always step with action "resume" when done: the app is frozen while paused. Client components pause only in the qaisdebugs Chrome (open_page). Passwords, tokens and cookies are masked before qaisdebugs stores them.`;

function packageVersion(): string {
  try {
    return (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export function main(): void {
  // stdout carries the protocol; anything else printed goes to stderr.
  console.log = (...args: unknown[]) => console.error(...args);
  console.info = (...args: unknown[]) => console.error(...args);

  const port = process.env.QAISDEBUGS_PORT ?? '4983';
  const collectorUrl = (process.env.QAISDEBUGS_URL ?? `http://127.0.0.1:${port}`).replace(/\/$/, '');
  setCollectorBase(collectorUrl);

  const store = new EventStore(collectorUrl);
  store.start();
  const pages = async (): Promise<PageTarget[]> => ((await (await fetch(`${collectorUrl}/chrome/targets`)).json()) as { targets?: PageTarget[] }).targets ?? [];
  const debuggerTools = new Debugger(() => store.agents, pages);
  const { tools, handlers } = createTools({ store, debugger: debuggerTools, collectorUrl });

  serveStdio({ name: 'qaisdebugs', version: packageVersion(), instructions: INSTRUCTIONS }, tools, handlers, () => {
    // Closing the debugger connections also resumes anything left paused.
    debuggerTools.close();
    store.stop();
    process.exit(0);
  });
}

main();
