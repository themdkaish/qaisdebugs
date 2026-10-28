import { type RawSourceMap, SourceMapConsumer } from 'source-map-js';
import { type ParseStackOptions, resolveWebpackSource } from '../../../agent/shared/initiator';

/**
 * Source-map handling for the scripts a debug target has loaded.
 *
 * Webpack's dev build evals every module with a `webpack-internal:///(layer)/./src/...` URL and an
 * inline map, so the URL alone tells which file a script is and the map is decoded only for the
 * scripts that matter. Turbopack (the default since Next 15) bundles many files into one chunk, a
 * real file (`file:///.../.next/dev/server/chunks/...js` in Node, `http://localhost:3000/_next/
 * static/chunks/...js` in the browser) whose map is a separate `.js.map` next to it. Those maps
 * are fetched through the collector: first just their source names, to learn which files a chunk
 * holds, then in full once a breakpoint or a pause lands in the chunk.
 */

export interface MapLocation {
  kind: 'file' | 'http';
  /** An absolute path (`file`) or an absolute URL (`http`) of the map. */
  location: string;
}

export interface SourceEntry {
  /** The name as the consumer knows it, for queries. */
  raw: string;
  /** The absolute file it refers to. */
  file: string;
}

export interface ScriptRecord {
  scriptId: string;
  url: string;
  sourceMapURL?: string;
  /** The absolute file the script's URL names, when it is application code (webpack modules). */
  file?: string;
  /** The webpack layer, such as `rsc`, `ssr` or `app-pages-browser`. */
  layer?: string;
  /** Where the external map lives, when the script's map is not inline. */
  map?: MapLocation;
  consumer?: SourceMapConsumer | null;
  /** Source names from the map, in map order, each with its resolved absolute file. */
  sources?: SourceEntry[];
  /** In-flight loads, so concurrent callers share one request. */
  sourcesLoading?: Promise<SourceEntry[]>;
  consumerLoading?: Promise<SourceMapConsumer | null>;
}

const WEBPACK_INTERNAL = /^webpack-internal:\/\/\/(?:\(([^)]*)\)\/)?(.*)$/;

export function fileFromScriptUrl(url: string, options: ParseStackOptions): { file?: string; layer?: string } {
  const match = WEBPACK_INTERNAL.exec(url);
  if (!match) {
    return {};
  }

  const [, layer, rest] = match;
  const relative = rest.split('?')[0];
  if (!relative.startsWith('./') && !relative.startsWith('../')) return { layer };
  if (relative.includes('/node_modules/')) return { layer };

  return { layer, file: joinPath(options.cwd, relative) };
}

/**
 * Where a script's external map is, from the `sourceMappingURL` the bundler wrote (usually a
 * relative, percent-encoded name next to the script) and the script's own URL.
 */
export function mapLocation(url: string, sourceMapURL: string | undefined): MapLocation | undefined {
  if (!sourceMapURL || sourceMapURL.startsWith('data:')) return undefined;
  // qaisdebugs' own agent runs in the dev server too; it is not the app's code.
  if (/\/qaisdebugs\/dist\//.test(url)) return undefined;

  try {
    if (sourceMapURL.startsWith('file://')) return { kind: 'file', location: decodeURIComponent(new URL(sourceMapURL).pathname) };
    if (/^https?:\/\//.test(sourceMapURL)) return { kind: 'http', location: sourceMapURL };

    if (url.startsWith('file://')) {
      const directory = decodeURIComponent(new URL(url).pathname).replace(/\/[^/]*$/, '');

      return { kind: 'file', location: joinPath(directory, decodeURIComponent(sourceMapURL)) };
    }
    if (/^https?:\/\//.test(url)) return { kind: 'http', location: new URL(sourceMapURL, url).href };
  } catch {
    return undefined;
  }

  return undefined;
}

/** A script whose map must be fetched: a bundled chunk rather than a webpack module. */
export function isChunkScript(script: ScriptRecord): boolean {
  return Boolean(script.map) && !script.file;
}

export function decodeInlineSourceMap(sourceMapURL: string | undefined): RawSourceMap | undefined {
  if (!sourceMapURL?.startsWith('data:')) return undefined;

  const comma = sourceMapURL.indexOf(',');
  const header = sourceMapURL.slice(5, comma);
  const payload = sourceMapURL.slice(comma + 1);

  try {
    const json = header.includes('base64') ? atob(payload) : decodeURIComponent(payload);

    return JSON.parse(new TextDecoder().decode(Uint8Array.from(json, (char) => char.charCodeAt(0)))) as RawSourceMap;
  } catch {
    try {
      return JSON.parse(header.includes('base64') ? atob(payload) : decodeURIComponent(payload)) as RawSourceMap;
    } catch {
      return undefined;
    }
  }
}

/**
 * The absolute file a map's source name refers to. Next 13 and 14 name sources
 * `webpack://<package>/./src/x.tsx?hash`; Next 15+ writes absolute paths (`[absolute-resource-path]`)
 * under webpack and `file://` URLs under Turbopack.
 */
export function fileFromSourceName(name: string, options: ParseStackOptions): string | undefined {
  if (name.startsWith('file://')) return decodeURIComponent(name.slice('file://'.length)).replace(/\?[0-9a-f]+$/, '');
  if (name.startsWith('/') || /^[A-Za-z]:[\\/]/.test(name)) return name.replace(/\\/g, '/').replace(/\?[0-9a-f]+$/, '');

  return resolveWebpackSource(name, options);
}

/** Records the map's source names with their files; the consumer may have rewritten the names. */
function adoptSources(script: ScriptRecord, raw: RawSourceMap, consumer: SourceMapConsumer | undefined, options: ParseStackOptions): SourceEntry[] {
  // The consumer rewrites source names and answers queries only for its rewritten form: `./src/x.ts`
  // loses the `./`, and `webpack://@acme/web/../../libs/x.ts` becomes `webpack://libs/x.ts`
  // because `@next` is not a host to it. So the file is resolved from the map's raw name, and the
  // rewritten name (same index) is what gets passed back to the consumer.
  const rewritten = (consumer as unknown as { sources?: string[] } | undefined)?.sources ?? rawSourceNames(raw);
  const original = rawSourceNames(raw);
  script.sources = rewritten.map((name, index) => {
    const rawName = original.length === rewritten.length ? original[index] : name;

    return { raw: name, file: fileFromSourceName(rawName, options) ?? fileFromSourceName(name, options) ?? joinPath(options.cwd, rawName) };
  });

  return script.sources;
}

/** Every source name in a map, including the sections of an indexed map. */
function rawSourceNames(raw: RawSourceMap): string[] {
  const names: string[] = [...(raw.sources ?? [])];
  for (const section of (raw as unknown as { sections?: Array<{ map?: { sources?: string[] } }> }).sections ?? []) {
    for (const name of section.map?.sources ?? []) if (!names.includes(name)) names.push(name);
  }

  return names;
}

/** Decodes an inline map once and resolves each source name to a file. */
export function ensureConsumer(script: ScriptRecord, options: ParseStackOptions): SourceMapConsumer | null {
  if (script.consumer !== undefined) return script.consumer;

  const raw = decodeInlineSourceMap(script.sourceMapURL);
  if (!raw) {
    script.consumer = null;

    return null;
  }

  try {
    const consumer = new SourceMapConsumer(raw);
    script.consumer = consumer;
    adoptSources(script, raw, consumer, options);
  } catch {
    script.consumer = null;
  }

  return script.consumer;
}

/** Where the collector is. The inspector page is served by it (relative URLs); the MCP server is not. */
let collectorBase = '';

export function setCollectorBase(url: string): void {
  collectorBase = url.replace(/\/$/, '');
}

function collectorMapUrl(map: MapLocation, indexOnly: boolean): string {
  const params = new URLSearchParams(map.kind === 'file' ? { file: map.location } : { url: map.location });
  if (indexOnly) params.set('index', '1');

  return `${collectorBase}/sources/map?${params}`;
}

/** The files a script holds, fetching an external map's source list the first time. */
export function loadSources(script: ScriptRecord, options: ParseStackOptions): Promise<SourceEntry[]> {
  if (script.sources) return Promise.resolve(script.sources);
  if (!script.map) {
    ensureConsumer(script, options);

    return Promise.resolve(script.sources ?? []);
  }
  if (!script.sourcesLoading) {
    const map = script.map;
    script.sourcesLoading = fetch(collectorMapUrl(map, true))
      .then(async (response) => {
        if (!response.ok) throw new Error(`map index ${response.status}`);
        const payload = (await response.json()) as { sources?: string[] };

        return adoptSources(script, { version: 3, sources: payload.sources ?? [], names: [], mappings: '' } as unknown as RawSourceMap, undefined, options);
      })
      .catch(() => {
        script.sources = [];

        return [] as SourceEntry[];
      });
  }

  return script.sourcesLoading;
}

/** The script's consumer, fetching an external map in full the first time. */
export function loadConsumer(script: ScriptRecord, options: ParseStackOptions): Promise<SourceMapConsumer | null> {
  if (script.consumer !== undefined) return Promise.resolve(script.consumer);
  if (!script.map) return Promise.resolve(ensureConsumer(script, options));
  if (!script.consumerLoading) {
    const map = script.map;
    script.consumerLoading = fetch(collectorMapUrl(map, false))
      .then(async (response) => {
        if (!response.ok) throw new Error(`map ${response.status}`);
        const raw = (await response.json()) as RawSourceMap;
        const consumer = new SourceMapConsumer(raw);
        script.consumer = consumer;
        adoptSources(script, raw, consumer, options);

        return consumer;
      })
      .catch(() => {
        script.consumer = null;

        return null;
      });
  }

  return script.consumerLoading;
}

export interface OriginalPosition {
  file: string;
  line: number;
  column: number;
}

/** Maps a generated (0-based, as CDP reports it) location to the original file and 1-based line. */
export async function originalPosition(script: ScriptRecord, lineNumber: number, columnNumber: number, options: ParseStackOptions): Promise<OriginalPosition | undefined> {
  const consumer = await loadConsumer(script, options);
  if (!consumer) return script.file ? { file: script.file, line: lineNumber + 1, column: columnNumber } : undefined;

  const position = consumer.originalPositionFor({ line: lineNumber + 1, column: columnNumber });
  if (position.source === null || position.line === null) return undefined;

  const source = script.sources?.find((entry) => entry.raw === position.source);

  return { file: source?.file ?? fileFromSourceName(position.source, options) ?? position.source, line: position.line, column: position.column ?? 0 };
}

export interface GeneratedPosition {
  lineNumber: number;
  columnNumber: number;
}

/** The first generated (0-based) location on or after an original 1-based line of `file` in this script. */
export async function generatedPosition(script: ScriptRecord, file: string, line: number, options: ParseStackOptions): Promise<GeneratedPosition | undefined> {
  const consumer = await loadConsumer(script, options);
  if (!consumer) return script.file === file ? { lineNumber: line - 1, columnNumber: 0 } : undefined;

  const source = script.sources?.find((entry) => entry.file === file);
  if (!source) return undefined;

  for (let probe = line; probe < line + 5; probe += 1) {
    const best = generatedCandidates(consumer, source.raw, probe)
      .filter((candidate) => candidate.line !== null)
      .sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0))[0];
    if (best?.line != null) return { lineNumber: best.line - 1, columnNumber: best.column ?? 0 };
  }

  return undefined;
}

/**
 * Every generated position of an original line. The indexed consumer (sectioned maps, as Turbopack
 * writes them) lacks `allGeneratedPositionsFor`, so it is asked for the first mapping at or after
 * the line instead.
 */
function generatedCandidates(consumer: SourceMapConsumer, source: string, line: number): Array<{ line: number | null; column: number | null }> {
  try {
    return consumer.allGeneratedPositionsFor({ source, line, column: undefined as unknown as number });
  } catch {
    try {
      const position = consumer.generatedPositionFor({ source, line, column: 0, bias: SourceMapConsumer.LEAST_UPPER_BOUND });
      if (position.line === null) return [];
      // The lower bound may be a later line; keep it only when it maps back close to the one asked for.
      const back = consumer.originalPositionFor({ line: position.line, column: position.column ?? 0 });

      return back.line !== null && back.line >= line && back.line < line + 5 ? [position] : [];
    } catch {
      return [];
    }
  }
}

function joinPath(base: string, relative: string): string {
  const parts = base.replace(/\\/g, '/').replace(/\/$/, '').split('/');
  for (const segment of relative.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length > 1) parts.pop();
      continue;
    }
    parts.push(segment);
  }

  return parts.join('/');
}
