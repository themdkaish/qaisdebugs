import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { toSerializable } from './serialize.js';

describe('toSerializable', () => {
  it('passes JSON-safe values through', () => {
    expect(toSerializable({ a: 1, b: 'x', c: [true, null] })).toEqual({ a: 1, b: 'x', c: [true, null] });
  });

  it('names the values JSON cannot carry', () => {
    expect(toSerializable(undefined)).toBe('[undefined]');
    expect(toSerializable(NaN)).toBe('NaN');
    expect(toSerializable(10n)).toBe('10n');
    expect(toSerializable(function named() {})).toBe('[Function: named]');
    expect(toSerializable(Symbol('s'))).toBe('Symbol(s)');
  });

  it('keeps an error readable, including its own fields', () => {
    const error = Object.assign(new Error('boom'), { status: 500 });

    expect(toSerializable(error)).toMatchObject({ name: 'Error', message: 'boom', status: 500 });
    expect((toSerializable(error) as { stack: string }).stack).toContain('boom');
  });

  it('breaks cycles', () => {
    const value: Record<string, unknown> = { name: 'root' };
    value.self = value;

    expect(toSerializable(value)).toEqual({ name: 'root', self: '[Circular]' });
  });

  it('stops at the depth limit', () => {
    expect(toSerializable({ a: { b: { c: 1 } } }, { maxDepth: 2 })).toEqual({ a: { b: '[Object]' } });
    expect(toSerializable({ a: [[1]] }, { maxDepth: 2 })).toEqual({ a: ['[Array(1)]'] });
  });

  it('caps long arrays, wide objects and long strings', () => {
    expect(toSerializable([1, 2, 3, 4], { maxItems: 2 })).toEqual([1, 2, '[+2 more]']);
    expect(toSerializable({ a: 1, b: 2, c: 3 }, { maxItems: 2 })).toEqual({ a: 1, b: 2, '…': '[+1 more keys]' });
    expect(toSerializable('abcdef', { maxString: 3 })).toBe('abc… [+3 chars]');
  });

  it('serialises dates, urls, maps, sets and headers', () => {
    expect(toSerializable(new Date('2026-10-23T10:00:00.000Z'))).toBe('2026-10-23T10:00:00.000Z');
    expect(toSerializable(new URL('http://x.test/a?b=1'))).toBe('http://x.test/a?b=1');
    expect(toSerializable(new Map([['k', 1]]))).toEqual([['k', 1]]);
    expect(toSerializable(new Set([1, 2]))).toEqual([1, 2]);
    expect(toSerializable(new Headers({ 'x-a': '1' }))).toEqual({ 'x-a': '1' });
  });

  it('describes binary data by size instead of dumping it', () => {
    expect(toSerializable(new Uint8Array(4))).toBe('[Uint8Array 4 bytes]');
    expect(toSerializable(new ArrayBuffer(8))).toBe('[ArrayBuffer 8 bytes]');
  });
});
