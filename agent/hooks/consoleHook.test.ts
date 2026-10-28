import { describe, expect, it } from 'vitest';
import type { DevtoolsEvent, LogEvent } from '../shared/events.js';
import { installConsoleHook } from './consoleHook.js';

describe('installConsoleHook', () => {
  it('records a logged object with credential fields redacted, and still prints the original', () => {
    const printed: unknown[][] = [];
    const events: DevtoolsEvent[] = [];
    const original = { log: (...args: unknown[]) => printed.push(args), info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
    const saved = console.log;

    installConsoleHook({ app: 'web', stackOptions: { cwd: '/repo' }, record: (event) => events.push(event), getContext: () => undefined, original });
    try {
      console.log('order', { id: 42, customer: { name: 'Test User', cardToken: 'card_tok_999' }, password: 'hunter2' });
    } finally {
      console.log = saved;
    }

    expect(printed[0][1]).toMatchObject({ password: 'hunter2' });
    const event = events[0] as LogEvent;
    expect(event.args[0]).toBe('order');
    expect(JSON.stringify(event.args[1])).not.toContain('card_tok_999');
    expect(JSON.stringify(event.args[1])).not.toContain('hunter2');
    expect(JSON.stringify(event.args[1])).toContain('Test User');
  });
});
