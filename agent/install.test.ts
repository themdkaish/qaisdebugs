import { describe, expect, it } from 'vitest';
import { appNameFrom, detectRole } from './install.js';

describe('detectRole', () => {
  it('recognises only the Next server and launcher processes', () => {
    expect(detectRole('/repo/node_modules/.pnpm/next@14.2.35/node_modules/next/dist/server/lib/start-server.js')).toBe('server');
    expect(detectRole('/repo/apps/web/node_modules/next/dist/bin/next')).toBe('launcher');
    expect(detectRole('/opt/homebrew/bin/pnpm')).toBeUndefined();
    expect(detectRole('/repo/node_modules/next/dist/compiled/jest-worker/processChild.js')).toBeUndefined();
    expect(detectRole('/repo/node_modules/nx/bin/nx.js')).toBeUndefined();
    expect(detectRole(undefined)).toBeUndefined();
  });
});

describe('appNameFrom', () => {
  it('prefers the unscoped package name and falls back to the folder name', () => {
    expect(appNameFrom('/repo/apps/web', '@acme/web-portal')).toBe('web-portal');
    expect(appNameFrom('/repo/apps/web', 'storefront')).toBe('storefront');
    expect(appNameFrom('/home/me/my-shop', undefined)).toBe('my-shop');
  });
});
