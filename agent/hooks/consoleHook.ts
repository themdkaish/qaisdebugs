import type { RequestContext } from '../context.js';
import { LOG_LEVELS, type LogLevel } from '../shared/events.js';
import type { DevtoolsEvent } from '../shared/events.js';
import { newId } from '../shared/ids.js';
import { type ParseStackOptions, captureInitiator } from '../shared/initiator.js';
import { redactValue } from '../shared/redact.js';
import { toSerializable } from '../shared/serialize.js';
import { wallClock } from '../shared/clock.js';

/**
 * QaisDebugs — console mirroring.
 *
 * Every `console.*` call keeps its original output and is also recorded, with the request
 * context it was written in and the application frame that wrote it. Logged objects are redacted
 * like request bodies: fields named like a token, password or secret never leave the process.
 */

export interface ConsoleHookOptions {
  app: string;
  stackOptions: ParseStackOptions;
  record: (event: DevtoolsEvent) => void;
  getContext: () => RequestContext | undefined;
  original: Pick<Console, LogLevel>;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

/** Next colours its own dev output; the terminal keeps the colours, the inspector gets plain text. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

export function installConsoleHook(options: ConsoleHookOptions): void {
  for (const level of LOG_LEVELS) {
    const original = options.original[level];

    console[level] = (...args: unknown[]): void => {
      original.apply(console, args);

      try {
        const { initiator, frames } = captureInitiator(options.stackOptions, 1);
        const context = options.getContext();

        options.record({
          kind: 'log',
          id: newId(),
          traceId: context?.traceId,
          pagePath: context?.pagePath,
          app: options.app,
          origin: 'server',
          level,
          // Objects logged with credentials in them (a token, a password) are redacted like bodies are.
          args: args.map((arg) => redactValue(toSerializable(typeof arg === 'string' ? stripAnsi(arg) : arg))),
          at: wallClock(),
          initiator,
          frames,
        });
      } catch {
        // Mirroring must never break logging.
      }
    };
  }
}
