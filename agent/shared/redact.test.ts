import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { REDACTED, redactBodyText, redactCookieHeader, redactHeaders, redactValue } from './redact.js';

describe('redactHeaders', () => {
  it('hides credential headers and keeps the rest, lower-cased', () => {
    expect(
      redactHeaders({ Authorization: 'Bearer abc', 'X-Api-Key': 'k', 'Content-Type': 'application/json', Accept: '*/*' })
    ).toEqual({
      authorization: REDACTED,
      'x-api-key': REDACTED,
      'content-type': 'application/json',
      accept: '*/*',
    });
  });

  it('accepts a Headers instance and an entries array', () => {
    expect(redactHeaders(new Headers({ 'set-cookie': 'a=b' }))).toEqual({ 'set-cookie': REDACTED });
    expect(redactHeaders([['x-trace', 't1']])).toEqual({ 'x-trace': 't1' });
  });

  it('keeps cookie names but hides token-like cookie values', () => {
    expect(redactHeaders({ cookie: 'tj-access-token=eyJ; NEXT_LOCALE=en; tj-refresh-token.1=xyz' })).toEqual({
      cookie: `tj-access-token=${REDACTED}; NEXT_LOCALE=en; tj-refresh-token.1=${REDACTED}`,
    });
  });

  it('returns an empty object for a missing header set', () => {
    expect(redactHeaders(undefined)).toEqual({});
    expect(redactHeaders(null)).toEqual({});
  });

  it('survives a plain object with values Headers would reject', () => {
    expect(redactHeaders({ 'x-count': 3, 'x-none': undefined } as unknown as HeadersInit)).toEqual({ 'x-count': '3' });
  });
});

describe('redactCookieHeader', () => {
  it('leaves a value-less cookie part alone', () => {
    expect(redactCookieHeader('flag; a=1')).toBe('flag; a=1');
  });
});

describe('redactValue', () => {
  it('replaces sensitive keys at any depth and leaves other values intact', () => {
    expect(
      redactValue({
        accessToken: 'a',
        nested: { Password: 'p', list: [{ otpCode: '1', id: 5 }] },
        name: 'x',
        nullToken: null,
      })
    ).toEqual({
      accessToken: REDACTED,
      nested: { Password: REDACTED, list: [{ otpCode: REDACTED, id: 5 }] },
      name: 'x',
      nullToken: null,
    });
  });

  it('passes primitives through', () => {
    expect(redactValue('token')).toBe('token');
    expect(redactValue(3)).toBe(3);
  });
});

describe('redactBodyText', () => {
  it('redacts a JSON body by content type', () => {
    expect(redactBodyText('{"refreshToken":"r","ok":true}', 'application/json; charset=utf-8')).toBe(
      `{"refreshToken":"${REDACTED}","ok":true}`
    );
  });

  it('redacts a body that looks like JSON even without a content type', () => {
    expect(redactBodyText(' [{"password":"x"}]')).toBe(`[{"password":"${REDACTED}"}]`);
  });

  it('returns non-JSON text and broken JSON unchanged', () => {
    expect(redactBodyText('token=abc', 'text/plain')).toBe('token=abc');
    expect(redactBodyText('{"token":', 'application/json')).toBe('{"token":');
    expect(redactBodyText('')).toBe('');
  });
});
