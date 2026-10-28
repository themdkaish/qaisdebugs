import { describe, expect, it } from 'vitest';
import { type ScriptRecord, ensureConsumer, generatedPosition, isChunkScript, loadSources, mapLocation, originalPosition } from './sourceMaps';

/** A map with one mapping per line: original line N of the only source is generated line N+2. */
function inlineMap(sourceName: string, lines: number, file = 'x.js'): string {
  const vlq = (value: number): string => {
    let v = value < 0 ? (-value << 1) | 1 : value << 1;
    let out = '';
    do {
      let digit = v & 31;
      v >>>= 5;
      if (v) digit |= 32;
      out += 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'[digit];
    } while (v);

    return out;
  };
  let mappings = ';;';
  for (let line = 1; line <= lines; line += 1) mappings += `${vlq(0)}${vlq(0)}${vlq(line === 1 ? 0 : 1)}${vlq(0)};`;
  const map = { version: 3, file, sources: [sourceName], sourcesContent: [''], names: [], mappings };

  return `data:application/json;charset=utf-8;base64,${btoa(JSON.stringify(map))}`;
}

const options = { cwd: '/repo/apps/web', repoRoot: '/repo', packageName: '@acme/web' };

/** An indexed map (as Turbopack writes them): one section holding the basic map, offset by `offsetLine` generated lines. */
function inlineIndexedMap(sourceName: string, lines: number, offsetLine: number): string {
  const basic = JSON.parse(atob(inlineMap(sourceName, lines).split(',')[1]));
  const map = { version: 3, sources: [], sections: [{ offset: { line: offsetLine, column: 0 }, map: basic }] };

  return `data:application/json;charset=utf-8;base64,${btoa(JSON.stringify(map))}`;
}

describe('mapLocation', () => {
  const chunk = 'file:///Users/me/NEXT%20JS%20/practice/.next/dev/server/chunks/ssr/%5Broot-of-the-server%5D__abc._.js';

  it('resolves a relative, percent-encoded map name next to a file script', () => {
    expect(mapLocation(chunk, '%5Broot-of-the-server%5D__abc._.js.map')).toEqual({ kind: 'file', location: '/Users/me/NEXT JS /practice/.next/dev/server/chunks/ssr/[root-of-the-server]__abc._.js.map' });
  });

  it('resolves a relative map name next to a browser chunk', () => {
    expect(mapLocation('http://localhost:3000/_next/static/chunks/_0_xd11._.js', '_0_xd11._.js.map')).toEqual({ kind: 'http', location: 'http://localhost:3000/_next/static/chunks/_0_xd11._.js.map' });
  });

  it('keeps absolute map URLs and ignores inline maps', () => {
    expect(mapLocation(chunk, 'file:///tmp/x.js.map')).toEqual({ kind: 'file', location: '/tmp/x.js.map' });
    expect(mapLocation('webpack-internal:///(rsc)/./app/page.tsx', 'data:application/json;base64,e30=')).toBeUndefined();
    expect(mapLocation(chunk, undefined)).toBeUndefined();
  });
});

describe('source maps of webpack modules', () => {
  it('resolves a lib file whose name the consumer would mangle', async () => {
    const script: ScriptRecord = {
      scriptId: '1',
      url: 'webpack-internal:///(ssr)/../../libs/common/src/views/Dashboard360/DashboardView.tsx',
      sourceMapURL: inlineMap('webpack://@acme/web/../../libs/common/src/views/Dashboard360/DashboardView.tsx?33d4', 10),
    };

    ensureConsumer(script, options);

    expect(script.sources?.[0].file).toBe('/repo/libs/common/src/views/Dashboard360/DashboardView.tsx');
    expect(await generatedPosition(script, '/repo/libs/common/src/views/Dashboard360/DashboardView.tsx', 5, options)).toEqual({ lineNumber: 6, columnNumber: 0 });
    expect(await originalPosition(script, 6, 0, options)).toEqual({ file: '/repo/libs/common/src/views/Dashboard360/DashboardView.tsx', line: 5, column: 0 });
  });

  it('resolves an app file and a browser-build lib file', async () => {
    const app: ScriptRecord = { scriptId: '2', url: 'webpack-internal:///(rsc)/./src/app/page.tsx', sourceMapURL: inlineMap('webpack://@acme/web/./src/app/page.tsx?1', 3) };
    const lib: ScriptRecord = { scriptId: '3', url: 'webpack-internal:///(app-pages-browser)/../../libs/common/src/api/fetchFn.ts', sourceMapURL: inlineMap('webpack://_N_E/../../libs/common/src/api/fetchFn.ts?2', 3) };

    ensureConsumer(app, options);
    ensureConsumer(lib, options);

    expect(app.sources?.[0].file).toBe('/repo/apps/web/src/app/page.tsx');
    expect(lib.sources?.[0].file).toBe('/repo/libs/common/src/api/fetchFn.ts');
    expect(await generatedPosition(lib, '/repo/libs/common/src/api/fetchFn.ts', 2, options)).toEqual({ lineNumber: 3, columnNumber: 0 });
  });

  it('resolves absolute source names as Next 15+ writes them, with spaces and as file URLs', async () => {
    const next16 = { cwd: '/Users/me/NEXT JS /practice', repoRoot: '/Users/me/NEXT JS /practice', packageName: 'practice' };
    const page: ScriptRecord = { scriptId: '4', url: 'webpack-internal:///(rsc)/./app/page.tsx', sourceMapURL: inlineMap('/Users/me/NEXT JS /practice/app/page.tsx', 6) };
    const asUrl: ScriptRecord = { scriptId: '5', url: 'webpack-internal:///(app-pages-browser)/./app/Widget.tsx', sourceMapURL: inlineMap('file:///Users/me/NEXT%20JS%20/practice/app/Widget.tsx', 6) };

    ensureConsumer(page, next16);
    ensureConsumer(asUrl, next16);

    expect(page.sources?.[0].file).toBe('/Users/me/NEXT JS /practice/app/page.tsx');
    expect(asUrl.sources?.[0].file).toBe('/Users/me/NEXT JS /practice/app/Widget.tsx');
    expect(await generatedPosition(page, '/Users/me/NEXT JS /practice/app/page.tsx', 4, next16)).toEqual({ lineNumber: 5, columnNumber: 0 });
    expect(await originalPosition(asUrl, 5, 0, next16)).toEqual({ file: '/Users/me/NEXT JS /practice/app/Widget.tsx', line: 4, column: 0 });
  });

  it('places and maps positions through an indexed map, as Turbopack chunks carry', async () => {
    const turbo = { cwd: '/proj', repoRoot: '/proj', packageName: 'proj' };
    const chunk: ScriptRecord = { scriptId: '6', url: 'file:///proj/.next/dev/server/chunks/ssr/_1_abc._.js', sourceMapURL: inlineIndexedMap('file:///proj/src/app/page.tsx', 6, 10) };

    ensureConsumer(chunk, turbo);

    expect(chunk.sources?.[0].file).toBe('/proj/src/app/page.tsx');
    expect(await generatedPosition(chunk, '/proj/src/app/page.tsx', 4, turbo)).toEqual({ lineNumber: 15, columnNumber: 0 });
    expect(await originalPosition(chunk, 15, 0, turbo)).toEqual({ file: '/proj/src/app/page.tsx', line: 4, column: 0 });
  });
});

describe('source maps of Vite modules', () => {
  const vite = { cwd: '/work/react-app', repoRoot: '/work/react-app', packageName: 'react-app' };
  // Vite serves each module at its own path with an inline map naming the source next to the map's `file`.
  const module = (): ScriptRecord => ({
    scriptId: '7',
    url: 'http://localhost:5174/src/app/App.tsx?t=1730123',
    sourceMapURL: inlineMap('App.tsx', 6, '/work/react-app/src/app/App.tsx'),
  });

  it('treats a module with an inline map as one whose files come from its map', () => {
    expect(isChunkScript(module())).toBe(true);
    expect(isChunkScript({ scriptId: '8', url: 'webpack-internal:///(rsc)/./app/page.tsx', file: '/work/app/page.tsx', sourceMapURL: inlineMap('page.tsx', 2) })).toBe(false);
    expect(isChunkScript({ scriptId: '9', url: 'http://localhost:5174/@vite/client' })).toBe(false);
  });

  it("resolves a plain .ts module's source from its URL when the map has no file", async () => {
    const api: ScriptRecord = { scriptId: '10', url: 'http://localhost:5174/src/app/lib/api.ts?t=5', sourceMapURL: inlineMap('api.ts', 4, '') };
    const outside: ScriptRecord = { scriptId: '11', url: 'http://localhost:5174/@fs/work/shared/fetch.ts', sourceMapURL: inlineMap('fetch.ts', 4, '') };

    expect((await loadSources(api, vite)).map((source) => source.file)).toEqual(['/work/react-app/src/app/lib/api.ts']);
    expect((await loadSources(outside, vite)).map((source) => source.file)).toEqual(['/work/shared/fetch.ts']);
  });

  it("resolves the source next to the module's file, both ways", async () => {
    const script = module();

    expect((await loadSources(script, vite)).map((source) => source.file)).toEqual(['/work/react-app/src/app/App.tsx']);
    expect(await generatedPosition(script, '/work/react-app/src/app/App.tsx', 4, vite)).toEqual({ lineNumber: 5, columnNumber: 0 });
    expect(await originalPosition(script, 5, 0, vite)).toEqual({ file: '/work/react-app/src/app/App.tsx', line: 4, column: 0 });
  });
});

describe('mapLocation and qaisdebugs itself', () => {
  it("skips the agent's own files, which run inside the dev server but are not the app", () => {
    expect(mapLocation('file:///opt/homebrew/lib/node_modules/qaisdebugs/dist/agent/install.js', 'install.js.map')).toBeUndefined();
    expect(mapLocation('file:///work/app/.next/dev/server/chunks/a._.js', 'a._.js.map')).toEqual({ kind: 'file', location: '/work/app/.next/dev/server/chunks/a._.js.map' });
  });
});
