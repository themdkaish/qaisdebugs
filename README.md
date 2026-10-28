<p align="center">
  <img src="https://cdn.jsdelivr.net/npm/qaisdebugs@0.2.0/assets/banner.svg" alt="qaisdebugs: X-ray for Next.js dev servers" width="100%">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/qaisdebugs"><img src="https://img.shields.io/npm/v/qaisdebugs?color=22d3ee&label=npm" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/qaisdebugs"><img src="https://img.shields.io/npm/dm/qaisdebugs?color=a78bfa" alt="downloads per month"></a>
  <img src="https://img.shields.io/node/v/qaisdebugs?color=34d399" alt="node version">
  <img src="https://img.shields.io/badge/Next.js-13.4%20to%2016-111827?logo=nextdotjs" alt="Next.js 13.4 to 16">
  <img src="https://img.shields.io/badge/webpack%20%7C%20Turbopack-supported-0ea5e9" alt="webpack and Turbopack supported">
  <img src="https://img.shields.io/npm/l/qaisdebugs?color=64748b" alt="MIT license">
</p>

<p align="center">
  <b>See every request your Next.js server makes, read server and browser logs in one place, and set breakpoints in server <i>and</i> client components, from one inspector.</b><br>
  No code changes, no SDK, no <code>instrumentation.ts</code>. Just run your dev server through it.
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#what-you-get">What you get</a> ·
  <a href="#commands">Commands</a> ·
  <a href="#debug-with-claude-mcp">Debug with Claude (MCP)</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#faq">FAQ</a> ·
  <a href="https://themdkaish.github.io/qaisdebugs/">Website</a> ·
  <a href="https://github.com/themdkaish/qaisdebugs">GitHub</a>
</p>

---

## Why qaisdebugs

The browser's Network tab only sees what the **browser** sends. In a Next.js app, most of the
interesting traffic never reaches it: Server Components calling your backend, Route Handlers
calling third-party APIs, Server Actions, and axios clients running on the server. That
traffic only shows up as scattered `console.log` lines in a terminal.

qaisdebugs puts it all on one screen, nested under the page request that caused it, with the
exact file and line that made each call. It also lets you pause the server, or the page, on
any line.

<p align="center">
  <img src="https://cdn.jsdelivr.net/npm/qaisdebugs@0.2.0/assets/network.png" alt="The Network view: every server-side call, with a trace of one request and its nested hops" width="100%">
  <br><sub><b>Network.</b> Browser, server and external calls in one list. The Trace tab shows <code>/api/chain</code> calling the server twice and an external API once, as one tree.</sub>
</p>

## Quick start

**1. Install it** (Node 20.6 or newer):

```bash
npm install -g qaisdebugs
```

**2. Start your app through it**, from your Next.js app's folder:

```bash
qaisdebugs dev
```

It runs your own `dev` script with npm, pnpm, yarn or bun, whichever lockfile you have.
Anything after `--` goes to Next, for example `qaisdebugs dev -- -p 3005`.

**3. Open the inspector** at **http://127.0.0.1:4983**, and load a page of your app.

To try it once without installing, `npx qaisdebugs dev` works too.

## What you get

| Feature | What it does |
| --- | --- |
| 🌐 **Server network calls** | Every `fetch`, **axios**, got or node-fetch call made on the server, with headers, bodies, timing and status, and the file and line that made it. |
| 🧭 **Browser network calls** | Every `fetch` and XMLHttpRequest the page makes, in any browser, including calls to other domains, with request and response bodies and the line in your component that made it. A call to your own server is one row with both halves: what the browser sent and what the server did. |
| 🧵 **Traces** | Each page load or API call is a tree: the request from the browser, the calls the server made to itself, and the calls to external APIs. |
| 📜 **Unified logs** | Server and browser `console.*` output and uncaught errors in one list, with file, line and the request each line belongs to. |
| 🐞 **Server breakpoints** | Pause Server Components, Route Handlers and Server Actions on any line. Step through, inspect scopes, hover variables, evaluate expressions. |
| 🖥️ **Client breakpoints** | The same for `'use client'` components, in the Chrome window `qaisdebugs dev` opens. It connects on its own, so a breakpoint set once pauses there. |
| 🔒 **Redaction built in** | Passwords, tokens, API keys, auth headers and cookies are masked before anything leaves your dev server, in requests, responses and logs. |
| ⚡ **Zero setup** | Attaches from outside with a Node preload. Your project's code, config and dependencies stay untouched. |

<p align="center">
  <img src="https://cdn.jsdelivr.net/npm/qaisdebugs@0.2.0/assets/sources.png" alt="The Sources view: the server paused on a breakpoint inside an axios call, with the call stack and live scope values" width="100%">
  <br><sub><b>Sources.</b> The server paused inside an axios call. Call stack, scopes and a console that evaluates in the paused frame.</sub>
</p>

<p align="center">
  <img src="https://cdn.jsdelivr.net/npm/qaisdebugs@0.2.0/assets/logs.png" alt="The Logs view: server log lines at every level, each with file, line and trace" width="100%">
  <br><sub><b>Logs.</b> Every level, each line with its file and trace. Note <code>cardToken</code>, redacted automatically.</sub>
</p>

### Works with

- **Next.js 13.4 to 16**, App Router. Pages Router uses the same hooks but is untested.
- **webpack and Turbopack.** Turbopack is the default since Next 15, and both work.
- **Any HTTP client on the server:** `fetch`, axios, got, node-fetch v2, and generated API clients.
- **Monorepos** with pnpm, yarn or npm workspaces, Turborepo or Nx.
- **macOS**, where it is tested. Linux and Windows should work, but are untested so far.
- **Google Chrome**, needed only for client-side breakpoints.

## Commands

| Command | What it does |
| --- | --- |
| `qaisdebugs dev [-- next args]` | Runs this folder's `dev` script, or `next dev` if there is none, with qaisdebugs attached, and opens the app in the qaisdebugs Chrome. `--no-chrome` skips the Chrome window. |
| `qaisdebugs exec -- <command>` | Runs any command with qaisdebugs attached, for example `qaisdebugs exec -- pnpm web:dev` in a monorepo. |
| `qaisdebugs` | Starts only the inspector, in the foreground. |
| `qaisdebugs chrome [url]` | Opens a separate Chrome with remote debugging, for client-side breakpoints. |
| `qaisdebugs mcp` | The MCP server, so Claude Code (or another MCP client) can read the requests and logs and use the debugger. See below. |
| `qaisdebugs status` | Shows whether the inspector is running and which dev servers report to it. |
| `qaisdebugs stop` | Stops the inspector. |
| `qaisdebugs attach` | Prints the environment variables to attach it to a server you start yourself. |
| `qaisdebugs alias <name>` / `unalias <name>` | Adds or removes a personal command name. |

Options: `--port <n>` moves the inspector off 4983, `--chrome-port <n>` moves the debug Chrome
off 9222, `--repo <path>` sets the repository root, and `--persist` keeps history across
restarts.

## Debug with Claude (MCP)

qaisdebugs includes an [MCP](https://modelcontextprotocol.io) server, so Claude Code can see
everything the inspector shows and use the debugger itself. Add it once:

```bash
claude mcp add qaisdebugs -- qaisdebugs mcp
```

Other MCP clients (Cursor, Windsurf, …) take the same command, `qaisdebugs mcp`, in their MCP
settings. Then run your app with `qaisdebugs dev` as usual and ask, for example: *"The vehicles
list on the borrow page is empty, find out why."* Claude can then:

| Tool | What it does |
| --- | --- |
| `status` | Which dev servers and qaisdebugs Chrome tabs are running, and what is recorded. |
| `list_requests`, `get_request`, `get_trace` | Find requests by app, origin, method, status or URL; open one with headers, bodies, timing and the file:line that made it; see a whole page load as a tree. |
| `list_logs`, `list_problems` | Server and browser console output; everything that went wrong (failed requests, errors, warnings). |
| `wait_for`, `clear` | Start from a clean slate and wait while you reproduce the problem. |
| `find_files`, `read_file` | The app's source files. |
| `open_page` | Opens a page in the qaisdebugs Chrome. |
| `set_breakpoint`, `wait_for_pause`, `get_pause`, `evaluate`, `step`, `pause_on_exceptions`, `list_breakpoints`, `remove_breakpoint` | Pause server code, or client code in the qaisdebugs Chrome, read the variables, evaluate expressions, step and resume. |

The MCP server reads from the inspector at 127.0.0.1:4983 (`QAISDEBUGS_PORT` or `QAISDEBUGS_URL`
to change that) and attaches the debugger only when a breakpoint is set. It sees what the
inspector sees: passwords, tokens and cookies are already masked. `evaluate` runs code inside
your app, like the inspector's console. The debugger tools need Node 22 or later.

## Your own command name

`qaisdebugs` is always installed. Anyone can add a name of their own next to it, which runs the
same tool and shows that name in the terminal and in the inspector:

```bash
QAISDEBUGS_NAME=malaydebugs npm install -g qaisdebugs
```

```bash
malaydebugs dev
```

Other ways to get the same result:

- **A flag at install time:** `npm install -g qaisdebugs --malaydebugs`. Any flag ending in "debugs" works, and `--qaisdebugs-name=<name>` takes any other name. npm 11 warns that it will stop passing unknown flags on in its next major version, so `QAISDEBUGS_NAME` is the safer form.
- **After installing:** `qaisdebugs alias malaydebugs` adds a name, `qaisdebugs alias` lists them, and `qaisdebugs unalias malaydebugs` removes one. Use this too if your npm setup skips install scripts.

A name is 2 to 40 lowercase letters, digits or dashes, and it never replaces a command that
isn't a qaisdebugs name. All names share one installation and one inspector, and they keep
working through updates.

## Using the debugger

<details>
<summary><b>Server-side breakpoints</b></summary>

1. Open **Sources**, and under **Debug targets** press **Connect** next to your app's server.
2. Find a file in the tree or the filter, and click a line number to set a breakpoint. A red
   marker means it's placed. A grey one means Next hasn't compiled that module yet; it turns
   red once you load a page that uses it.
3. Load the page or call the route. The server pauses on the line, and the panel shows the call
   stack, the scopes with live values, and a console that evaluates in the paused frame.
4. Hover any variable in the code to see its value. Hovering never runs a function or a getter
   with side effects.

**Keys:** F8 resumes, F10 steps over, F11 steps into, and Shift+F11 steps out. "On exceptions"
pauses on uncaught errors, or on all of them.

While the server is paused, the whole dev server is frozen, including other tabs and hot
reload. Resume when you're done.
</details>

<details>
<summary><b>Client-side breakpoints</b></summary>

Chrome only lets a debugger into a window that was started for it, so qaisdebugs uses a Chrome
of its own, on a separate profile. Your everyday Chrome is untouched. `qaisdebugs dev` opens your
app there as soon as the dev server is up (`--no-chrome` to skip); **Launch debug Chrome** in
Sources or `qaisdebugs chrome http://localhost:3000` opens it by hand.

Log in to your app once in that window; the profile remembers you. Its tabs connect on their
own, so a breakpoint you set in the inspector pauses there with nothing else to click. A
breakpoint set before the page loads is placed as soon as the code arrives, so it hits on the
first render after a reload. While a page is paused, only that page is frozen.

Network calls, console output and errors are recorded in every browser, not only this one: the
dev server adds a small script to each page it sends (development only).
</details>

<details>
<summary><b>Server and client together</b></summary>

The server and the Chrome tabs connect on their own (**Connect all** does it by hand). Breakpoints are shared,
so a line in a `'use client'` component pauses the server while it renders that component,
and then, after you resume, the page while it hydrates. The breakpoint list shows where each
breakpoint resolved: `server`, `page` or `server+page`.
</details>

## Configuration

<details>
<summary><b>Config file</b></summary>

A `qaisdebugs.config.json` in the app folder or any parent folder:

```json
{
  "port": 4983,
  "chromePort": 9222,
  "sources": { "ignore": ["fixtures", "generated"] }
}
```
</details>

<details>
<summary><b>Environment variables</b></summary>

| Variable | Effect |
| --- | --- |
| `QAISDEBUGS=0` | Turns qaisdebugs off for one run, even when attached. |
| `QAISDEBUGS_AUTOSTART=0` | Never starts the inspector automatically. |
| `QAISDEBUGS_INSPECT=0` | Disables server-side debugging. |
| `QAISDEBUGS_CLIENT=0` | Leaves pages alone: no browser network calls or browser logs. |
| `QAISDEBUGS_OPEN_CHROME=0` | `qaisdebugs dev` does not open the qaisdebugs Chrome (same as `--no-chrome`). |
| `QAISDEBUGS_URL` | Where the inspector is (default `http://127.0.0.1:4983`). |
| `QAISDEBUGS_PORT` | The inspector's port. |
| `QAISDEBUGS_CHROME_PORT` | The debug Chrome's port (default 9222). |
| `QAISDEBUGS_CHROME` | Path to the Chrome program, if it's not in the usual place. |
| `QAISDEBUGS_REPO` | The repository root, if detection picks the wrong folder. |
| `QAISDEBUGS_HOME` | Where logs, settings and the debug Chrome profile live (default `~/.qaisdebugs`). |
| `QAISDEBUGS_NAME` | A personal command name to create while installing. |
</details>

<details>
<summary><b>Monorepos</b></summary>

The repository root is the nearest `.git`, or else the outermost folder with
`pnpm-workspace.yaml`, `turbo.json`, `nx.json`, `lerna.json`, `rush.json` or a `workspaces`
field. Sources shows the whole repository, so shared packages are there too. Several apps can
report to one inspector, and the **App** filter separates them. If your app starts from a root
script, use `exec`:

```bash
qaisdebugs exec -- pnpm web:dev
```
</details>

<details>
<summary><b>Attaching to a server you start yourself</b></summary>

`qaisdebugs attach` prints three `export` lines. Run them in the shell where you start your dev
server, however you start it. In a project that lists qaisdebugs as a dev dependency, you can
also write the preload into a script:

```json
{ "dev:debug": "NODE_OPTIONS='--enable-source-maps --import qaisdebugs/agent' next dev" }
```
</details>

## Privacy

Everything stays on your machine. The inspector listens on `127.0.0.1` only, keeps events in
memory, and reads source files only from inside your repository.

Before an event leaves your dev server, qaisdebugs masks:

- `authorization`, `proxy-authorization`, `x-api-key` and `set-cookie` headers
- cookie values whose names look like tokens
- fields named like `token`, `password`, `secret`, `otp` or `credential`, in request bodies,
  response bodies and logged objects, on the server and in the browser

## FAQ

<details>
<summary><b>Nothing shows up in the inspector</b></summary>

Check the terminal for a line like `[qaisdebugs] my-app: streaming server requests and logs`.
If it's missing, your app doesn't start through `next dev`, for example because it uses a custom
`server.js`. Run `qaisdebugs attach` and start the server with those variables set.
</details>

<details>
<summary><b>"Port 4983 is already in use"</b></summary>

Another inspector is already running. `qaisdebugs status` shows it, and `qaisdebugs stop` stops
it. You can also use another port with `qaisdebugs dev --port 4990`.
</details>

<details>
<summary><b>A breakpoint stays grey</b></summary>

Next hasn't compiled that file yet. Load a page that uses it, and the marker turns red.
</details>

<details>
<summary><b>Does it slow my app down, or affect production?</b></summary>

It only runs inside `next dev` and only when started through qaisdebugs. Production builds and
`next start` are never touched. Recording happens off the request path, so responses aren't
delayed.
</details>

<details>
<summary><b>How does it work?</b></summary>

qaisdebugs loads a small agent into the Next.js dev server with Node's `--import` preload. The
agent:

- records `fetch` calls, and calls through Node's `http` and `https` modules
- follows each incoming request with `AsyncLocalStorage`, so every call and log line knows
  which page request it belongs to
- mirrors `console` output
- opens Node's inspector on a private local port, for breakpoints

The inspector UI talks to Node and to Chrome over the Chrome DevTools Protocol, and maps
positions back to your TypeScript with source maps, for both webpack and Turbopack.
</details>

## License

MIT © Mahammad Kaish
