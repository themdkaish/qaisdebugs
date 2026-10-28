/**
 * QaisDebugs — the page script's call sites, as original files and lines.
 *
 * A browser stack points at the code the bundler produced, whose line numbers differ from the
 * source. Webpack frames (`webpack-internal:///…`) are mapped by the Next dev server, the way its
 * error overlay does it: `POST /__nextjs_original-stack-frames` (Next 15 and later, a batch) or
 * `GET /__nextjs_original-stack-frame` (Next 14, one frame). Turbopack frames point at chunks
 * served next to their source maps (`chunk.js.map`), which the script reads itself. Answers are
 * cached per position, maps per chunk.
 */
import { type RawSourceMap, SourceMapConsumer } from 'source-map-js';
import type { StackFrame } from '../agent/shared/events.js';

export interface RawFrame {
  file: string;
  line: number;
  column: number;
  methodName: string;
}

/** How many frames of a stack are looked up; the app's own code is near the top. */
const MAX_FRAMES = 8;

/**
 * Frames that may be the app's code: the bundler's modules (`webpack-internal:///…`) and chunks
 * served by the dev server. The page script's own frames and webpack's `node_modules` are left out.
 */
export function rawFrames(stack: string | undefined, pageOrigin: string): RawFrame[] {
  if (!stack) return [];
  const frames: RawFrame[] = [];
  for (const line of stack.split('\n')) {
    // `webpack-internal:///(app-pages-browser)/./src/x.tsx` has parentheses of its own.
    const match = /^\s*at (?:(.+?) \()?((?:webpack-internal:|https?:)\S+?):(\d+):(\d+)\)?\s*$/.exec(line);
    if (!match) continue;
    const [, methodName = '', file, lineText, columnText] = match;
    if (file.startsWith('http') && !file.startsWith(pageOrigin)) continue;
    if (/qaisdebugs-client/.test(file) || /\/node_modules\//.test(file)) continue;
    frames.push({ file, line: Number(lineText), column: Number(columnText), methodName });
    if (frames.length === MAX_FRAMES) break;
  }

  return frames;
}

/**
 * Vite names a module's one source relative to the module (`main.tsx`). The map's `file` gives the
 * module's absolute path when the React plugin wrote it; otherwise the source sits next to the URL
 * the module was served from, under the app folder (`/src/lib/api.ts`), or at the absolute path
 * after `/@fs` for files outside it. Absolute, scheme and Turbopack names pass through.
 */
export function sourceBesideMapFile(source: string, mapFile: string | undefined, moduleUrl?: string, cwd?: string): string {
  if (source.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(source) || source.startsWith('[')) return source;
  if (mapFile?.startsWith('/')) return normalize(`${mapFile.slice(0, mapFile.lastIndexOf('/'))}/${source}`);
  if (!moduleUrl || !cwd || !/^https?:/.test(moduleUrl)) return source;

  const served = safeDecode(new URL(source, moduleUrl).pathname);

  return served.startsWith('/@fs/') ? served.slice('/@fs'.length) : normalize(`${cwd.replace(/\/$/, '')}${served}`);
}

/** A file name from the dev server's answer as an absolute path, or undefined for library code. */
export function originalFile(file: string | undefined, cwd: string): string | undefined {
  if (!file) return undefined;
  const cleaned = safeDecode(file)
    .replace(/^turbopack:\/\/\/?/, '')
    .replace(/^webpack-internal:\/\/\/(\([^)]*\)\/)?/, '')
    .replace(/^webpack:\/\/[^/]*\//, '')
    .replace(/^\[project\]\//, '')
    .replace(/^file:\/\//, '')
    .replace(/[?#].*$/, '');
  if (/(^|\/)node_modules\//.test(cleaned) || /^(https?:|\[)/.test(cleaned)) return undefined;

  return normalize(cleaned.startsWith('/') ? cleaned : `${cwd.replace(/\/$/, '')}/${cleaned}`);
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Resolves `.` and `..` segments, so `apps/web/../../libs/x.ts` reads `libs/x.ts`. */
function normalize(file: string): string {
  const out: string[] = [];
  for (const part of file.split('/')) {
    if (part === '..') out.pop();
    else if (part !== '.' && (part !== '' || out.length === 0)) out.push(part);
  }

  return out.join('/') || '/';
}

interface MappedFrame {
  file?: string;
  line1?: number | null;
  column1?: number | null;
  lineNumber?: number | null;
  column?: number | null;
  ignored?: boolean;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** A function from a stack to the app's frames in their original files, innermost first. */
export function createFrameResolver(fetchImpl: Fetch, cwd: string, pageOrigin: string): (stack: string | undefined) => Promise<StackFrame[]> {
  const cache = new Map<string, Promise<StackFrame | undefined>>();
  const chunkMaps = new Map<string, Promise<SourceMapConsumer | undefined>>();
  let mode: 'batch' | 'single' = readMode();

  /**
   * The source map of a Turbopack chunk or a Vite module, both served at `<url>.map`. Cached by the
   * full URL: Vite adds `?t=…` to a module it hot-reloads, which then needs its new map.
   */
  const chunkMap = (chunkUrl: string): Promise<SourceMapConsumer | undefined> => {
    const key = chunkUrl.split('#')[0];
    let loading = chunkMaps.get(key);
    if (!loading) {
      loading = fetchImpl(`${key.split('?')[0]}.map`, { signal: timeout() })
        .then(async (response) => (response.ok ? new SourceMapConsumer((await response.json()) as RawSourceMap) : undefined))
        .catch(() => undefined);
      chunkMaps.set(key, loading);
    }

    return loading;
  };

  const fromChunk = async (raw: RawFrame): Promise<StackFrame | undefined> => {
    const consumer = await chunkMap(raw.file);
    const position = consumer?.originalPositionFor({ line: raw.line, column: raw.column - 1 });
    if (!position?.source || !position.line) return undefined;
    const file = originalFile(sourceBesideMapFile(position.source, (consumer as unknown as { file?: string }).file, raw.file, cwd), cwd);

    return file ? { file, line: position.line, column: (position.column ?? 0) + 1, fn: raw.methodName || undefined } : undefined;
  };

  const toFrame = (raw: RawFrame, mapped: MappedFrame | undefined): StackFrame | undefined => {
    if (!mapped || mapped.ignored) return undefined;
    // A webpack module's URL names its file exactly, and its map covers only that file. Next 14
    // names files outside the app folder relative to the wrong directory, so the URL wins.
    const file = (raw.file.startsWith('webpack-internal:') ? originalFile(raw.file, cwd) : undefined) ?? originalFile(mapped.file, cwd);
    const line = mapped.line1 ?? mapped.lineNumber;
    if (!file || !line) return undefined;

    return { file, line, column: mapped.column1 ?? mapped.column ?? 1, fn: raw.methodName || undefined };
  };

  const single = async (raw: RawFrame): Promise<StackFrame | undefined> => {
    const query = new URLSearchParams({
      isServer: 'false',
      isEdgeServer: 'false',
      isAppDirectory: 'true',
      errorMessage: '',
      file: raw.file,
      methodName: raw.methodName,
      lineNumber: String(raw.line),
      column: String(raw.column),
      line1: String(raw.line),
      column1: String(raw.column),
    });
    const response = await fetchImpl(`/__nextjs_original-stack-frame?${query}`, { signal: timeout() });
    if (!response.ok) return undefined;

    return toFrame(raw, ((await response.json()) as { originalStackFrame?: MappedFrame }).originalStackFrame);
  };

  const batch = async (frames: RawFrame[]): Promise<Array<StackFrame | undefined> | undefined> => {
    const response = await fetchImpl('/__nextjs_original-stack-frames', {
      method: 'POST',
      signal: timeout(),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        isServer: false,
        isEdgeServer: false,
        isAppDirectory: true,
        // Next 15.0–15.2 read lineNumber/column, later versions line1/column1.
        frames: frames.map((raw) => ({ file: raw.file, methodName: raw.methodName, arguments: [], lineNumber: raw.line, column: raw.column, line1: raw.line, column1: raw.column })),
      }),
    });
    // Next 14 has no batch endpoint: the request falls through to the app, which answers 404 or,
    // with locale middleware, redirects to an HTML page.
    if (response.redirected || (response.status >= 300 && response.status < 500) || !/json/i.test(response.headers.get('content-type') ?? '')) return undefined;
    if (!response.ok) return frames.map(() => undefined);
    const results = (await response.json()) as Array<{ status: string; value?: { originalStackFrame?: MappedFrame } }>;

    return frames.map((raw, index) => (results[index]?.status === 'fulfilled' ? toFrame(raw, results[index].value?.originalStackFrame) : undefined));
  };

  const lookUp = async (frames: RawFrame[]): Promise<Array<StackFrame | undefined>> => {
    const bundled = frames.filter((raw) => raw.file.startsWith('webpack-internal:'));
    const chunks = frames.filter((raw) => !raw.file.startsWith('webpack-internal:'));
    const [fromServer, fromMaps] = await Promise.all([bundled.length ? viaDevServer(bundled) : [], Promise.all(chunks.map((raw) => fromChunk(raw).catch(() => undefined)))]);

    return frames.map((raw) => (raw.file.startsWith('webpack-internal:') ? fromServer[bundled.indexOf(raw)] : fromMaps[chunks.indexOf(raw)]));
  };

  const viaDevServer = async (frames: RawFrame[]): Promise<Array<StackFrame | undefined>> => {
    if (mode === 'batch') {
      const mapped = await batch(frames).catch(() => frames.map(() => undefined));
      if (mapped) return mapped;
      mode = 'single';
      saveMode(mode);
    }

    return Promise.all(frames.map((raw) => single(raw).catch(() => undefined)));
  };

  return async (stack) => {
    const frames = rawFrames(stack, pageOrigin);
    const missing = frames.filter((raw) => !cache.has(key(raw)));
    if (missing.length) {
      const pending = lookUp(missing);
      missing.forEach((raw, index) => cache.set(key(raw), pending.then((mapped) => mapped[index])));
    }
    const resolved = await Promise.all(frames.map((raw) => cache.get(key(raw)) as Promise<StackFrame | undefined>));

    return resolved.filter((frame): frame is StackFrame => frame !== undefined);
  };
}

const MODE_KEY = 'qaisdebugs.frameLookup';

/** Remembered per tab, so a dev server without the batch endpoint is asked for it only once. */
function readMode(): 'batch' | 'single' {
  try {
    return typeof sessionStorage !== 'undefined' && sessionStorage.getItem(MODE_KEY) === 'single' ? 'single' : 'batch';
  } catch {
    return 'batch';
  }
}

function saveMode(mode: 'batch' | 'single'): void {
  try {
    sessionStorage.setItem(MODE_KEY, mode);
  } catch {
    // Storage blocked: ask again next page load.
  }
}

/** A paused dev server answers nothing; the event is then recorded without its call site. */
function timeout(): AbortSignal | undefined {
  return typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(5000) : undefined;
}

function key(raw: RawFrame): string {
  return `${raw.file}:${raw.line}:${raw.column}`;
}
