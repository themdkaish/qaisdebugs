import { describe, expect, it } from 'vitest';
import { projectRoots, rootContaining } from './projects.mjs';

const agent = (app, repoRoot, cwd = `${repoRoot ?? '/x'}/apps/${app}`) => ({ app, repoRoot, cwd, pid: 1 });

describe('projectRoots', () => {
  it('lists the collector root and each agent root once', () => {
    expect(projectRoots('/work/shop', [agent('web', '/work/shop'), agent('crm', '/work/crm'), agent('admin', '/work/crm')])).toEqual(['/work/shop', '/work/crm']);
  });

  it('falls back to the app folder for an agent outside a repository', () => {
    expect(projectRoots('/work/shop', [agent('clock', undefined, '/work/clock')])).toEqual(['/work/shop', '/work/clock']);
  });
});

describe('rootContaining', () => {
  const roots = ['/work/shop', '/work/shop/packages/ui', '/work/crm'];

  it('finds the deepest root that holds the file', () => {
    expect(rootContaining('/work/shop/packages/ui/Button.tsx', roots)).toBe('/work/shop/packages/ui');
    expect(rootContaining('/work/crm/app/page.tsx', roots)).toBe('/work/crm');
  });

  it('does not treat a sibling folder with a longer name as inside', () => {
    expect(rootContaining('/work/shop-old/app/page.tsx', roots)).toBeUndefined();
  });
});
