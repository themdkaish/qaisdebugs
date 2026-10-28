import type { StackFrame } from './events.js';

/**
 * QaisDebugs — which application code made a call.
 *
 * In `next dev`, V8 stack frames carry webpack's module ids, which already name the original
 * source file and line, for example
 * `at ContractsPage (webpack-internal:///(rsc)/./src/app/[locale]/(protected)/@content/contracts-management/page.tsx:27:95)`.
 * Under `--enable-source-maps` Node rewrites such frames to the original file and line before
 * they are read here (Next 13 and 14). Next 15+ installs its own stack formatting, so frames
 * arrive at generated positions and `mapFrame` consults Node's source-map cache instead.
 */

export interface ParsedStack {
  /** The first frame that is application code: the one the inspector shows as the initiator. */
  initiator?: StackFrame;
  /** Every non-ignored frame, innermost first. */
  frames: StackFrame[];
}

/**
 * Maps a frame that V8 reported at a generated position (an eval'd webpack module, a bundled chunk
 * file) to its original file and 1-based line and column, or returns undefined when no map is known.
 */
export type FrameMapper = (rawFile: string, line: number, column: number) => { file: string; line: number; column: number } | undefined;

export interface ParseStackOptions {
  /** Absolute directory relative frame paths resolve against: the app directory. */
  cwd: string;
  /** The repository root, for source-mapped frames that point above the app directory. */
  repoRoot?: string;
  /**
   * The app's package name (`@acme/web`). Webpack names sources after it, so a frame whose
   * URL host is another package (`webpack://next/dist/...`) is a dependency, not application code.
   */
  packageName?: string;
  /** The repository's top-level folders; a source path starting with one of them is repo-relative. */
  repoDirs?: string[];
  /** Frames whose file matches are dropped entirely. */
  ignore?: RegExp[];
  /** Frames whose file matches are kept but never chosen as the initiator. */
  passThrough?: RegExp[];
  maxFrames?: number;
  /**
   * Applied to every frame before it is resolved. Next 15+ formats stacks itself, so frames reach
   * the agent at generated positions; the agent maps them through Node's source-map cache.
   */
  mapFrame?: FrameMapper;
}

/** Framework and dependency frames: never useful as an initiator and too noisy to keep. */
export const DEFAULT_IGNORE: RegExp[] = [
  /\/node_modules\//,
  // A bundler chunk that no map covered (Turbopack's `[externals]`, runtime): never application code.
  /\/\.next\//,
  /^node:/,
  /^<anonymous>/,
  /\/qaisdebugs\/(?:dist|agent)\/(?!.*\.test\.)/,
  /sentry-wrapper-module/,
  /\/webpack\/(?:bootstrap|runtime|startup)/,
];

/**
 * Our own plumbing between the component and the network. Kept in the frame list so the path is
 * visible, but the initiator is the component that called through it.
 */
export const DEFAULT_PASS_THROUGH: RegExp[] = [
  /libs\/common\/src\/api\//,
  /libs\/common\/src\/apiRoutes\//,
  /libs\/common\/src\/observability\//,
  /\/src\/api\//,
];

const FRAME = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;
const WEBPACK_PREFIX = /^webpack-internal:\/\/\/(?:\([^)]*\)\/)?/;
/**
 * A source-mapped frame, as Node prints it under `--enable-source-maps`: webpack names the original
 * `webpack://<package name>/<path relative to the app dir>?<hash>`, and Node's URL handling turns
 * `@acme/web/./src/x.tsx` into host `@acme`, path `/web/src/x.tsx`, and
 * `../../libs/...` into `/libs/...`.
 */
const WEBPACK_SOURCE = /^webpack:\/\/([^/]*)(\/.*)$/;

export function parseStack(stack: string | undefined, options: ParseStackOptions): ParsedStack {
  const ignore = options.ignore ?? DEFAULT_IGNORE;
  const passThrough = options.passThrough ?? DEFAULT_PASS_THROUGH;
  const maxFrames = options.maxFrames ?? 15;
  const frames: StackFrame[] = [];
  let initiator: StackFrame | undefined;

  for (const line of (stack ?? '').split('\n')) {
    const match = FRAME.exec(line);
    if (!match) continue;

    const [, fn, rawFile, line1, column] = match;
    const mapped = options.mapFrame?.(rawFile, Number(line1), Number(column));
    const file = normaliseFile(mapped?.file ?? rawFile, options);

    if (ignore.some((pattern) => pattern.test(file))) continue;

    const frame: StackFrame = { file, line: mapped?.line ?? Number(line1), column: mapped?.column ?? Number(column), fn: fn || undefined };
    frames.push(frame);

    if (!initiator && !passThrough.some((pattern) => pattern.test(file))) {
      initiator = frame;
    }

    if (frames.length >= maxFrames) break;
  }

  return { initiator: initiator ?? frames[0], frames };
}

/**
 * Captures the current stack and parses it. `skip` drops that many frames above the caller, so a
 * wrapper can hide itself. Temporarily raises the V8 frame limit: Next's wrappers put several
 * framework frames between a component and `fetch`.
 */
export function captureInitiator(target: string | ParseStackOptions, skip = 0, repoRoot?: string): ParsedStack {
  const options: ParseStackOptions = typeof target === 'string' ? { cwd: target, repoRoot } : target;
  const errorCtor = Error as ErrorConstructor & { stackTraceLimit?: number };
  const previousLimit = errorCtor.stackTraceLimit;
  errorCtor.stackTraceLimit = 40;

  let stack: string | undefined;
  try {
    stack = new Error().stack;
  } finally {
    errorCtor.stackTraceLimit = previousLimit;
  }

  // Drop the "Error" title line, this function's own frame, and the caller's wrappers.
  const lines = (stack ?? '').split('\n');
  const body = lines.slice(1 + 1 + skip).join('\n');

  return parseStack(body, options);
}

/** Resolves a source-mapped `webpack://host/path` name to an absolute file. Exported for the inspector UI. */
export function resolveWebpackSource(rawFile: string, options: ParseStackOptions): string | undefined {
  const sourceMapped = WEBPACK_SOURCE.exec(rawFile);
  if (!sourceMapped) return undefined;

  const [, host, rawPath] = sourceMapped;
  const path = normaliseSegments(rawPath.split('?')[0]);
  const cwd = options.cwd.replace(/\\/g, '/').replace(/\/$/, '');
  const appDirName = cwd.split('/').pop() ?? '';
  const repoRoot = options.repoRoot ?? resolvePath(cwd, '../..');

  // Next's browser and edge builds are named `_N_E`, and their source paths are relative to the
  // app dir (`./src/...`) or climb out of it (`../../libs/...`, collapsed to `/libs/...`).
  if (host === '_N_E') return resolveAppRelative(path, cwd, repoRoot, options.repoDirs);

  if (!options.packageName) {
    // Without the package name, go by shape: the app dir's own name, a scoped host (the workspace
    // scope, so `/libs/...`), or an unscoped host, which is a plain dependency.
    if (path.startsWith(`/${appDirName}/`)) return resolvePath(cwd, path.slice(appDirName.length + 2));
    if (host.startsWith('@')) return resolvePath(repoRoot, path.slice(1));

    return resolvePath(repoRoot, `node_modules/${host}${path}`);
  }

  const packageName = options.packageName;
  const [scope, unscopedName] = packageName.startsWith('@') ? packageName.split('/') : ['', packageName];

  if (scope ? host === scope : host === unscopedName) {
    // `@scope/name/./src/x.ts` parses as host `@scope`, path `/name/src/x.ts`; an unscoped package's
    // name is the host and the path is already relative to the app dir.
    if (scope && unscopedName && path.startsWith(`/${unscopedName}/`)) {
      return resolvePath(cwd, path.slice(unscopedName.length + 2));
    }
    if (!scope) {
      return resolvePath(cwd, path.slice(1));
    }

    // `../../libs/common/...` collapsed to `/libs/common/...`: relative to the repository root.
    return resolvePath(repoRoot, path.slice(1));
  }

  // Another package's source (`webpack://next/dist/...`): a dependency.
  return resolvePath(repoRoot, `node_modules/${host}${path}`);
}

function normaliseFile(rawFile: string, options: ParseStackOptions): string {
  const resolved = resolveWebpackSource(rawFile, options);
  if (resolved) return resolved;

  const cwd = options.cwd;
  let file = rawFile.replace(WEBPACK_PREFIX, '').split('?')[0];

  if (file.startsWith('file://')) {
    file = decodeURIComponent(file.slice('file://'.length));
  }

  if (file.startsWith('./') || file.startsWith('../')) {
    return resolvePath(cwd, file);
  }

  return file;
}

const COMMON_REPO_DIRS = ['apps', 'libs', 'packages', 'shared', 'modules', 'services', 'node_modules'];

/**
 * A path that is relative to the app dir unless its first segment is one of the repository's
 * top-level folders (webpack writes `../../libs/x.ts`, which URL handling collapses to `/libs/x.ts`).
 */
function resolveAppRelative(path: string, cwd: string, repoRoot: string, repoDirs?: string[]): string {
  const first = path.split('/')[1] ?? '';
  const repoLevel = new Set([...(repoDirs ?? []), ...COMMON_REPO_DIRS]);

  return repoRoot !== cwd && repoLevel.has(first) ? resolvePath(repoRoot, path.slice(1)) : resolvePath(cwd, path.slice(1));
}

/** Collapses `.` and `..` inside an absolute, slash-separated path without leaving its root. */
function normaliseSegments(path: string): string {
  const out: string[] = [];

  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      out.pop();
      continue;
    }
    out.push(segment);
  }

  return `/${out.join('/')}`;
}

/** `path.resolve` without `node:path`, so this module also runs in the browser agent. */
function resolvePath(cwd: string, relative: string): string {
  const parts = cwd.replace(/\\/g, '/').replace(/\/$/, '').split('/');

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
