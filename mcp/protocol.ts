/**
 * QaisDebugs — the Model Context Protocol over stdio, by hand: newline-delimited JSON-RPC 2.0
 * with `initialize`, `ping`, `tools/list` and `tools/call`. Everything else is answered with
 * "method not found", so the package keeps no runtime dependencies.
 */

export interface ToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

export interface ServerInfo {
  name: string;
  version: string;
  instructions?: string;
}

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/** Protocol versions this server speaks, newest first. */
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export function text(value: string): ToolResult {
  return { content: [{ type: 'text', text: value }] };
}

export function failure(value: string): ToolResult {
  return { content: [{ type: 'text', text: value }], isError: true };
}

/**
 * Answers one JSON-RPC message. Returns the response to write, or undefined for notifications.
 * Kept apart from the stdio plumbing so it can be tested directly.
 */
export async function handleMessage(
  message: JsonRpcMessage,
  info: ServerInfo,
  tools: ToolDefinition[],
  handlers: Map<string, ToolHandler>
): Promise<Record<string, unknown> | undefined> {
  const { id, method, params = {} } = message;
  // Notifications (`notifications/initialized`, cancellations) need no answer.
  if (id === undefined || id === null) return undefined;
  const reply = (result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id, result });
  const error = (code: number, text: string): Record<string, unknown> => ({ jsonrpc: '2.0', id, error: { code, message: text } });

  switch (method) {
    case 'initialize': {
      const requested = String(params.protocolVersion ?? '');

      return reply({
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: info.name, version: info.version },
        instructions: info.instructions,
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools });
    case 'tools/call': {
      const name = String(params.name ?? '');
      const handler = handlers.get(name);
      if (!handler) return error(-32602, `unknown tool: ${name}`);
      try {
        return reply(await handler((params.arguments as Record<string, unknown> | undefined) ?? {}));
      } catch (reason) {
        // A tool that throws is reported to the model as a failed call, not a protocol error.
        return reply(failure(reason instanceof Error ? reason.message : String(reason)));
      }
    }
    default:
      return error(-32601, `method not found: ${method}`);
  }
}

/** Reads requests from stdin, one JSON object per line, and writes answers to stdout. */
export function serveStdio(info: ServerInfo, tools: ToolDefinition[], handlers: Map<string, ToolHandler>, onClose: () => void): void {
  let pending = '';
  const inFlight = new Set<Promise<void>>();
  const write = (message: Record<string, unknown>): void => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    pending += chunk;
    let newline = pending.indexOf('\n');
    while (newline >= 0) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      newline = pending.indexOf('\n');
      if (!line) continue;

      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
        continue;
      }
      // Calls run concurrently: a long `wait_for` must not hold up a `ping`.
      const call = handleMessage(message, info, tools, handlers).then((response) => {
        if (response) write(response);
      });
      inFlight.add(call);
      void call.finally(() => inFlight.delete(call));
    }
  });
  // The client hung up: answer what is still running, then stop.
  process.stdin.on('end', () => void Promise.allSettled([...inFlight]).then(onClose));
}
