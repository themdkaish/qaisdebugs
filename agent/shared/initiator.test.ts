import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { captureInitiator, parseStack, resolveWebpackSource } from './initiator.js';

const CWD = '/repo/apps/web';

/** A real stack from `next dev` 14.2 on this repo, trimmed. */
const NEXT_DEV_STACK = `Error
    at IdentityApi.ssrFetch [as _request] (webpack-internal:///(rsc)/../../libs/common/src/api/ssrFetch.ts:20:47)
    at IdentityApi.getCurrentUser (webpack-internal:///(rsc)/./src/api/identityApi/identityApi.ts:16:37)
    at guard (webpack-internal:///(rsc)/../../libs/common/src/api/identityApi/ssrPermissionUtils.ts:12:26)
    at ContractsPage (webpack-internal:///(rsc)/./src/app/[locale]/(protected)/@content/contracts-management/page.tsx:27:95)
    at eval (webpack-internal:///(rsc)/../../node_modules/.pnpm/@sentry+nextjs@11.4.0/node_modules/@sentry/nextjs/build/cjs/common/wrapServerComponentWithSentry.js:18:32)
    at eC (/repo/node_modules/.pnpm/next@14.2.35/node_modules/next/dist/compiled/next-server/app-page.runtime.dev.js:35:265189)
    at /repo/node_modules/.pnpm/next@14.2.35/node_modules/next/dist/compiled/next-server/app-page.runtime.dev.js:35:267040
    at stringify (<anonymous>)
    at AsyncLocalStorage.run (node:internal/async_local_storage/async_context_frame:66:14)
    at listOnTimeout (node:internal/timers:685:17)`;

describe('parseStack', () => {
  it('maps frames through mapFrame before resolving them (Next 15+ leaves them at generated positions)', () => {
    const stack = `Error
    at handleClick (webpack-internal:///(rsc)/./app/page.tsx:12:13)
    at eC (/proj/node_modules/next/dist/compiled/next-server/app-page.runtime.dev.js:35:265189)`;
    const mapFrame = (rawFile: string, line: number, column: number) =>
      rawFile === 'webpack-internal:///(rsc)/./app/page.tsx' && line === 12 && column === 13 ? { file: 'file:///Users/me/NEXT%20JS%20/proj/app/page.tsx', line: 4, column: 5 } : undefined;

    const { initiator, frames } = parseStack(stack, { cwd: '/Users/me/NEXT JS /proj', mapFrame });

    expect(frames).toHaveLength(1);
    expect(initiator).toEqual({ file: '/Users/me/NEXT JS /proj/app/page.tsx', line: 4, column: 5, fn: 'handleClick' });
  });

  it('resolves webpack-internal frames to absolute source paths and drops framework frames', () => {
    const { frames } = parseStack(NEXT_DEV_STACK, { cwd: CWD });

    expect(frames.map((frame) => frame.file)).toEqual([
      '/repo/libs/common/src/api/ssrFetch.ts',
      '/repo/apps/web/src/api/identityApi/identityApi.ts',
      '/repo/libs/common/src/api/identityApi/ssrPermissionUtils.ts',
      '/repo/apps/web/src/app/[locale]/(protected)/@content/contracts-management/page.tsx',
    ]);
    expect(frames[0]).toMatchObject({ fn: 'IdentityApi.ssrFetch [as _request]', line: 20, column: 47 });
  });

  it('picks the first frame outside our API plumbing as the initiator', () => {
    const { initiator } = parseStack(NEXT_DEV_STACK, { cwd: CWD });

    expect(initiator).toEqual({
      file: '/repo/apps/web/src/app/[locale]/(protected)/@content/contracts-management/page.tsx',
      line: 27,
      column: 95,
      fn: 'ContractsPage',
    });
  });

  it('falls back to the innermost kept frame when every frame is plumbing', () => {
    const stack = `Error
    at callTjApi (webpack-internal:///(rsc)/../../libs/common/src/apiRoutes/tjApiHandler.ts:300:10)`;

    expect(parseStack(stack, { cwd: CWD }).initiator?.file).toBe('/repo/libs/common/src/apiRoutes/tjApiHandler.ts');
  });

  it('ignores the agent itself', () => {
    const stack = `Error
    at nextDevtoolsFetch (file:///Users/me/qaisdebugs/dist/agent/hooks/fetchHook.js:70:10)
    at Page (webpack-internal:///(rsc)/./src/app/page.tsx:3:3)`;

    expect(parseStack(stack, { cwd: CWD }).frames).toEqual([{ file: '/repo/apps/web/src/app/page.tsx', line: 3, column: 3, fn: 'Page' }]);
  });

  it('handles the instrument layer, file urls and windows-style directories', () => {
    const stack = `Error
    at register (webpack-internal:///(instrument)/./src/instrumentation.ts:12:5)
    at run (file:///repo/scripts/run.mjs:1:2)`;

    const { frames } = parseStack(stack, { cwd: 'C:\\work\\apps\\gov-portal' });

    expect(frames.map((frame) => frame.file)).toEqual(['C:/work/apps/gov-portal/src/instrumentation.ts', '/repo/scripts/run.mjs']);
  });

  it('caps the number of frames kept', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `    at f${i} (webpack-internal:///(rsc)/./src/f${i}.ts:1:1)`);

    expect(parseStack(`Error\n${lines.join('\n')}`, { cwd: CWD, maxFrames: 3 }).frames).toHaveLength(3);
  });

  it('returns nothing for a missing stack', () => {
    expect(parseStack(undefined, { cwd: CWD })).toEqual({ initiator: undefined, frames: [] });
  });
});

describe('parseStack with --enable-source-maps frames', () => {
  const stack = `Error
    at IdentityApi.ssrFetch [as _request] (webpack://@next/libs/common/src/api/ssrFetch.ts?1a2b:32:12)
    at IdentityApi.getCurrentUser (webpack://@acme/web/src/api/identityApi/identityApi.ts?3c4d:16:37)
    at ContractsPage (webpack://@acme/web/src/app/[locale]/(protected)/@content/contracts-management/page.tsx?bd7a:9:9)
    at eval (webpack://@acme/web/sentry-wrapper-module?6f96:18:32)
    at Object.apply (webpack://@acme/web/./src/app/[locale]/(protected)/@content/contracts-management/page.tsx?bd7a:62:10)`;

  it('maps the package-relative source names back to files under the app dir and the repo root', () => {
    const { frames, initiator } = parseStack(stack, { cwd: CWD, repoRoot: '/repo' });

    expect(frames.map((frame) => frame.file)).toEqual([
      '/repo/libs/common/src/api/ssrFetch.ts',
      '/repo/apps/web/src/api/identityApi/identityApi.ts',
      '/repo/apps/web/src/app/[locale]/(protected)/@content/contracts-management/page.tsx',
      '/repo/apps/web/src/app/[locale]/(protected)/@content/contracts-management/page.tsx',
    ]);
    expect(initiator).toMatchObject({ file: '/repo/apps/web/src/app/[locale]/(protected)/@content/contracts-management/page.tsx', line: 9, fn: 'ContractsPage' });
  });

  it('files other packages under node_modules so they are ignored', () => {
    const { frames, initiator } = parseStack(
      `Error\n    at C (webpack://next/dist/compiled/react/cjs/react.react-server.development.js?1:189:16)\n    at Page (webpack://@acme/web/src/app/page.tsx?2:3:3)`,
      { cwd: CWD, repoRoot: '/repo', packageName: '@acme/web' }
    );

    expect(frames).toHaveLength(1);
    expect(initiator?.fn).toBe('Page');
  });

  it("maps Next's browser build name _N_E to the app dir and the repo root", () => {
    const options = { cwd: CWD, repoRoot: '/repo', packageName: '@acme/web' };

    expect(resolveWebpackSource('webpack://_N_E/./src/app/[locale]/(public)/page.tsx?1a2b', options)).toBe('/repo/apps/web/src/app/[locale]/(public)/page.tsx');
    expect(resolveWebpackSource('webpack://_N_E/../../libs/common/src/api/fetchFn.ts?3c4d', options)).toBe('/repo/libs/common/src/api/fetchFn.ts');
    expect(resolveWebpackSource('webpack://_N_E/libs/common/src/api/fetchFn.ts', options)).toBe('/repo/libs/common/src/api/fetchFn.ts');
    expect(resolveWebpackSource('webpack://_N_E/../../node_modules/react/index.js', options)).toBe('/repo/node_modules/react/index.js');
  });

  it('handles an unscoped app package', () => {
    const { frames } = parseStack(`Error\n    at Page (webpack://portal/src/app/page.tsx?2:3:3)`, { cwd: '/repo/apps/portal', repoRoot: '/repo', packageName: 'portal' });

    expect(frames[0].file).toBe('/repo/apps/portal/src/app/page.tsx');
  });

  it('falls back to two levels above the app dir when no repo root is given', () => {
    const { frames } = parseStack(stack, { cwd: CWD });

    expect(frames[0].file).toBe('/repo/libs/common/src/api/ssrFetch.ts');
  });

  it('handles the unnormalised ../../ form too', () => {
    const { frames } = parseStack(`Error\n    at x (webpack://@acme/web/../../libs/common/src/a.ts?1:1:1)`, { cwd: CWD, repoRoot: '/repo' });

    expect(frames[0].file).toBe('/repo/libs/common/src/a.ts');
  });
});

describe('captureInitiator', () => {
  it('reports the caller, not itself, and restores the stack trace limit', () => {
    const before = Error.stackTraceLimit;

    const { initiator, frames } = captureInitiator(process.cwd(), 0);

    expect(Error.stackTraceLimit).toBe(before);
    expect(frames.length).toBeGreaterThan(0);
    expect(initiator?.file).toContain('initiator.test.ts');
  });

  it('skips wrapper frames when asked', () => {
    const viaWrapper = (): ReturnType<typeof captureInitiator> => captureInitiator(process.cwd(), 1);

    const { frames } = viaWrapper();

    expect(frames[0]?.fn).not.toBe('viaWrapper');
  });
});
