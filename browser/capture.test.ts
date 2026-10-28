import { describe, expect, it } from 'vitest';
import { classifyUrl, describeBody, isTextual, parseRawHeaders } from './capture.js';

const page = 'http://localhost:3000';
const collector = 'http://127.0.0.1:4983';

describe('classifyUrl', () => {
  it('tags the dev server, records other hosts, and skips Next internals and the collector', () => {
    expect(classifyUrl(new URL('http://localhost:3000/api/tj/vehicles'), page, collector)).toBe('same');
    expect(classifyUrl(new URL('https://api.example.com/v1'), page, collector)).toBe('cross');
    expect(classifyUrl(new URL('http://localhost:3000/_next/static/chunks/app.js'), page, collector)).toBe('skip');
    expect(classifyUrl(new URL('http://localhost:3000/__nextjs_original-stack-frame'), page, collector)).toBe('skip');
    expect(classifyUrl(new URL('http://127.0.0.1:4983/ingest'), page, collector)).toBe('skip');
    expect(classifyUrl(new URL('data:text/plain,hi'), page, collector)).toBe('skip');
  });
});

describe('describeBody', () => {
  it('shows text, form fields and binary bodies readably', () => {
    expect(describeBody('{"a":1}', 100)).toBe('{"a":1}');
    expect(describeBody(new URLSearchParams({ q: 'x', page: '2' }), 100)).toBe('q=x&page=2');
    const form = new FormData();
    form.set('name', 'Kia');
    form.set('file', new Blob(['abc']), 'a.txt');
    expect(describeBody(form, 100)).toBe('name=Kia\nfile=[File a.txt 3 bytes]');
    expect(describeBody(new Uint8Array(4), 100)).toBe('[4 bytes]');
    expect(describeBody('abcdef', 3)).toBe('abc… [+3 chars]');
    expect(describeBody(undefined, 100)).toBeUndefined();
  });
});

describe('isTextual', () => {
  it('keeps JSON, text and RSC payloads, and leaves streams and images alone', () => {
    expect(isTextual('application/json; charset=utf-8')).toBe(true);
    expect(isTextual('text/x-component')).toBe(true);
    expect(isTextual('text/event-stream')).toBe(false);
    expect(isTextual('image/png')).toBe(false);
  });
});

describe('parseRawHeaders', () => {
  it('reads XMLHttpRequest response headers', () => {
    expect(parseRawHeaders('Content-Type: application/json\r\nX-Total: 5\r\n')).toEqual({ 'content-type': 'application/json', 'x-total': '5' });
  });
});
