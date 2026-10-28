import { describe, expect, it } from 'vitest';
import { SourceMapGenerator } from 'source-map-js';
import { createFrameResolver, originalFile, rawFrames, sourceBesideMapFile } from './frames.js';

const page = 'http://localhost:3000';
const stack = [
  'Error',
  '    at qaisdebugsFetch (qaisdebugs-client.js:1:200)',
  '    at loadVehicles (webpack-internal:///(app-pages-browser)/./src/views/Fleet/useFleet.ts:48:17)',
  '    at eval (webpack-internal:///(app-pages-browser)/./node_modules/react-dom/cjs/react-dom.development.js:10:1)',
  '    at bump (http://localhost:3000/_next/static/chunks/app_Playground_tsx_1a2b._.js:99:3)',
  '    at https://cdn.example.com/widget.js:1:1',
].join('\n');

describe('rawFrames', () => {
  it("keeps the bundler's app modules and the dev server's chunks, nothing else", () => {
    expect(rawFrames(stack, page)).toEqual([
      { file: 'webpack-internal:///(app-pages-browser)/./src/views/Fleet/useFleet.ts', line: 48, column: 17, methodName: 'loadVehicles' },
      { file: 'http://localhost:3000/_next/static/chunks/app_Playground_tsx_1a2b._.js', line: 99, column: 3, methodName: 'bump' },
    ]);
  });
});

describe('originalFile', () => {
  it("turns the dev server's file names into absolute paths and drops library code", () => {
    const cwd = '/work/apps/gov-portal';
    expect(originalFile('src/app/global-error.tsx', cwd)).toBe('/work/apps/gov-portal/src/app/global-error.tsx');
    expect(originalFile('./src/views/x.tsx', cwd)).toBe('/work/apps/gov-portal/src/views/x.tsx');
    expect(originalFile('[project]/app/Playground.tsx', cwd)).toBe('/work/apps/gov-portal/app/Playground.tsx');
    expect(originalFile('file:///work/NEXT%20JS%20/app/Playground.tsx', cwd)).toBe('/work/NEXT JS /app/Playground.tsx');
    expect(originalFile('../../libs/common/src/api/fetchFn.ts', cwd)).toBe('/work/libs/common/src/api/fetchFn.ts');
    expect(originalFile('/work/apps/gov-portal/src/a.ts', cwd)).toBe('/work/apps/gov-portal/src/a.ts');
    expect(originalFile('node_modules/next/dist/client/index.js', cwd)).toBeUndefined();
    expect(originalFile(undefined, cwd)).toBeUndefined();
  });
});

describe('sourceBesideMapFile', () => {
  it("puts a Vite module's source next to the map's file", () => {
    expect(sourceBesideMapFile('main.tsx', '/work/react-app/src/main.tsx')).toBe('/work/react-app/src/main.tsx');
    expect(sourceBesideMapFile('../lib/api.ts', '/work/react-app/src/app/App.tsx')).toBe('/work/react-app/src/lib/api.ts');
  });

  it('leaves absolute, scheme and Turbopack sources, and maps without an absolute file, alone', () => {
    expect(sourceBesideMapFile('/work/x.ts', '/work/react-app/src/main.tsx')).toBe('/work/x.ts');
    expect(sourceBesideMapFile('turbopack:///[project]/app/page.tsx', '/work/chunk.js')).toBe('turbopack:///[project]/app/page.tsx');
    expect(sourceBesideMapFile('[project]/app/page.tsx', '/work/chunk.js')).toBe('[project]/app/page.tsx');
    expect(sourceBesideMapFile('main.tsx', 'main.js')).toBe('main.tsx');
    expect(sourceBesideMapFile('main.tsx', undefined)).toBe('main.tsx');
  });

  it("uses the module's URL when the map has no file, as Vite's maps of plain .ts modules", () => {
    expect(sourceBesideMapFile('api.ts', undefined, 'http://localhost:5174/src/app/lib/api.ts?t=17', '/work/react-app')).toBe('/work/react-app/src/app/lib/api.ts');
    expect(sourceBesideMapFile('fetch.ts', undefined, 'http://localhost:5174/@fs/work/shared/src/fetch.ts', '/work/react-app')).toBe('/work/shared/src/fetch.ts');
    expect(sourceBesideMapFile('[project]/app/page.tsx', undefined, 'http://localhost:3000/_next/static/chunks/x.js', '/work/app')).toBe('[project]/app/page.tsx');
  });
});

describe('createFrameResolver', () => {
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('asks Next 15+ for webpack frames in one request, caches the answers, and reads Turbopack chunk maps', async () => {
    const calls: string[] = [];
    // A one-line chunk whose column 2 maps to app/Playground.tsx line 47, column 5.
    const chunkMap = { version: 3, sources: ['file:///work/app/app/Playground.tsx'], names: [], mappings: 'EA8CI' };
    const resolve = createFrameResolver(async (url) => {
      calls.push(url);
      if (url.endsWith('.js.map')) return json(chunkMap);

      return json([{ status: 'fulfilled', value: { originalStackFrame: { file: 'src/views/Fleet/useFleet.ts', line1: 42, column1: 9 } } }]);
    }, '/work/app', page);
    const twoFrames = [
      'Error',
      '    at loadVehicles (webpack-internal:///(app-pages-browser)/./src/views/Fleet/useFleet.ts:48:17)',
      '    at bump (http://localhost:3000/_next/static/chunks/app_Playground_tsx_1a2b._.js:1:3)',
    ].join('\n');

    const frames = await resolve(twoFrames);
    await resolve(twoFrames);

    expect(frames).toEqual([
      { file: '/work/app/src/views/Fleet/useFleet.ts', line: 42, column: 9, fn: 'loadVehicles' },
      { file: '/work/app/app/Playground.tsx', line: 47, column: 5, fn: 'bump' },
    ]);
    expect(calls.sort()).toEqual(['/__nextjs_original-stack-frames', 'http://localhost:3000/_next/static/chunks/app_Playground_tsx_1a2b._.js.map']);
  });

  it('falls back to one request per frame on Next 14', async () => {
    const calls: string[] = [];
    const resolve = createFrameResolver(async (url) => {
      calls.push(url.split('?')[0]);
      // What a portal with locale middleware answers: a redirect, followed to an HTML page.
      if (url.startsWith('/__nextjs_original-stack-frames')) return new Response('<!DOCTYPE html>', { status: 200, headers: { 'content-type': 'text/html' } });

      return json({ originalStackFrame: { file: 'src/views/Fleet/useFleet.ts', lineNumber: 42, column: 9 } });
    }, '/work/app', page);

    const frames = await resolve(stack.split('\n').slice(0, 3).join('\n'));

    expect(frames).toEqual([{ file: '/work/app/src/views/Fleet/useFleet.ts', line: 42, column: 9, fn: 'loadVehicles' }]);
    expect(calls).toEqual(['/__nextjs_original-stack-frames', '/__nextjs_original-stack-frame']);
  });

  it("names a monorepo library file from the module's own URL, not the dev server's relative name", async () => {
    const resolve = createFrameResolver(async (url) =>
      url.startsWith('/__nextjs_original-stack-frames')
        ? new Response('', { status: 404 })
        : json({ originalStackFrame: { file: '../libs/common/src/api/fetchFn.ts', lineNumber: 132, column: 17 } })
    , '/repo/apps/gov-portal', page);

    const frames = await resolve('Error\n    at Module.fetchFn (webpack-internal:///(app-pages-browser)/../../libs/common/src/api/fetchFn.ts:160:23)');

    expect(frames).toEqual([{ file: '/repo/libs/common/src/api/fetchFn.ts', line: 132, column: 17, fn: 'Module.fetchFn' }]);
  });

  it('leaves out frames the dev server marks as library code, and survives a failing server', async () => {
    const ignored = createFrameResolver(async () => json([{ status: 'fulfilled', value: { originalStackFrame: { file: 'x.ts', line1: 1, ignored: true } } }, { status: 'rejected' }]), '/w', page);
    const broken = createFrameResolver(async () => {
      throw new Error('offline');
    }, '/w', page);

    expect(await ignored(stack)).toEqual([]);
    expect(await broken(stack)).toEqual([]);
  });

  it("maps a Vite module's frame through the map Vite serves at <module>.map", async () => {
    const generator = new SourceMapGenerator({ file: '/work/react-app/src/app/App.tsx' });
    generator.addMapping({ generated: { line: 40, column: 4 }, original: { line: 12, column: 2 }, source: 'App.tsx' });
    const calls: string[] = [];
    const fetchImpl = async (url: string): Promise<Response> => {
      calls.push(url);
      return json(JSON.parse(generator.toString()));
    };
    const resolve = createFrameResolver(fetchImpl as typeof fetch, '/work/react-app', 'http://localhost:5174');
    const viteStack = 'Error\n    at loadLeads (http://localhost:5174/src/app/App.tsx?t=1730123:40:5)';

    expect(await resolve(viteStack)).toEqual([{ file: '/work/react-app/src/app/App.tsx', line: 12, column: 3, fn: 'loadLeads' }]);
    expect(calls).toEqual(['http://localhost:5174/src/app/App.tsx.map']);
  });
});
