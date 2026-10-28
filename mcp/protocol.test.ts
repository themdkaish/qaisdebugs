import { describe, expect, it } from 'vitest';
import { type ToolHandler, failure, handleMessage, text } from './protocol';

const info = { name: 'qaisdebugs', version: '9.9.9', instructions: 'how to use it' };
const tools = [{ name: 'status', description: 'what runs', inputSchema: { type: 'object' as const, properties: {} } }];
const handlers = new Map<string, ToolHandler>([
  ['status', async () => text('all good')],
  ['broken', async () => {
    throw new Error('collector exploded');
  }],
]);

describe('handleMessage', () => {
  it('agrees on a protocol version the client asked for, and offers tools', async () => {
    const answer = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, info, tools, handlers);

    expect(answer).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'qaisdebugs', version: '9.9.9' }, instructions: 'how to use it' },
    });
  });

  it('answers with its newest version when the client asks for an unknown one', async () => {
    const answer = (await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, info, tools, handlers)) as { result: { protocolVersion: string } };

    expect(answer.result.protocolVersion).toBe('2025-06-18');
  });

  it('lists tools and runs them; a tool that throws is a failed call, not a protocol error', async () => {
    expect(await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, info, tools, handlers)).toEqual({ jsonrpc: '2.0', id: 2, result: { tools } });
    expect(await handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'status', arguments: {} } }, info, tools, handlers)).toEqual({ jsonrpc: '2.0', id: 3, result: text('all good') });
    expect(await handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'broken' } }, info, tools, handlers)).toEqual({ jsonrpc: '2.0', id: 4, result: failure('collector exploded') });
  });

  it('ignores notifications and rejects unknown methods and tools', async () => {
    expect(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, info, tools, handlers)).toBeUndefined();
    expect(await handleMessage({ jsonrpc: '2.0', id: 5, method: 'resources/list' }, info, tools, handlers)).toMatchObject({ error: { code: -32601 } });
    expect(await handleMessage({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope' } }, info, tools, handlers)).toMatchObject({ error: { code: -32602 } });
  });
});
