import { readFileSync, readdirSync } from 'node:fs';
import inspector from 'node:inspector';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureCollector, findRepoRoot } from './collector.js';
import { createContextStore } from './context.js';
import { installConsoleHook } from './hooks/consoleHook.js';
import { installFetchHook } from './hooks/fetchHook.js';
import { installHttpClientHook } from './hooks/httpClientHook.js';
import { installHttpHook } from './hooks/httpHook.js';
import { pageScriptTag } from './hooks/pageScript.js';
import { createBus } from './shared/bus.js';
import { DEFAULT_COLLECTOR_URL } from './shared/constants.js';
import type { LogLevel } from './shared/events.js';
import { newId } from './shared/ids.js';
import { mapGeneratedFrame } from './sourceMapFrames.js';
import { wallClock } from './shared/clock.js';

/**
 * QaisDebugs — the agent entry.
 *
 * Loaded into every Node process started with `NODE_OPTIONS=--import .../dist/agent/index.js`,
 * which includes pnpm, Nx, the `next` launcher and Next's worker children. Only the process that
 * actually serves HTTP gets the hooks: Next's server, or a Vite dev server. Everything else
 * returns immediately.
 */

export type ProcessRole = 'server' | 'launcher';

const SERVER_ENTRY = /[\\/]next[\\/]dist[\\/]server[\\/]lib[\\/]start-server\.js$/;
/** Vite's command, run as its own file or through the `node_modules/.bin/vite` link. */
const VITE_ENTRY = /[\\/]vite[\\/]bin[\\/]vite\.js$|[\\/]node_modules[\\/]\.bin[\\/]vite$/;
const LAUNCHER_ENTRY = /[\\/]next[\\/]dist[\\/]bin[\\/]next$/;

export function detectRole(entry: string | undefined): ProcessRole | undefined {
  if (!entry) return undefined;
  if (SERVER_ENTRY.test(entry) || VITE_ENTRY.test(entry)) return 'server';
  if (LAUNCHER_ENTRY.test(entry)) return 'launcher';

  return undefined;
}

export function readPackageName(directory: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8')) as { name?: unknown };

    return typeof parsed.name === 'string' ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}

/** The app's display name: its package name without the scope, else its folder name. */
export function appNameFrom(directory: string, packageName: string | undefined): string {
  const fromPackage = packageName?.replace(/^@[^/]+\//, '');

  return fromPackage || path.basename(directory) || 'app';
}

/** The repository's top-level folders (minus dependencies and dot folders). */
export function listTopLevelDirs(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

type GlobalWithFlag = typeof globalThis & { __QAISDEBUGS_INSTALLED__?: boolean };

/**
 * Opens Node's inspector on a random loopback port so the inspector UI can set breakpoints in
 * server code. Costs nothing until a debugger connects. `QAISDEBUGS_INSPECT=0` leaves it closed.
 */
function openInspector(warn: (message: string) => void): string | undefined {
  if (process.env.QAISDEBUGS_INSPECT === '0') return undefined;

  try {
    if (!inspector.url()) {
      inspector.open(0, '127.0.0.1', false);
    }

    return inspector.url();
  } catch (error) {
    warn(`could not open the inspector port: ${error instanceof Error ? error.message : String(error)}`);

    return undefined;
  }
}

/**
 * The page script's `<script>` element, or undefined when `QAISDEBUGS_CLIENT=0` or the script was
 * not built. It lives next to the agent in the package: `dist/browser/client.js`.
 */
function loadPageScript(config: { app: string; collectorUrl: string; cwd: string }, warn: (message: string) => void): string | undefined {
  if (process.env.QAISDEBUGS_CLIENT === '0') return undefined;

  try {
    const code = readFileSync(fileURLToPath(new URL('../browser/client.js', import.meta.url)), 'utf8');

    return pageScriptTag({ ...config, code });
  } catch (error) {
    warn(`browser capture is off: ${error instanceof Error ? error.message : String(error)}`);

    return undefined;
  }
}

/** This package's version, reported with each dev server (`dist/agent` → `package.json`). */
function packageVersion(): string {
  try {
    return (JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** The command name the developer used (`qaisdebugs`, or a personal one such as `malaydebugs`). */
const brand = process.env.QAISDEBUGS_BRAND || 'qaisdebugs';

export function install(): ProcessRole | undefined {
  if (process.env.QAISDEBUGS === '0' || process.env.NODE_ENV === 'production') return undefined;

  const role = detectRole(process.argv[1]);
  if (!role) return undefined;

  const flagged = globalThis as GlobalWithFlag;
  if (flagged.__QAISDEBUGS_INSTALLED__) return role;
  flagged.__QAISDEBUGS_INSTALLED__ = true;

  const cwd = process.cwd();
  const repoRoot = findRepoRoot(cwd);
  const packageName = readPackageName(cwd);
  const app = appNameFrom(cwd, packageName);
  const repoDirs = repoRoot ? listTopLevelDirs(repoRoot) : undefined;
  const stackOptions = { cwd, repoRoot, packageName, repoDirs, mapFrame: mapGeneratedFrame };
  const collectorUrl = (process.env.QAISDEBUGS_URL ?? DEFAULT_COLLECTOR_URL).replace(/\/$/, '');
  const originalFetch = globalThis.fetch;
  const originalConsole: Pick<Console, LogLevel> = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };

  const bus = createBus({
    collectorUrl,
    // The agent's own traffic goes through the untouched fetch, so it is never recorded.
    fetchImpl: (input, init) => originalFetch(input, init),
    warn: (message) => originalConsole.warn(`[${brand}] ${message}`),
  });
  const context = createContextStore();

  installConsoleHook({ app, stackOptions, record: bus.enqueue, getContext: context.get, original: originalConsole });

  if (role === 'server') {
    const inspectorUrl = openInspector((message) => originalConsole.warn(`[${brand}] ${message}`));
    let devServerPort: number | undefined;
    const version = packageVersion();
    const announce = (): void =>
      bus.enqueue({
        kind: 'agent',
        id: newId(),
        app,
        pid: process.pid,
        cwd,
        repoRoot,
        packageName,
        inspectorUrl,
        devServerPort,
        version,
        at: wallClock(),
      });
    announce();
    // A heartbeat, so a collector started later (or restarted) learns about this process too.
    const heartbeat = setInterval(announce, 30_000);
    heartbeat.unref();
    const httpHook = installHttpHook({
      app,
      record: bus.enqueue,
      context,
      pageScriptTag: loadPageScript({ app, collectorUrl, cwd }, (message) => originalConsole.warn(`[${brand}] ${message}`)),
      onPort: (port) => {
        devServerPort = port;
        announce();
      },
    });
    installFetchHook({
      app,
      stackOptions,
      collectorUrl,
      record: bus.enqueue,
      getContext: context.get,
      isSelf: httpHook.isSelf,
      original: originalFetch,
    });
    // axios, got, node-fetch v2 and generated API clients go through http.request, not fetch.
    installHttpClientHook({
      app,
      stackOptions,
      collectorUrl,
      record: bus.enqueue,
      getContext: context.get,
      isSelf: httpHook.isSelf,
    });

    originalConsole.info(`[${brand}] ${app}: streaming server requests and logs to ${collectorUrl}`);


    void ensureCollector({
      collectorUrl,
      fetchImpl: (input, init) => originalFetch(input, init),
      log: (message) => originalConsole.info(`[${brand}] ${message}`),
      repoRoot,
    });
  }

  return role;
}
