/**
 * QaisDebugs — a Chrome with remote debugging, for client-side breakpoints.
 *
 * Chrome only exposes a debugger when it is started with `--remote-debugging-port`, and since
 * Chrome 111 a web page may only open that WebSocket if its origin is listed in
 * `--remote-allow-origins`. This module starts such a Chrome on its own profile (so your everyday
 * browser is untouched), lists its pages and opens URLs in it. Used by the collector and by
 * `qaisdebugs chrome`.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';

const CANDIDATES = {
  darwin: [
    process.env.QAISDEBUGS_CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ],
  win32: [
    process.env.QAISDEBUGS_CHROME,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    `${process.env.LOCALAPPDATA ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  linux: [process.env.QAISDEBUGS_CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
};

export function findChrome() {
  for (const candidate of CANDIDATES[process.platform] ?? CANDIDATES.linux) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return undefined;
}

async function fetchJson(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(1500) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

/** The browser's version info when a remote-debugging Chrome listens on `port`, else undefined. */
export async function chromeVersion(port) {
  try {
    return await fetchJson(`http://127.0.0.1:${port}/json/version`);
  } catch {
    return undefined;
  }
}

/** The page targets of the running Chrome, newest first, without Chrome's own pages. */
export async function listTargets(port) {
  const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
  return targets
    .filter((target) => target.type === 'page' && /^https?:/.test(target.url))
    .map((target) => ({ id: target.id, title: unescapeHtml(target.title), url: target.url, wsUrl: target.webSocketDebuggerUrl }));
}

/** Chrome HTML-escapes titles in `/json/list`. */
function unescapeHtml(text) {
  return String(text ?? '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Opens `url` in the running Chrome. Chrome wants PUT for this endpoint. */
export async function openInChrome(port, url) {
  return fetchJson(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
}

/**
 * Starts Chrome detached, on its own profile under `dataDir`, with remote debugging on `port`.
 * Resolves once `/json/version` answers, or rejects after ~10 s.
 */
export async function launchChrome({ port, url, allowOrigins, dataDir, log }) {
  const binary = findChrome();
  if (!binary) {
    throw new Error('no Chrome found. Install Google Chrome or set QAISDEBUGS_CHROME to the browser binary.');
  }

  mkdirSync(dataDir, { recursive: true });
  const profile = path.join(dataDir, 'chrome-profile');
  const logFd = openSync(path.join(dataDir, 'chrome.log'), 'a');
  const args = [
    `--remote-debugging-port=${port}`,
    `--remote-allow-origins=${allowOrigins.join(',')}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=TranslateUI',
    url ?? 'about:blank',
  ];

  const child = spawn(binary, args, { detached: true, stdio: ['ignore', logFd, logFd] });
  child.unref();
  log?.(`started ${path.basename(binary)} (pid ${child.pid}) with remote debugging on 127.0.0.1:${port}, profile ${profile}`);

  for (let attempt = 0; attempt < 50; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const version = await chromeVersion(port);
    if (version) return { pid: child.pid, binary, version };
  }

  throw new Error(`Chrome started but 127.0.0.1:${port} never answered; see ${path.join(dataDir, 'chrome.log')}`);
}
