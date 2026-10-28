#!/usr/bin/env node
/**
 * QaisDebugs collector.
 *
 * Receives batched events from the apps' dev servers, keeps them in a ring buffer, optionally
 * appends them to a JSONL file, streams them to the inspector over Server-Sent Events and serves
 * the built UI. Binds to the loopback address only and has no dependencies.
 *
 *   node server/index.mjs [--port 4983] [--buffer 5000] [--persist] [--repo <next-frontend path>]
 */
import { createWriteStream, existsSync, promises as fs, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pruneAgents } from './agents.mjs';
import { chromeVersion, launchChrome, listTargets, openInChrome } from './chrome.mjs';
import { dataDir as resolveDataDir } from './paths.mjs';

/** The command name the developer used (`qaisdebugs`, or a personal one such as `malaydebugs`). */
const BRAND = process.env.QAISDEBUGS_BRAND || 'qaisdebugs';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');
const uiDir = path.join(packageRoot, 'dist', 'ui');
const clientMap = path.join(packageRoot, 'dist', 'browser', 'client.js.map');
const dataDir = resolveDataDir();

const args = parseArgs(process.argv.slice(2));
const config = loadConfig(args.repo ?? process.env.QAISDEBUGS_REPO ?? process.cwd());
/** Source snippets are read from here and nowhere else. */
const repoRoot = path.resolve(args.repo ?? process.env.QAISDEBUGS_REPO ?? process.cwd());
const HOST = '127.0.0.1';
const PORT = Number(args.port ?? process.env.QAISDEBUGS_PORT ?? config.port ?? 4983);
const MAX_EVENTS = Number(args.buffer ?? 5000);
const PERSIST_FILE = args.persist ? path.join(dataDir, 'events.jsonl') : null;
const CHROME_PORT = Number(args['chrome-port'] ?? process.env.QAISDEBUGS_CHROME_PORT ?? config.chromePort ?? 9222);
const MAX_INGEST_BYTES = 32 * 1024 * 1024;
const MAX_SNIPPET_FILE_BYTES = 4 * 1024 * 1024;
/** How often the collector checks that the announced dev servers are still running. */
const AGENT_CHECK_MS = 3000;
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

/** @type {object[]} */
const buffer = [];
/** @type {Set<import('node:http').ServerResponse>} */
const clients = new Set();
/** The latest hello from each app's agent, keyed by app name. */
const agents = new Map();
/** @type {import('node:fs').WriteStream | null} */
let persistStream = null;
const startedAt = Date.now();

function log(message) {
  console.log(`[qaisdebugs ${new Date().toLocaleTimeString('en-GB', { hour12: false })}] ${message}`);
}

/** `qaisdebugs.config.json` in the given folder or any parent: { port, chromePort, sources: { ignore } }. */
function loadConfig(start) {
  let current = path.resolve(start);
  for (;;) {
    const file = path.join(current, 'qaisdebugs.config.json');
    if (existsSync(file)) {
      try {
        return JSON.parse(readFileSync(file, 'utf8'));
      } catch (error) {
        console.error(`[${BRAND}] ignoring ${file}: ${error.message}`);
        return {};
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return {};
    current = parent;
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function remember(events) {
  for (const event of events) buffer.push(event);
  if (buffer.length > MAX_EVENTS) buffer.splice(0, buffer.length - MAX_EVENTS);
}

function broadcast(name, payload) {
  const frame = `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) client.write(frame);
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && LOCAL_ORIGIN.test(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'origin');
  }
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('access-control-max-age', '600');
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error(`body larger than ${limit} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleIngest(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req, MAX_INGEST_BYTES));
  } catch (error) {
    sendJson(res, 400, { error: `invalid JSON body: ${error.message}` });
    return;
  }

  const events = Array.isArray(payload?.events) ? payload.events.filter(isEvent) : [];
  if (events.length === 0) {
    sendJson(res, 400, { error: 'expected { events: [...] }' });
    return;
  }

  // Announcements are kept apart from the event buffer: replaying an old one would bring back a
  // dev server that has since stopped.
  const announced = events.filter((event) => event.kind === 'agent');
  const recorded = events.filter((event) => event.kind !== 'agent');
  for (const event of announced) {
    agents.set(event.app, event);
    log(`${event.app}: agent pid ${event.pid}${event.inspectorUrl ? `, inspector ${event.inspectorUrl}` : ''}`);
  }
  if (announced.length) broadcast('agents', [...agents.values()]);

  if (recorded.length) {
    remember(recorded);
    if (persistStream) {
      for (const event of recorded) persistStream.write(`${JSON.stringify(event)}\n`);
    }
    broadcast('events', recorded);
  }
  sendJson(res, 202, { accepted: events.length });
}

/** Forgets the dev servers that have stopped, and tells the open inspectors. */
function checkAgents() {
  const removed = pruneAgents(agents);
  if (removed.length === 0) return;
  for (const app of removed) log(`${app}: dev server stopped, removed from the debug targets`);
  broadcast('agents', [...agents.values()]);
}

function isEvent(value) {
  return value && typeof value === 'object' && typeof value.id === 'string' && typeof value.kind === 'string';
}

function handleEvents(req, res) {
  pruneAgents(agents);
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ buffered: buffer.length, startedAt, persist: Boolean(PERSIST_FILE), agents: [...agents.values()] })}\n\n`);

  for (let i = 0; i < buffer.length; i += 500) {
    res.write(`event: events\ndata: ${JSON.stringify(buffer.slice(i, i + 500))}\n\n`);
  }

  clients.add(res);
  log(`inspector connected (${clients.size} open), replayed ${buffer.length} events`);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
    log(`inspector disconnected (${clients.size} open)`);
  });
}

async function handleSnippet(url, res) {
  const file = url.searchParams.get('file') ?? '';
  const line = Number(url.searchParams.get('line') ?? 0);
  const context = Math.min(Number(url.searchParams.get('context') ?? 12), 60);

  if (!file || !path.isAbsolute(file)) {
    sendJson(res, 400, { error: 'file must be an absolute path' });
    return;
  }

  let real;
  try {
    real = await fs.realpath(path.resolve(file));
  } catch {
    sendJson(res, 404, { error: 'file not found' });
    return;
  }

  const repoReal = await fs.realpath(repoRoot);
  if (!real.startsWith(repoReal + path.sep)) {
    sendJson(res, 403, { error: 'file is outside the repository' });
    return;
  }

  const stat = await fs.stat(real);
  if (!stat.isFile() || stat.size > MAX_SNIPPET_FILE_BYTES) {
    sendJson(res, 413, { error: 'not a readable source file' });
    return;
  }

  const lines = (await fs.readFile(real, 'utf8')).split(/\r?\n/);
  const start = Math.max(1, line - context);
  const end = Math.min(lines.length, line + context);

  sendJson(res, 200, {
    file: real,
    relative: path.relative(repoReal, real),
    line,
    start,
    end,
    total: lines.length,
    lines: lines.slice(start - 1, end),
  });
}

const SOURCE_SKIP = new Set(['node_modules', 'dist', 'build', 'out', '.next', '.next-dev', '.turbo', '.git', 'coverage', 'storybook-static', '.vercel', '.cache', 'tmp']);
const SOURCE_EXT = /\.(tsx?|jsx?|mjs|cjs|mts|cts|json|css|scss|sass|less|md|mdx|graphql|gql|env\.example)$/;
const SOURCE_MAX_FILES = 40_000;
const SOURCE_MAX_DEPTH = 14;
let sourceTreeCache = null;

/**
 * The repository's sources as a nested tree: everything under the repo root except dependencies,
 * build output and dot folders, plus whatever `sources.ignore` in qaisdebugs.config.json names.
 * Rebuilt at most every 10 s. Capped so a huge monorepo cannot stall the collector.
 */
async function sourceTree() {
  if (sourceTreeCache && Date.now() - sourceTreeCache.at < 10_000) return sourceTreeCache.tree;
  const repoReal = await fs.realpath(repoRoot);
  const ignore = new Set([...SOURCE_SKIP, ...(config.sources?.ignore ?? [])]);
  let count = 0;

  async function walk(dir, depth) {
    if (depth > SOURCE_MAX_DEPTH || count > SOURCE_MAX_FILES) return [];
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const dirs = [];
    const files = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.') || ignore.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const children = await walk(full, depth + 1);
        if (children.length) dirs.push({ name: entry.name, path: full, children });
      } else if (entry.isFile() && SOURCE_EXT.test(entry.name)) {
        files.push({ name: entry.name, path: full });
        count += 1;
      }
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));
    return [...dirs, ...files];
  }

  const tree = await walk(repoReal, 0);
  sourceTreeCache = { at: Date.now(), tree };
  return tree;
}

async function handleSourceFile(url, res) {
  const file = url.searchParams.get('file') ?? '';
  if (!file || !path.isAbsolute(file)) {
    sendJson(res, 400, { error: 'file must be an absolute path' });
    return;
  }
  let real;
  try {
    real = await fs.realpath(path.resolve(file));
  } catch {
    sendJson(res, 404, { error: 'file not found' });
    return;
  }
  const repoReal = await fs.realpath(repoRoot);
  if (!real.startsWith(repoReal + path.sep)) {
    sendJson(res, 403, { error: 'file is outside the repository' });
    return;
  }
  const stat = await fs.stat(real);
  if (!stat.isFile() || stat.size > MAX_SNIPPET_FILE_BYTES) {
    sendJson(res, 413, { error: 'not a readable source file' });
    return;
  }
  sendJson(res, 200, { file: real, relative: path.relative(repoReal, real), content: await fs.readFile(real, 'utf8'), mtime: stat.mtimeMs });
}

const MAX_MAP_BYTES = 64 * 1024 * 1024;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
/** Parsed source lists of map files, keyed by path, valid while the file's mtime is unchanged. */
const mapIndexCache = new Map();

/**
 * A bundler's external source map, for the debugger: `file=<absolute .map inside the repository>`
 * (Turbopack's server chunks under `.next/`) or `url=<http(s) map served by a local dev server>`
 * (its browser chunks, which the dev server serves without CORS). `index=1` answers with the
 * source names only, which is all the debugger needs until a breakpoint or a pause lands in the chunk.
 */
async function handleSourceMap(url, res) {
  const file = url.searchParams.get('file');
  const remote = url.searchParams.get('url');
  const indexOnly = url.searchParams.get('index') === '1';
  let text;
  let cacheKey;
  let version;

  if (file) {
    if (!path.isAbsolute(file)) {
      sendJson(res, 400, { error: 'file must be an absolute path' });
      return;
    }
    let real;
    try {
      real = await fs.realpath(path.resolve(file));
    } catch {
      sendJson(res, 404, { error: 'map not found' });
      return;
    }
    const repoReal = await fs.realpath(repoRoot);
    if (!real.startsWith(repoReal + path.sep)) {
      sendJson(res, 403, { error: 'map is outside the repository' });
      return;
    }
    const stat = await fs.stat(real);
    if (!stat.isFile() || stat.size > MAX_MAP_BYTES) {
      sendJson(res, 413, { error: 'not a readable source map' });
      return;
    }
    cacheKey = real;
    version = stat.mtimeMs;
    if (indexOnly && mapIndexCache.get(real)?.version === version) {
      sendJson(res, 200, { sources: mapIndexCache.get(real).sources });
      return;
    }
    text = await fs.readFile(real, 'utf8');
  } else if (remote) {
    let target;
    try {
      target = new URL(remote);
    } catch {
      sendJson(res, 400, { error: 'url is not valid' });
      return;
    }
    if (!/^https?:$/.test(target.protocol) || !LOCAL_HOSTS.has(target.hostname)) {
      sendJson(res, 403, { error: 'only maps served by a local dev server can be fetched' });
      return;
    }
    let response;
    try {
      response = await fetch(target, { signal: AbortSignal.timeout(10_000) });
    } catch (error) {
      sendJson(res, 502, { error: `dev server did not answer: ${error.message}` });
      return;
    }
    if (!response.ok) {
      sendJson(res, 502, { error: `dev server answered ${response.status} for the map` });
      return;
    }
    text = await response.text();
    if (text.length > MAX_MAP_BYTES) {
      sendJson(res, 413, { error: 'source map too large' });
      return;
    }
  } else {
    sendJson(res, 400, { error: 'file or url is required' });
    return;
  }

  if (!indexOnly) {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(text);
    return;
  }

  let map;
  try {
    map = JSON.parse(text);
  } catch {
    sendJson(res, 422, { error: 'not a source map' });
    return;
  }
  const sources = new Set();
  for (const name of map.sources ?? []) sources.add(name);
  for (const section of map.sections ?? []) for (const name of section.map?.sources ?? []) sources.add(name);
  const list = [...sources];
  if (cacheKey) mapIndexCache.set(cacheKey, { version, sources: list });
  sendJson(res, 200, { sources: list });
}

/** The origins the inspector UI may be served from; Chrome only accepts debugger sockets from these. */
function allowedOrigins() {
  return [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`, 'http://127.0.0.1:4984', 'http://localhost:4984'];
}

async function handleChromeTargets(res) {
  const version = await chromeVersion(CHROME_PORT);
  if (!version) {
    sendJson(res, 200, { port: CHROME_PORT, running: false, targets: [] });
    return;
  }
  try {
    sendJson(res, 200, { port: CHROME_PORT, running: true, browser: version.Browser, targets: await listTargets(CHROME_PORT) });
  } catch (error) {
    sendJson(res, 200, { port: CHROME_PORT, running: true, browser: version.Browser, targets: [], error: error.message });
  }
}

async function handleChromeLaunch(req, res) {
  let body = {};
  try {
    body = JSON.parse((await readBody(req, 64 * 1024)) || '{}');
  } catch {
    // No body: open a blank page.
  }
  const url = typeof body.url === 'string' && /^https?:\/\//.test(body.url) ? body.url : undefined;

  try {
    if (await chromeVersion(CHROME_PORT)) {
      const opened = url ? await openInChrome(CHROME_PORT, url) : undefined;
      log(`chrome already running on ${CHROME_PORT}${url ? `, opened ${url}` : ''}`);
      sendJson(res, 200, { started: false, port: CHROME_PORT, opened });
      return;
    }
    const result = await launchChrome({ port: CHROME_PORT, url, allowOrigins: allowedOrigins(), dataDir, log });
    sendJson(res, 200, { started: true, port: CHROME_PORT, pid: result.pid, browser: result.version?.Browser });
  } catch (error) {
    log(`chrome launch failed: ${error.message}`);
    sendJson(res, 500, { error: error.message });
  }
}

async function handleClear(req, res) {
  log(`cleared ${buffer.length} events on request from ${req.headers.referer ?? req.headers['user-agent'] ?? 'unknown'}`);
  buffer.length = 0;
  if (PERSIST_FILE) {
    persistStream?.end();
    await fs.writeFile(PERSIST_FILE, '');
    persistStream = createWriteStream(PERSIST_FILE, { flags: 'a' });
  }
  broadcast('clear', { at: Date.now() });
  sendJson(res, 200, { cleared: true });
}

async function serveStatic(url, res) {
  if (!existsSync(path.join(uiDir, 'index.html'))) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      `<!doctype html><title>${BRAND}</title><body style="font-family:system-ui;padding:2rem">` +
        `<h1>${BRAND} collector is running</h1>` +
        '<p>The inspector UI is not built yet. Run <code>qaisdebugs build</code> ' +
        '(or <code>qaisdebugs start</code>, which builds first) and reload.</p>' +
        `<p>Buffered events: ${buffer.length}</p></body>`
    );
    return;
  }

  const requested = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const resolved = path.resolve(uiDir, `.${requested}`);
  const inUi = resolved.startsWith(uiDir + path.sep) || resolved === path.join(uiDir, 'index.html');
  const target = inUi && existsSync(resolved) ? resolved : path.join(uiDir, 'index.html');

  const type = MIME[path.extname(target)] ?? 'application/octet-stream';
  const body = await fs.readFile(target);
  res.writeHead(200, {
    'content-type': type,
    'cache-control': target.endsWith('index.html') ? 'no-store' : 'public, max-age=3600',
  });
  res.end(body);
}

async function loadPersisted() {
  if (!PERSIST_FILE) return;
  await fs.mkdir(dataDir, { recursive: true });

  if (existsSync(PERSIST_FILE)) {
    const text = await fs.readFile(PERSIST_FILE, 'utf8');
    const events = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        if (isEvent(event) && event.kind !== 'agent') events.push(event);
      } catch {
        // A half-written last line after a crash: skip it.
      }
    }
    remember(events);
  }

  persistStream = createWriteStream(PERSIST_FILE, { flags: 'a' });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  cors(req, res);

  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
    } else if (req.method === 'POST' && url.pathname === '/ingest') {
      await handleIngest(req, res);
    } else if (req.method === 'GET' && url.pathname === '/events') {
      handleEvents(req, res);
    } else if (req.method === 'GET' && url.pathname === '/snippet') {
      await handleSnippet(url, res);
    } else if (req.method === 'POST' && url.pathname === '/clear') {
      await handleClear(req, res);
    } else if (req.method === 'GET' && url.pathname === '/sources/tree') {
      sendJson(res, 200, { repoRoot: await fs.realpath(repoRoot), tree: await sourceTree() });
    } else if (req.method === 'GET' && url.pathname === '/sources/file') {
      await handleSourceFile(url, res);
    } else if (req.method === 'GET' && url.pathname === '/sources/map') {
      await handleSourceMap(url, res);
    } else if (req.method === 'GET' && url.pathname === '/chrome/targets') {
      await handleChromeTargets(res);
    } else if (req.method === 'POST' && url.pathname === '/chrome/launch') {
      await handleChromeLaunch(req, res);
    } else if (req.method === 'GET' && url.pathname === '/client.js.map') {
      // The page script's source map, which tells Chrome DevTools to skip its frames.
      res.writeHead(200, { 'content-type': MIME['.map'], 'access-control-allow-origin': '*' });
      res.end(await fs.readFile(clientMap));
    } else if (req.method === 'GET' && url.pathname === '/agents') {
      pruneAgents(agents);
      sendJson(res, 200, [...agents.values()]);
    } else if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true, brand: BRAND, buffered: buffer.length, clients: clients.size, startedAt, persist: Boolean(PERSIST_FILE) });
    } else if (req.method === 'GET') {
      await serveStatic(url, res);
    } else {
      sendJson(res, 404, { error: 'not found' });
    }
  } catch (error) {
    console.error(`[${BRAND}]`, error);
    if (!res.headersSent) sendJson(res, 500, { error: error.message });
  }
});

await loadPersisted();

const pidFile = path.join(dataDir, `collector-${PORT}.pid`);

function removePidFile() {
  try {
    unlinkSync(pidFile);
  } catch {
    // Already gone.
  }
}

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    fetch(`http://${HOST}:${PORT}/health`, { signal: AbortSignal.timeout(1000) })
      .then(async (response) => {
        const health = await response.json();
        console.log(`A collector is already running at http://${HOST}:${PORT} (${health.buffered} events buffered). Open it in the browser; nothing else to do.`);
        console.log('It was most likely started automatically by `qaisdebugs dev`. `npx qaisdebugs stop` shuts it down.');
      })
      .catch(() => console.log(`${HOST}:${PORT} is in use by something that is not a collector. Pass --port to use another port.`))
      .finally(() => process.exit(0));
    return;
  }
  console.error(`[${BRAND}]`, error);
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    removePidFile();
    process.exit(0);
  });
}
process.on('exit', removePidFile);

setInterval(checkAgents, AGENT_CHECK_MS).unref();

server.listen(PORT, HOST, () => {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(pidFile, `${process.pid}\n`);
  console.log(`${BRAND}  http://${HOST}:${PORT}`);
  console.log(`  buffer ${MAX_EVENTS} events, persist ${PERSIST_FILE ? PERSIST_FILE : 'off'}, ui ${existsSync(uiDir) ? 'built' : 'not built'}`);
  console.log(`  source snippets from ${repoRoot}${existsSync(repoRoot) ? '' : ' (not found: pass --repo)'}`);
  console.log(`  chrome remote debugging expected on 127.0.0.1:${CHROME_PORT} (npx qaisdebugs chrome, or the Launch Chrome button)`);
  if (buffer.length) console.log(`  restored ${buffer.length} events`);
});
