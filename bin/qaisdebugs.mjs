#!/usr/bin/env node
/**
 * qaisdebugs — a network inspector, log viewer and server + client debugger for Next.js dev servers.
 *
 *   npx qaisdebugs                      start the collector and inspector UI (http://127.0.0.1:4983)
 *   npx qaisdebugs dev [-- next args]   run this project's dev server with the agent attached, and open it
 *                                       in the qaisdebugs Chrome (--no-chrome to skip)
 *   npx qaisdebugs exec -- <command>    run any command (a monorepo script, say) with the agent attached
 *   npx qaisdebugs attach               print the environment to attach the agent to a server you start yourself
 *   npx qaisdebugs chrome [url]         start a Chrome with remote debugging, for client-side breakpoints
 *   npx qaisdebugs mcp                  the MCP server, for Claude Code and other MCP clients
 *   npx qaisdebugs status | stop        inspect or stop the collector
 *
 * Run it from the Next.js app's folder. Options: --port <collector port> --chrome-port <port>
 * --repo <repository root, for source files> --persist (keep history across restarts).
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromeVersion, launchChrome, listTargets, openInChrome } from '../server/chrome.mjs';
import { PRIMARY, createAlias, globalBinDir, invokedName, listAliases, removeAlias } from '../server/alias.mjs';
import { dataDir } from '../server/paths.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentEntry = path.join(projectRoot, 'dist', 'agent', 'index.js');
const uiIndex = path.join(projectRoot, 'dist', 'ui', 'index.html');
const clientScript = path.join(projectRoot, 'dist', 'browser', 'client.js');
const mcpServer = path.join(projectRoot, 'dist', 'mcp', 'server.js');
const version = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version;

// The name this command was started as: `qaisdebugs`, or a personal name such as `malaydebugs`.
// Children (the dev server's agent, the collector) inherit it and use it in their messages.
const brand = process.env.QAISDEBUGS_BRAND || invokedName(process.argv[1]);
process.env.QAISDEBUGS_BRAND = brand;

const [command = 'start', ...rest] = process.argv.slice(2);
const { flags, positional, passthrough } = parse(rest);
const cwd = process.cwd();
const config = loadConfig(cwd);
const collectorPort = Number(flags.port ?? process.env.QAISDEBUGS_PORT ?? config.port ?? 4983);
const chromePort = Number(flags['chrome-port'] ?? process.env.QAISDEBUGS_CHROME_PORT ?? config.chromePort ?? 9222);
const collectorUrl = process.env.QAISDEBUGS_URL ?? `http://127.0.0.1:${collectorPort}`;
const pidFile = path.join(dataDir(), `collector-${collectorPort}.pid`);

function parse(argv) {
  const flags = {};
  const positional = [];
  let passthrough = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      passthrough = argv.slice(i + 1);
      break;
    }
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional, passthrough };
}

/** `qaisdebugs.config.json` in this folder or any parent. */
function loadConfig(start) {
  let current = path.resolve(start);
  for (;;) {
    const file = path.join(current, 'qaisdebugs.config.json');
    if (existsSync(file)) {
      try {
        return JSON.parse(readFileSync(file, 'utf8'));
      } catch (error) {
        console.error(`[${brand}] ignoring ${file}: ${error.message}`);
        return {};
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return {};
    current = parent;
  }
}

const ROOT_MARKERS = ['.git', 'pnpm-workspace.yaml', 'turbo.json', 'nx.json', 'lerna.json', 'rush.json'];

/** The repository root: the nearest .git, else the outermost workspace marker, else the app dir. */
function findRepoRoot(start) {
  let current = path.resolve(start);
  let found;
  for (;;) {
    const marked = ROOT_MARKERS.some((marker) => existsSync(path.join(current, marker)));
    if (marked || hasWorkspaces(path.join(current, 'package.json'))) found = current;
    if (found && existsSync(path.join(found, '.git'))) return found;
    const parent = path.dirname(current);
    if (parent === current) return found ?? path.resolve(start);
    current = parent;
  }
}

function hasWorkspaces(packageJson) {
  try {
    return Boolean(JSON.parse(readFileSync(packageJson, 'utf8')).workspaces);
  } catch {
    return false;
  }
}

/** The package manager this project uses, from its lockfile, so `dev` runs the project's own script. */
function packageManager(appDir) {
  const root = findRepoRoot(appDir);
  for (const dir of [appDir, root]) {
    if (existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
    if (existsSync(path.join(dir, 'yarn.lock'))) return 'yarn';
    if (existsSync(path.join(dir, 'bun.lockb')) || existsSync(path.join(dir, 'bun.lock'))) return 'bun';
    if (existsSync(path.join(dir, 'package-lock.json'))) return 'npm';
  }
  const agent = process.env.npm_config_user_agent ?? '';
  return agent.startsWith('pnpm') ? 'pnpm' : agent.startsWith('yarn') ? 'yarn' : agent.startsWith('bun') ? 'bun' : 'npm';
}

function readScripts(appDir) {
  try {
    return JSON.parse(readFileSync(path.join(appDir, 'package.json'), 'utf8')).scripts ?? {};
  } catch {
    return {};
  }
}

function newestMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs);
  }
  return newest;
}

/** A source checkout rebuilds when its sources are newer; the published package ships `dist`. */
function needsBuild() {
  const outputs = [agentEntry, uiIndex, clientScript, mcpServer];
  if (!outputs.every((file) => existsSync(file))) return true;
  if (!existsSync(path.join(projectRoot, 'agent')) || !existsSync(path.join(projectRoot, 'ui'))) return false;
  const built = Math.min(...outputs.map((file) => statSync(file).mtimeMs));
  const sources = ['agent', 'browser', 'mcp', 'ui'].map((dir) => path.join(projectRoot, dir)).filter((dir) => existsSync(dir));
  return Math.max(...sources.map(newestMtime)) > built;
}

function run(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...options });
    child.on('error', reject);
    child.on('exit', (code, signal) => (code === 0 || signal === 'SIGINT' ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited with ${signal ?? code}`))));
  });
}

async function build({ quiet = false } = {}) {
  // `mcp` speaks its protocol on stdout, so a build it triggers reports on stderr.
  (quiet ? console.error : console.log)(`[${brand}] building the agent and the UI…`);
  await run('pnpm', ['build'], { cwd: projectRoot, ...(quiet ? { stdio: ['ignore', process.stderr, 'inherit'] } : {}) });
}

function agentEnv(repo) {
  const existing = process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : '';
  return {
    NODE_OPTIONS: `${existing}--enable-source-maps --import ${JSON.stringify(agentEntry)}`,
    QAISDEBUGS_URL: collectorUrl,
    QAISDEBUGS_REPO: repo,
  };
}

async function collectorHealth() {
  try {
    return await (await fetch(`${collectorUrl}/health`, { signal: AbortSignal.timeout(800) })).json();
  } catch {
    return undefined;
  }
}

const chromeAllowOrigins = () => [`http://127.0.0.1:${collectorPort}`, `http://localhost:${collectorPort}`, 'http://127.0.0.1:4984', 'http://localhost:4984'];

/**
 * Once the dev server started by `dev` is listening, opens it in the qaisdebugs Chrome (starting
 * that Chrome if needed), so breakpoints set in the inspector pause client code too: Chrome lets a
 * debugger into a window only when the window was started for it. `--no-chrome` or
 * `QAISDEBUGS_OPEN_CHROME=0` turns this off.
 */
async function openAppInChrome(appDir) {
  if (flags['no-chrome'] || process.env.QAISDEBUGS_OPEN_CHROME === '0') return;

  let port;
  for (const deadline = Date.now() + 180_000; !port && Date.now() < deadline; ) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      const agents = await (await fetch(`${collectorUrl}/agents`, { signal: AbortSignal.timeout(1000) })).json();
      port = agents.find((agent) => path.resolve(agent.cwd) === appDir && agent.devServerPort)?.devServerPort;
    } catch {
      // The collector is still starting.
    }
  }
  if (!port) return;

  const url = `http://localhost:${port}`;
  try {
    if (await chromeVersion(chromePort)) {
      const open = await listTargets(chromePort);
      if (open.some((target) => target.url.startsWith(url))) return;
      await openInChrome(chromePort, url);
    } else {
      await launchChrome({ port: chromePort, url, allowOrigins: chromeAllowOrigins(), dataDir: dataDir() });
    }
    console.log(`[${brand}] opened ${url} in the qaisdebugs Chrome: breakpoints set at ${collectorUrl} pause there too (--no-chrome to skip)`);
  } catch (error) {
    console.warn(`[${brand}] could not open the qaisdebugs Chrome: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function fail(message) {
  console.error(`[${brand}] ${message}`);
  process.exit(1);
}

async function main() {
  switch (command) {
    case 'build':
      await build();
      return;

    case 'start': {
      const repo = flags.repo ? path.resolve(flags.repo) : findRepoRoot(cwd);
      if (flags.build || needsBuild()) await build();
      const args = [path.join(projectRoot, 'server', 'index.mjs'), '--repo', repo, '--port', String(collectorPort), '--chrome-port', String(chromePort)];
      if (flags.persist) args.push('--persist');
      await run(process.execPath, args, { cwd: projectRoot });
      return;
    }

    case 'dev': {
      if (!existsSync(path.join(cwd, 'package.json'))) fail(`no package.json in ${cwd}; run this from your Next.js app folder`);
      const repo = flags.repo ? path.resolve(flags.repo) : findRepoRoot(cwd);
      if (needsBuild()) await build();
      const pm = packageManager(cwd);
      const scripts = readScripts(cwd);
      const env = { ...process.env, ...agentEnv(repo) };
      let cmd;
      let args;
      if (scripts.dev) {
        cmd = pm;
        args = pm === 'npm' ? ['run', 'dev', ...(passthrough.length ? ['--', ...passthrough] : [])] : pm === 'yarn' ? ['dev', ...passthrough] : ['run', 'dev', ...passthrough];
      } else {
        cmd = pm === 'npm' ? 'npx' : pm;
        args = pm === 'npm' ? ['next', 'dev', ...passthrough] : pm === 'yarn' ? ['next', 'dev', ...passthrough] : ['exec', 'next', 'dev', ...passthrough];
      }
      console.log(`[${brand}] ${cmd} ${args.join(' ')}  (inspector: ${collectorUrl})`);
      void openAppInChrome(path.resolve(cwd));
      await run(cmd, args, { cwd, env });
      return;
    }

    case 'mcp': {
      // An MCP client (Claude Code, Cursor, …) starts this and talks to it over stdin/stdout.
      if (needsBuild()) await build({ quiet: true });
      await import(pathToFileURL(mcpServer).href);
      return;
    }

    case 'exec':
    case 'run': {
      const commandLine = passthrough.length ? passthrough : positional;
      if (!commandLine.length) fail('usage: qaisdebugs exec -- <command> [args]   e.g. qaisdebugs exec -- pnpm web:dev');
      const repo = flags.repo ? path.resolve(flags.repo) : findRepoRoot(cwd);
      if (needsBuild()) await build();
      const [cmd, ...args] = commandLine;
      console.log(`[${brand}] ${commandLine.join(' ')}  (inspector: ${collectorUrl})`);
      await run(cmd, args, { cwd, env: { ...process.env, ...agentEnv(repo) } });
      return;
    }

    case 'attach': {
      const repo = flags.repo ? path.resolve(flags.repo) : findRepoRoot(cwd);
      if (needsBuild()) await build();
      for (const [key, value] of Object.entries(agentEnv(repo))) console.log(`export ${key}=${JSON.stringify(value)}`);
      console.log('# then start your dev server in this shell, for example: next dev');
      return;
    }

    case 'chrome': {
      const url = positional[0] ?? 'http://localhost:3000';
      const allowOrigins = chromeAllowOrigins();
      if (await chromeVersion(chromePort)) {
        console.log(`[${brand}] a remote-debugging Chrome is already running on 127.0.0.1:${chromePort}; opening ${url} there`);
        await openInChrome(chromePort, url);
        return;
      }
      const result = await launchChrome({ port: chromePort, url, allowOrigins, dataDir: dataDir(), log: (message) => console.log(`[${brand}] ${message}`) });
      console.log(`[${brand}] ${result.version?.Browser ?? 'Chrome'} ready; its pages appear under Debug targets in the inspector`);
      return;
    }

    case 'status': {
      const health = await collectorHealth();
      if (!health) {
        console.log(`no collector at ${collectorUrl}`);
        return;
      }
      console.log(`collector running at ${collectorUrl}: ${health.buffered} events buffered, ${health.clients} inspector(s) connected, persist ${health.persist ? 'on' : 'off'}`);
      try {
        const agents = await (await fetch(`${collectorUrl}/agents`)).json();
        for (const agent of agents) console.log(`  ${agent.app}: pid ${agent.pid}, port ${agent.devServerPort ?? '?'}, inspector ${agent.inspectorUrl ? 'open' : 'closed'}`);
        if (!agents.length) console.log('  no dev server with the agent has reported yet');
      } catch {
        // Older collector.
      }
      return;
    }

    case 'stop': {
      if (!existsSync(pidFile)) {
        console.log(`[${brand}] no collector pid file; nothing started by ${brand} is running`);
        return;
      }
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      try {
        process.kill(pid, 'SIGTERM');
        console.log(`[${brand}] stopped the collector (pid ${pid})`);
      } catch (error) {
        console.log(`[${brand}] collector pid ${pid} was not running (${error.code ?? error.message})`);
      }
      try {
        unlinkSync(pidFile);
      } catch {
        // Already removed.
      }
      return;
    }

    case 'alias': {
      const name = positional[0];
      if (!name) {
        const names = listAliases();
        console.log(names.length ? names.map((entry) => `${entry.name}  ->  ${PRIMARY}  (${entry.path})`).join('\n') : `no personal names yet; create one with: ${PRIMARY} alias <name>debugs`);
        return;
      }
      const file = createAlias(name.toLowerCase(), globalBinDir(process.argv[1], projectRoot));
      console.log(`[${PRIMARY}] created the command "${name.toLowerCase()}" at ${file}; try: ${name.toLowerCase()} dev`);
      return;
    }

    case 'unalias': {
      const name = positional[0];
      if (!name) fail(`usage: ${PRIMARY} unalias <name>`);
      const removed = removeAlias(name.toLowerCase(), globalBinDir(process.argv[1], projectRoot));
      console.log(removed ? `[${PRIMARY}] removed the command "${name.toLowerCase()}"` : `[${PRIMARY}] "${name.toLowerCase()}" is not a qaisdebugs name; nothing removed`);
      return;
    }

    case '--version':
    case '-v':
    case 'version':
      console.log(version);
      return;

    default:
      console.log(`${brand} ${version} — network inspector, logs and server + client debugger for Next.js dev servers

  ${brand}                       start the collector and inspector UI (${collectorUrl})
  ${brand} dev [-- next args]    run this project's dev server with the agent attached and open it in the
                              qaisdebugs Chrome, where client breakpoints pause (--no-chrome to skip)
  ${brand} exec -- <command>     run any command (a monorepo script, say) with the agent attached
  ${brand} attach                print the environment to attach the agent to a server you start yourself
  ${brand} chrome [url]          start a Chrome with remote debugging, for client-side breakpoints
  ${brand} mcp                   the MCP server for Claude Code and other MCP clients:
                              claude mcp add qaisdebugs -- qaisdebugs mcp
  ${brand} status | stop         inspect or stop the collector
  ${PRIMARY} alias [name]        add a personal command name (e.g. malaydebugs), or list them
  ${PRIMARY} unalias <name>      remove a personal command name

  options: --port <collector port> --chrome-port <port> --repo <repository root> --persist
  config:  qaisdebugs.config.json { "port", "chromePort", "sources": { "ignore": [] } }
  data:    ${dataDir()}  (QAISDEBUGS_HOME to move it)
  install with your own name: npm install -g ./qaisdebugs-<version>.tgz --malaydebugs
`);
  }
}

main().catch((error) => fail(error.message));
