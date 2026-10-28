/**
 * QaisDebugs — what the MCP server knows: the collector's event stream, kept in memory the way the
 * inspector page keeps it (the browser's and the server's half of a request merged into one), plus
 * the dev servers running right now.
 */
import type { AgentEvent, DevtoolsEvent, RequestEvent } from '../agent/shared/events.js';
import { mergeRequest } from '../ui/src/mergeRequests';

export interface SseMessage {
  event: string;
  data: string;
}

/** Splits a Server-Sent Events buffer into complete messages and the incomplete rest. */
export function parseSse(buffer: string): { messages: SseMessage[]; rest: string } {
  const messages: SseMessage[] = [];
  const blocks = buffer.split('\n\n');
  const rest = blocks.pop() ?? '';
  for (const block of blocks) {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length) messages.push({ event, data: data.join('\n') });
  }

  return { messages, rest };
}

type Listener = (event: DevtoolsEvent) => void;

export class EventStore {
  events: DevtoolsEvent[] = [];
  agents: AgentEvent[] = [];
  connected = false;
  private readonly byId = new Map<string, DevtoolsEvent>();
  private readonly listeners = new Set<Listener>();
  private startedAt?: number;
  private firstHello?: Promise<void>;
  private resolveFirstHello?: () => void;
  private stopped = false;

  constructor(
    private readonly collectorUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly max = 5000
  ) {
    this.firstHello = new Promise((resolve) => {
      this.resolveFirstHello = resolve;
    });
  }

  /** Keeps a live connection to the collector, reconnecting every 2 s while it is down. */
  start(): void {
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
  }

  /** Resolves once the collector has answered, or after `timeoutMs` when it is not running. */
  ready(timeoutMs = 1500): Promise<void> {
    return Promise.race([this.firstHello ?? Promise.resolve(), new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);

    return () => this.listeners.delete(listener);
  }

  /** The next event (from now on) that `matches`, or undefined after `timeoutMs`. */
  waitFor(matches: (event: DevtoolsEvent) => boolean, timeoutMs: number): Promise<DevtoolsEvent | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        off();
        resolve(undefined);
      }, timeoutMs);
      const off = this.onEvent((event) => {
        if (!matches(event)) return;
        clearTimeout(timer);
        off();
        resolve(event);
      });
    });
  }

  find(idOrPrefix: string): DevtoolsEvent | undefined {
    const exact = this.byId.get(idOrPrefix);
    if (exact) return exact;
    const matches = this.events.filter((event) => event.id.startsWith(idOrPrefix));

    return matches.length === 1 ? matches[0] : undefined;
  }

  /** Adds a batch; a request seen before under the same id is merged with it. */
  add(batch: DevtoolsEvent[]): void {
    for (const event of batch) {
      if (event.kind === 'agent') continue;
      const known = this.byId.get(event.id);
      if (known) {
        if (known.kind !== 'request' || event.kind !== 'request') continue;
        const merged = mergeRequest(known, event as RequestEvent);
        this.byId.set(event.id, merged);
        const index = this.events.indexOf(known);
        if (index >= 0) this.events[index] = merged;
        this.emit(merged);
        continue;
      }
      this.byId.set(event.id, event);
      this.events.push(event);
      this.emit(event);
    }
    if (this.events.length > this.max) {
      for (const dropped of this.events.splice(0, this.events.length - this.max)) this.byId.delete(dropped.id);
    }
  }

  clear(): void {
    this.events = [];
    this.byId.clear();
  }

  private emit(event: DevtoolsEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A waiter's predicate must not stop the stream.
      }
    }
  }

  /** Takes one message from the collector's stream. */
  receive(message: SseMessage): void {
    let payload: unknown;
    try {
      payload = JSON.parse(message.data);
    } catch {
      return;
    }
    if (message.event === 'hello') {
      const hello = payload as { startedAt?: number; agents?: AgentEvent[] };
      // A restarted collector replays a different history: start over.
      if (this.startedAt !== undefined && hello.startedAt !== this.startedAt) this.clear();
      this.startedAt = hello.startedAt;
      this.agents = hello.agents ?? [];
      this.resolveFirstHello?.();
    } else if (message.event === 'events') {
      this.add(payload as DevtoolsEvent[]);
    } else if (message.event === 'agents') {
      this.agents = payload as AgentEvent[];
    } else if (message.event === 'clear') {
      this.clear();
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        const response = await this.fetchImpl(`${this.collectorUrl}/events`, { headers: { accept: 'text/event-stream' } });
        if (!response.ok || !response.body) throw new Error(`collector answered ${response.status}`);
        this.connected = true;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const { messages, rest } = parseSse(buffer);
          buffer = rest;
          for (const message of messages) this.receive(message);
        }
      } catch {
        // Not running (yet); try again shortly.
      }
      this.connected = false;
      this.agents = [];
      if (!this.stopped) await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}
