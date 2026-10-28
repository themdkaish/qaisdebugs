import { describe, expect, it } from 'vitest';
import { type KeyInput, shortcutFor, shortcutLabel } from './shortcuts';

const key = (value: string, modifiers: Partial<KeyInput> = {}): KeyInput => ({ key: value, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...modifiers });

describe('shortcutFor', () => {
  it('uses Cmd on a Mac', () => {
    expect(shortcutFor(key('p', { metaKey: true }), true)).toBe('quickOpen');
    expect(shortcutFor(key('p', { ctrlKey: true }), true)).toBeUndefined();
  });

  it('uses Ctrl elsewhere', () => {
    expect(shortcutFor(key('p', { ctrlKey: true }), false)).toBe('quickOpen');
    expect(shortcutFor(key('p', { metaKey: true }), false)).toBeUndefined();
  });

  it('maps F, G and Shift+F', () => {
    expect(shortcutFor(key('f', { metaKey: true }), true)).toBe('find');
    expect(shortcutFor(key('g', { metaKey: true }), true)).toBe('goToLine');
    // With Shift held, browsers report the key in upper case.
    expect(shortcutFor(key('F', { metaKey: true, shiftKey: true }), true)).toBe('searchProject');
  });

  it('ignores other combinations', () => {
    expect(shortcutFor(key('p'), true)).toBeUndefined();
    expect(shortcutFor(key('p', { metaKey: true, altKey: true }), true)).toBeUndefined();
    expect(shortcutFor(key('P', { metaKey: true, shiftKey: true }), true)).toBeUndefined();
    expect(shortcutFor(key('s', { metaKey: true }), true)).toBeUndefined();
  });
});

describe('shortcutLabel', () => {
  it('writes shortcuts the way each platform does', () => {
    expect(shortcutLabel('quickOpen', true)).toBe('⌘P');
    expect(shortcutLabel('searchProject', true)).toBe('⇧⌘F');
    expect(shortcutLabel('searchProject', false)).toBe('Ctrl+Shift+F');
  });
});
