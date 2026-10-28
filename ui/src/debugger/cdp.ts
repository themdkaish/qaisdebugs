/**
 * A minimal Chrome DevTools Protocol client over WebSocket.
 *
 * Node's inspector accepts a WebSocket straight from a page on 127.0.0.1, so the inspector talks to
 * the dev server process directly, with no proxy in between.
 */

type Handler = (params: unknown) => void;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
}

export class CdpError extends Error {
  constructor(public readonly method: string, message: string, public readonly code?: number) {
    super(`${method}: ${message}`);
  }
}

export class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<Handler>>();
  onClose?: (reason: string) => void;

  private constructor(private readonly socket: WebSocket) {
    socket.onmessage = (message) => this.receive(String(message.data));
    socket.onclose = (event) => this.closed(`closed (${event.code})`);
    socket.onerror = () => this.closed('socket error');
  }

  static connect(url: string, timeoutMs = 5000): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      // Global timers, not `window`: the MCP server uses this client in Node.
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error(`timed out connecting to ${url}`));
      }, timeoutMs);

      socket.onopen = () => {
        clearTimeout(timer);
        resolve(new CdpClient(socket));
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`could not connect to ${url}`));
      };
    });
  }

  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new CdpError(method, 'not connected'));
    }

    const id = this.nextId++;

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, method });
      this.socket.send(JSON.stringify({ id, method, params: params ?? {} }));
    });
  }

  on(method: string, handler: Handler): () => void {
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    set.add(handler);

    return () => set?.delete(handler);
  }

  close(): void {
    this.socket.onclose = null;
    this.socket.close();
    this.closed('closed by the inspector');
  }

  private receive(raw: string): void {
    let message: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string; code?: number } };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);

      if (message.error) pending.reject(new CdpError(pending.method, message.error.message, message.error.code));
      else pending.resolve(message.result);

      return;
    }

    if (message.method) {
      for (const handler of this.listeners.get(message.method) ?? []) {
        try {
          handler(message.params);
        } catch (error) {
          console.error('CDP handler failed', message.method, error);
        }
      }
    }
  }

  private closed(reason: string): void {
    for (const pending of this.pending.values()) pending.reject(new CdpError(pending.method, reason));
    this.pending.clear();
    this.onClose?.(reason);
    this.onClose = undefined;
  }
}
