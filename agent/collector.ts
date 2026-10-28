import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * QaisDebugs — starts the collector on demand.
 *
 * `npx qaisdebugs dev` should be the only command a developer needs. When the agent comes up
 * and finds no collector on its loopback address, it starts one detached from the dev server, so
 * the inspector is there when the first event arrives. `qaisdebugs stop` shuts it down again.
 */

export interface EnsureCollectorOptions {
  collectorUrl: string;
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  log: (message: string) => void;
  /** The checkout the collector reads source snippets from. */
  repoRoot?: string;
  /** Overrides the project location, for tests. */
  projectRoot?: string;
}

export type CollectorState = 'running' | 'started' | 'skipped' | 'failed';

const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

/** The standalone project's root, derived from this file's location (`dist/agent/collector.js`). */
export function projectRootFromHere(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

const ROOT_MARKERS = ['.git', 'pnpm-workspace.yaml', 'turbo.json', 'nx.json', 'lerna.json', 'rush.json'];

/**
 * Walks up from `start` to the repository or workspace root: the nearest folder with a `.git`, a
 * workspace file (pnpm, turbo, nx, lerna, rush) or a `package.json` that declares `workspaces`.
 * Returns undefined when nothing marks a root, in which case the app dir is the root.
 */
export function findRepoRoot(start: string): string | undefined {
  let current = path.resolve(start);
  let found: string | undefined;

  for (;;) {
    if (ROOT_MARKERS.some((marker) => existsSync(path.join(current, marker)))) found = current;
    else if (hasWorkspaces(path.join(current, 'package.json'))) found = current;

    // The outermost marker wins, so a monorepo's root beats an app's own .git-less package.json,
    // but stop at the first .git: nested repositories are separate projects.
    if (found && existsSync(path.join(found, '.git'))) return found;

    const parent = path.dirname(current);
    if (parent === current) return found;
    current = parent;
  }
}

function hasWorkspaces(packageJson: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(packageJson, 'utf8')) as { workspaces?: unknown };

    return Boolean(parsed.workspaces);
  } catch {
    return false;
  }
}

export async function ensureCollector(options: EnsureCollectorOptions): Promise<CollectorState> {
  if (process.env.QAISDEBUGS_AUTOSTART === '0' || !LOOPBACK.test(options.collectorUrl)) {
    return 'skipped';
  }

  if (await isHealthy(options)) {
    return 'running';
  }

  const projectRoot = options.projectRoot ?? projectRootFromHere();
  const serverEntry = path.join(projectRoot, 'server', 'index.mjs');
  if (!existsSync(serverEntry)) {
    options.log(`collector not found at ${serverEntry}; start it yourself with npx qaisdebugs`);

    return 'failed';
  }

  const dataDir = process.env.QAISDEBUGS_HOME ? path.resolve(process.env.QAISDEBUGS_HOME) : path.join(os.homedir(), '.qaisdebugs');
  mkdirSync(dataDir, { recursive: true });
  const port = new URL(options.collectorUrl).port || '80';
  const logFile = path.join(dataDir, `collector-${port}.log`);
  const logFd = openSync(logFile, 'a');
  const args = [serverEntry, '--port', port];
  if (options.repoRoot) args.push('--repo', options.repoRoot);

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    cwd: projectRoot,
    env: { ...process.env, NODE_OPTIONS: withoutAgentPreload(process.env.NODE_OPTIONS) },
  });
  child.unref();

  for (let attempt = 0; attempt < 15; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (await isHealthy(options)) {
      options.log(`started the collector at ${options.collectorUrl} (log: ${logFile}); stop it with qaisdebugs stop`);
      if (!existsSync(path.join(projectRoot, 'dist', 'ui', 'index.html'))) {
        options.log(`the inspector UI is not built; run: node ${path.join(projectRoot, 'bin', 'qaisdebugs.mjs')} build`);
      }

      return 'started';
    }
  }

  options.log(`could not start the collector; see ${logFile}`);

  return 'failed';
}

async function isHealthy(options: EnsureCollectorOptions): Promise<boolean> {
  try {
    const response = await options.fetchImpl(`${options.collectorUrl}/health`, { signal: AbortSignal.timeout(800) });

    return response.ok;
  } catch {
    return false;
  }
}

/** The dev server's NODE_OPTIONS minus our own `--import`, so the collector does not load the agent. */
export function withoutAgentPreload(nodeOptions: string | undefined): string {
  if (!nodeOptions) return '';

  return nodeOptions
    .replace(/--import(?:=|\s+)(?:"[^"]*agent[\\/]index\.js"|\S*agent[\\/]index\.js)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
