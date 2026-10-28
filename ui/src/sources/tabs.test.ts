import { describe, expect, it } from 'vitest';
import { closeTab, type EditorTab, openTab, tabLabels } from './tabs';

const tabs = (...files: string[]): EditorTab[] => files.map((file, index) => ({ file, usedAt: index }));
const names = (list: EditorTab[]): string[] => list.map((tab) => tab.file);

describe('openTab', () => {
  it('adds a new file right after the active tab', () => {
    expect(names(openTab(tabs('/a', '/b', '/c'), '/x', '/a', 10))).toEqual(['/a', '/x', '/b', '/c']);
  });

  it('appends when nothing is active', () => {
    expect(names(openTab(tabs('/a'), '/x', undefined, 10))).toEqual(['/a', '/x']);
  });

  it('reuses an open tab where it is and marks it used', () => {
    const next = openTab(tabs('/a', '/b'), '/a', '/b', 99);
    expect(names(next)).toEqual(['/a', '/b']);
    expect(next[0].usedAt).toBe(99);
  });

  it('closes the least recently used tab past the limit, never the new one', () => {
    const open: EditorTab[] = [
      { file: '/a', usedAt: 5 },
      { file: '/b', usedAt: 1 },
      { file: '/c', usedAt: 7 },
    ];
    expect(names(openTab(open, '/x', '/c', 10, 3))).toEqual(['/a', '/c', '/x']);
  });
});

describe('closeTab', () => {
  it('activates the right neighbour when the active tab closes', () => {
    expect(closeTab(tabs('/a', '/b', '/c'), '/b', '/b')).toEqual({ tabs: tabs('/a', '/c').map((tab, index) => ({ ...tab, usedAt: index === 0 ? 0 : 2 })), active: '/c' });
  });

  it('activates the left neighbour when the last tab closes', () => {
    expect(closeTab(tabs('/a', '/b'), '/b', '/b').active).toBe('/a');
  });

  it('keeps the active tab when another one closes', () => {
    const result = closeTab(tabs('/a', '/b', '/c'), '/a', '/c');
    expect(names(result.tabs)).toEqual(['/b', '/c']);
    expect(result.active).toBe('/c');
  });

  it('leaves nothing active when the only tab closes', () => {
    expect(closeTab(tabs('/a'), '/a', '/a')).toEqual({ tabs: [], active: undefined });
  });
});

describe('tabLabels', () => {
  it('uses the file name alone when it is unique', () => {
    expect(tabLabels(['/repo/app/page.tsx', '/repo/lib/api.ts']).get('/repo/lib/api.ts')).toEqual({ name: 'api.ts', hint: '' });
  });

  it('adds the folder that tells two files with the same name apart', () => {
    const labels = tabLabels(['/repo/app/shop/page.tsx', '/repo/app/cart/page.tsx']);
    expect(labels.get('/repo/app/shop/page.tsx')).toEqual({ name: 'page.tsx', hint: 'shop' });
    expect(labels.get('/repo/app/cart/page.tsx')).toEqual({ name: 'page.tsx', hint: 'cart' });
  });

  it('goes up as many folders as it takes', () => {
    const labels = tabLabels(['/repo/apps/web/app/page.tsx', '/repo/apps/admin/app/page.tsx']);
    expect(labels.get('/repo/apps/web/app/page.tsx')?.hint).toBe('web/app');
  });
});
