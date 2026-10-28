/**
 * The content of the qaisdebugs website's guides. Each guide answers one question people search
 * for, covers the built-in tools first, and then shows what qaisdebugs adds.
 * Build with `node site/build-guides.mjs`.
 */

const escapeHtml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A code block. The text is escaped, so code can be pasted as it is. */
const code = (text) => `<pre class="code glass"><code>${escapeHtml(text.trim())}</code></pre>`;

const note = (html) => `<div class="note glass"><p>${html}</p></div>`;

export const GUIDES = [
  {
    slug: 'how-to-debug-nextjs',
    title: 'How to debug a Next.js app: server, client and network | qaisdebugs',
    headline: 'How to debug a Next.js application',
    summary: 'The full walkthrough: logs, network, server and client breakpoints.',
    description:
      'A step-by-step guide to debugging a Next.js app: server and client breakpoints, server-side network requests, logs, Route Handlers and Server Actions.',
    minutes: 8,
    lead: 'Debugging Next.js is harder than debugging a plain React app because your code runs in two places: the Node.js server and the browser. This guide shows where each kind of bug shows up, and how to see logs, network calls and variables on both sides.',
    related: ['nextjs-debugging-tools', 'nextjs-server-side-network-requests', 'nextjs-breakpoints-vscode-chrome'],
    body: `
    <h2 id="where">First, work out where the code runs</h2>
    <p>Almost every confusing Next.js bug comes down to looking in the wrong place. With the App Router:</p>
    <ul>
      <li><strong>On the server:</strong> Server Components (the default in <code>app/</code>), Route Handlers (<code>route.ts</code>), Server Actions (<code>'use server'</code>), <code>generateMetadata</code>, and middleware (<code>proxy.ts</code> since Next.js 16).</li>
      <li><strong>In the browser:</strong> components marked <code>'use client'</code> after they hydrate, their event handlers and their effects.</li>
      <li><strong>Both:</strong> Client Components also render once on the server to produce the first HTML. That is why a client component can crash on the server with <code>window is not defined</code>.</li>
    </ul>
    <div class="table-scroll glass"><table>
      <thead><tr><th>You see</th><th>Look here first</th></tr></thead>
      <tbody>
        <tr><td>Wrong or missing data on the page</td><td>Server network calls and server logs</td></tr>
        <tr><td>A button or form does nothing</td><td>Browser console and Network tab, then the Server Action or Route Handler</td></tr>
        <tr><td>Hydration error</td><td>The error overlay's diff, then the component it names</td></tr>
        <tr><td>500 error or blank page</td><td>The terminal running <code>next dev</code></td></tr>
      </tbody>
    </table></div>

    <h2 id="logs">Step 1: read the logs in the right place</h2>
    <p><code>console.log</code> in server code prints to the <strong>terminal</strong> running <code>next dev</code>, not the browser. Logs from client code print to the <strong>browser console</strong>. Since Next.js 15, logs from Server Components are also replayed in the browser console with a <em>Server</em> label, but Route Handlers and Server Actions still only log to the terminal.</p>
    <p>Keeping two windows side by side works for small apps. Once several requests run at once, it gets hard to tell which log line belongs to which page load. See <a href="../nextjs-logs/">Next.js logs</a> for the details.</p>

    <h2 id="network">Step 2: check the network, on both sides</h2>
    <p>The browser's Network tab shows what the <em>page</em> requested. It never shows the calls your server makes to your backend or third-party APIs while rendering. For those, Next.js can log <code>fetch</code> calls in the terminal:</p>
    ${code(`
// next.config.ts
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  logging: { fetches: { fullUrl: true } },
};

export default nextConfig;`)}
    <p>That prints each <code>fetch</code> with its URL, status, cache result and duration. It does not show headers or bodies, and it misses axios, got and any other client. <a href="../nextjs-server-side-network-requests/">Seeing server-side requests</a> covers the alternatives.</p>

    <h2 id="server-breakpoints">Step 3: pause server code with breakpoints</h2>
    <p>Start the dev server with the Node.js inspector turned on:</p>
    ${code(`NODE_OPTIONS='--inspect' npx next dev`)}
    <p>Recent Next.js versions also accept <code>next dev --inspect</code>. Then open <code>chrome://inspect</code> in Chrome, click <strong>Open dedicated DevTools for Node</strong> (or <em>inspect</em> under Remote Target), and find your file with <kbd>Cmd/Ctrl + P</kbd>. Click a line number to set a breakpoint, then load the page. A <code>debugger;</code> statement in your code works too.</p>
    ${note('A breakpoint in a file Next.js has not compiled yet will not bind. Load a page that uses the file once, then set it again.')}
    <p>VS Code users can do the same with a <code>launch.json</code>: see <a href="../nextjs-breakpoints-vscode-chrome/">breakpoints in VS Code and Chrome</a>.</p>

    <h2 id="client-breakpoints">Step 4: pause client code</h2>
    <p>Open the browser's DevTools, go to <strong>Sources</strong>, press <kbd>Cmd/Ctrl + P</kbd> and type your component's file name. Source maps are on in development, so you see your TypeScript, not the bundle. Install <strong>React Developer Tools</strong> to read props, state and hooks of any component.</p>

    <h2 id="routes-actions">Step 5: Route Handlers and Server Actions</h2>
    <p>These are server code reached from the browser, so you need both halves: what the browser sent, and what the server did with it. Call a Route Handler directly with <code>curl -i</code> to rule out the UI, and log or pause inside it. The details are in <a href="../debug-nextjs-api-routes/">debugging API routes</a> and <a href="../debug-nextjs-server-actions/">debugging Server Actions</a>.</p>

    <h2 id="errors">Step 6: read the error overlay and the stack</h2>
    <p>In development, Next.js shows runtime errors in an overlay with a source-mapped stack. Click a frame to open it in your editor. In production, errors thrown on the server are replaced with a generic message and a <code>digest</code>; search your server logs for that digest to find the real error.</p>

    <h2 id="one-screen">Doing it all from one screen</h2>
    <p><a href="../../">qaisdebugs</a> puts these steps in one inspector. Run <code>qaisdebugs dev</code> instead of <code>npm run dev</code> and you get:</p>
    <ul>
      <li>every browser <em>and</em> server request, with headers, bodies, timing and the file and line that made it, nested under the page load that caused it;</li>
      <li>server and browser logs in one list, each tied to its request;</li>
      <li>breakpoints in Server and Client Components with a click on the line number, no <code>--inspect</code> or <code>launch.json</code>.</li>
    </ul>

    <h2 id="checklist">A quick checklist</h2>
    <ol>
      <li>Decide whether the failing code runs on the server, in the browser, or both.</li>
      <li>Read the terminal and the browser console.</li>
      <li>Check what the browser sent and what the server called.</li>
      <li>Pause on the line where the data first goes wrong and read the variables.</li>
      <li>Fix it, reload, and confirm the request and logs look right.</li>
    </ol>`,
  },

  {
    slug: 'nextjs-debugging-tools',
    title: 'Best tools to debug a Next.js app (compared) | qaisdebugs',
    headline: 'The best tools to debug a Next.js app',
    summary: 'Browser DevTools, React DevTools, the Node inspector, VS Code and more, compared.',
    description:
      'Next.js debugging tools compared: Browser and React DevTools, the error overlay, the Node.js inspector, VS Code, fetch logging, OpenTelemetry and qaisdebugs.',
    minutes: 6,
    lead: 'No single built-in tool sees a whole Next.js app, because half of it runs on the server. Here is what each debugging tool can and cannot show you, and when to reach for it.',
    related: ['how-to-debug-nextjs', 'nextjs-server-side-network-requests', 'debug-nextjs-with-claude'],
    body: `
    <h2 id="compared">The tools at a glance</h2>
    <div class="table-scroll glass"><table>
      <thead><tr><th>Tool</th><th>Sees</th><th>Misses</th></tr></thead>
      <tbody>
        <tr><td><strong>Browser DevTools</strong></td><td>Page requests, browser console, client breakpoints</td><td>Everything on the server</td></tr>
        <tr><td><strong>React Developer Tools</strong></td><td>Component tree, props, state, render timing</td><td>Network, server code</td></tr>
        <tr><td><strong>Next.js error overlay</strong></td><td>Runtime and build errors with source-mapped stacks</td><td>Anything that is not an error</td></tr>
        <tr><td><strong>Node.js inspector</strong> (<code>--inspect</code>)</td><td>Server breakpoints, variables, CPU and memory profiles</td><td>Server network calls, by default</td></tr>
        <tr><td><strong>VS Code debugger</strong></td><td>Server and client breakpoints from the editor</td><td>Network and log correlation</td></tr>
        <tr><td><strong><code>logging.fetches</code></strong></td><td>Server <code>fetch</code> URLs, status, cache, timing</td><td>Headers, bodies, axios and other clients</td></tr>
        <tr><td><strong>OpenTelemetry</strong> (<code>instrumentation.ts</code>)</td><td>Traces across services, in dev and production</td><td>Needs setup and a trace viewer; no breakpoints</td></tr>
        <tr><td><strong>Error monitoring</strong> (Sentry and others)</td><td>Production errors with context</td><td>Day-to-day debugging in development</td></tr>
        <tr><td><strong>qaisdebugs</strong></td><td>Browser and server requests with bodies, all logs, server and client breakpoints, in one place</td><td>Production: it is a development tool</td></tr>
      </tbody>
    </table></div>

    <h2 id="browser">Browser and React DevTools</h2>
    <p>Still the first stop for anything you can see in the page: layout, client state, failed requests from the browser and client-side errors. React Developer Tools adds the component tree, so you can check the props a Client Component actually received.</p>

    <h2 id="node">The Node.js inspector and VS Code</h2>
    <p>Run <code>NODE_OPTIONS='--inspect' next dev</code> and attach Chrome's DevTools (<code>chrome://inspect</code>) or VS Code. You get real breakpoints in Server Components, Route Handlers and Server Actions. It is powerful but takes setup per project, and it shows nothing about network calls unless you step into them. See <a href="../nextjs-breakpoints-vscode-chrome/">VS Code and Chrome breakpoints</a>.</p>

    <h2 id="logging">Fetch logging and OpenTelemetry</h2>
    <p><code>logging: { fetches: { fullUrl: true } }</code> in <code>next.config</code> is the quickest way to see which URLs the server fetched. For tracing across services, Next.js supports OpenTelemetry through <code>instrumentation.ts</code> and <code>@vercel/otel</code>. That suits production monitoring more than quick local debugging.</p>

    <h2 id="qaisdebugs">qaisdebugs: one inspector for the whole app</h2>
    <p><a href="../../">qaisdebugs</a> is a free, open-source dev tool built for exactly the gap above. It attaches to <code>next dev</code> from outside, with no code changes, and shows:</p>
    <ul>
      <li>every server-side call (<code>fetch</code>, axios, got, node-fetch) with headers, bodies and the file:line that made it;</li>
      <li>every browser request, merged with the server's half of the same call;</li>
      <li>server and browser logs in one list;</li>
      <li>breakpoints in Server and Client Components, set by clicking a line;</li>
      <li>an MCP server, so <a href="../debug-nextjs-with-claude/">Claude or Cursor can debug the app</a> with you.</li>
    </ul>
    ${code(`npm install -g qaisdebugs
qaisdebugs dev`)}

    <h2 id="which">Which one should you use?</h2>
    <ul>
      <li><strong>Something looks wrong in the page:</strong> Browser DevTools and React DevTools.</li>
      <li><strong>The data is wrong:</strong> look at the server's requests, with qaisdebugs or <code>logging.fetches</code>.</li>
      <li><strong>You need a variable's value on the server:</strong> a breakpoint, through qaisdebugs, Chrome or VS Code.</li>
      <li><strong>It only fails in production:</strong> error monitoring and OpenTelemetry.</li>
    </ul>`,
  },

  {
    slug: 'debug-nextjs-server-components',
    title: 'How to debug Next.js Server Components | qaisdebugs',
    headline: 'How to debug Next.js Server Components',
    summary: 'Logs, breakpoints, data fetching and the common Server Component bugs.',
    description:
      'How to debug Next.js Server Components: where their logs go, how to set breakpoints, how to see their fetch calls, and the most common Server Component bugs.',
    minutes: 6,
    lead: 'Server Components run only on the server, so the browser\'s DevTools cannot see inside them. Here is how to read their logs, pause them, see the data they fetch, and spot the mistakes that cause most Server Component bugs.',
    related: ['nextjs-server-side-network-requests', 'nextjs-logs', 'how-to-debug-nextjs'],
    body: `
    <h2 id="logs">Where Server Component logs go</h2>
    <p>A <code>console.log</code> in a Server Component prints in the terminal running <code>next dev</code>. Since Next.js 15 it is also replayed in the browser console with a <em>Server</em> label, so you can see it next to client logs. If you see nothing at all, the component may not be rendering: check that the route is the one you think, and that a <code>loading.tsx</code> or an error boundary is not showing instead.</p>

    <h2 id="breakpoints">Setting breakpoints</h2>
    <p>Start the server with the Node.js inspector, attach Chrome or VS Code, and click a line:</p>
    ${code(`NODE_OPTIONS='--inspect' npx next dev`)}
    <p>Open <code>chrome://inspect</code>, choose the Next.js target, and find your <code>page.tsx</code> with <kbd>Cmd/Ctrl + P</kbd>. Next.js compiles routes on demand, so load the page once before setting the breakpoint, or put a <code>debugger;</code> statement in the component.</p>
    <p>With <a href="../../">qaisdebugs</a>, run <code>qaisdebugs dev</code>, open the Sources view and click the line number. It connects to the server for you, and a breakpoint on a file that is not compiled yet turns active as soon as it is.</p>

    <h2 id="data">Seeing the data they fetch</h2>
    <p>Server Components usually exist to fetch data, and those requests never reach the browser's Network tab. Turn on <code>logging.fetches</code> in <code>next.config</code> to list <code>fetch</code> calls, or use qaisdebugs to see every call, axios included, with headers, bodies and the line that made it. <a href="../nextjs-server-side-network-requests/">More on server-side requests</a>.</p>

    <h2 id="common-bugs">The most common Server Component bugs</h2>
    <h3><code>params</code> and <code>searchParams</code> are Promises</h3>
    <p>Since Next.js 15, page props are asynchronous. Reading <code>searchParams.page</code> without awaiting gives <code>undefined</code>, and the request goes out with the wrong value:</p>
    ${code(`export default async function Page({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const { page = '1' } = await searchParams;
  const products = await getProducts(Number(page));
  return <ProductList products={products} />;
}`)}
    <h3>Stale data from caching</h3>
    <p>In Next.js 14, <code>fetch</code> on the server was cached by default, so an API change might not show up. Next.js 15 stopped caching by default. If data looks stale, check the cache result in the fetch log and set <code>cache: 'no-store'</code> or a <code>revalidate</code> time on purpose.</p>
    <h3>Hooks or browser APIs in a Server Component</h3>
    <p><code>useState</code>, <code>useEffect</code>, event handlers and <code>window</code> only work in Client Components. Move the interactive part into a small <code>'use client'</code> component and keep the data fetching on the server.</p>
    <h3>Props that cannot cross to the client</h3>
    <p>Props passed from a Server Component to a Client Component must be serializable. Functions, class instances and some objects fail. Pass plain data, and use Server Actions for functions.</p>

    <h2 id="checklist">Checklist</h2>
    <ol>
      <li>Is the component rendering at all? Check the terminal.</li>
      <li>What did it fetch, and what came back? Check the server's requests.</li>
      <li>Which value is wrong first? Pause and read it.</li>
    </ol>`,
  },

  {
    slug: 'nextjs-server-side-network-requests',
    title: 'Server-side network requests in Next.js | qaisdebugs',
    headline: 'How to see server-side network requests in Next.js',
    summary: 'Why the Network tab misses them, and how to see every fetch and axios call.',
    description:
      'Why server-side fetch and axios calls in Next.js never show in the browser Network tab, and how to see them: fetch logging, interceptors and qaisdebugs.',
    minutes: 5,
    lead: 'You open the Network tab, reload, and the call to your backend is not there. That is expected: in Next.js most data fetching happens on the server. Here is how to see those requests.',
    related: ['debug-nextjs-server-components', 'debug-nextjs-api-routes', 'nextjs-debugging-tools'],
    body: `
    <h2 id="why">Why the Network tab does not show them</h2>
    <p>The browser's Network tab records requests <em>the browser</em> makes. When a Server Component, Route Handler, Server Action or <code>generateMetadata</code> calls an API, that request goes from the Node.js server straight to the API. The browser only receives the finished HTML or RSC payload, so there is nothing for DevTools to record.</p>

    <h2 id="logging-fetches">Option 1: Next.js fetch logging</h2>
    ${code(`// next.config.ts
const nextConfig = {
  logging: { fetches: { fullUrl: true } },
};

export default nextConfig;`)}
    <p>The terminal then lists every server <code>fetch</code> with its URL, status, cache hit or miss, and duration. It is built in and free, but it only covers <code>fetch</code>, and it never shows headers or bodies.</p>

    <h2 id="interceptors">Option 2: log them yourself</h2>
    <p>With axios, an interceptor can log each request and response:</p>
    ${code(`api.interceptors.request.use((config) => {
  console.log('→', config.method?.toUpperCase(), config.url, config.params);
  return config;
});

api.interceptors.response.use((response) => {
  console.log('←', response.status, response.config.url);
  return response;
});`)}
    <p>This works, but it is code you have to add and remember to remove, it can print tokens into your logs, and the lines are hard to match to the page request that caused them.</p>

    <h2 id="node-flag">Option 3: Node's experimental network inspection</h2>
    <p>Recent Node.js versions have an experimental <code>--experimental-network-inspection</code> flag that sends some of the server's HTTP traffic to the Network panel of DevTools for Node. Coverage depends on your Node version and it is still experimental, but it is worth knowing about.</p>

    <h2 id="qaisdebugs">Option 4: qaisdebugs</h2>
    <p><a href="../../">qaisdebugs</a> was built for this. It hooks the dev server from outside, with no code changes, and records every outgoing call from <code>fetch</code>, axios, got, node-fetch and generated API clients:</p>
    <ul>
      <li>method, URL, status, timing, request and response headers and bodies;</li>
      <li>the file and line in your code that made the call;</li>
      <li>nested under the page load or API call that caused it, as a trace;</li>
      <li>tokens, passwords and cookies masked before anything is stored.</li>
    </ul>
    ${code(`npm install -g qaisdebugs
qaisdebugs dev     # instead of npm run dev
# open http://127.0.0.1:4983`)}
    <p>The browser's own requests show up in the same list, and a call from the page to your own API is one row with both halves: what the browser sent and what the server did with it.</p>`,
  },

  {
    slug: 'debug-nextjs-api-routes',
    title: 'How to debug Next.js API routes and Route Handlers | qaisdebugs',
    headline: 'How to debug Next.js API routes and Route Handlers',
    summary: 'Call them directly, read the request, pause inside, and the classic mistakes.',
    description:
      'Debug Next.js API routes and Route Handlers: call them with curl, log the request, set breakpoints, and fix the most common Route Handler mistakes.',
    minutes: 6,
    lead: 'A Route Handler (app/api/.../route.ts) or a Pages Router API route is server code with a URL. Debugging it means checking three things: what arrived, what it called, and what it returned.',
    related: ['debug-nextjs-server-actions', 'nextjs-server-side-network-requests', 'how-to-debug-nextjs'],
    body: `
    <h2 id="direct">Call the route directly</h2>
    <p>Take the UI out of the picture first. If the route fails on its own, the bug is on the server:</p>
    ${code(`curl -i "http://localhost:3000/api/tasks?userId=2"

curl -i -X POST http://localhost:3000/api/tasks \\
  -H "Content-Type: application/json" \\
  -d '{"title":"Write the report"}'`)}
    <p><code>-i</code> prints the status and headers, so you can see a 307 redirect or a wrong content type straight away.</p>

    <h2 id="request">Check what arrived</h2>
    <p>Most Route Handler bugs are about the input. Log it at the top of the handler:</p>
    ${code(`export async function GET(request: NextRequest) {
  console.log(request.method, request.nextUrl.pathname, Object.fromEntries(request.nextUrl.searchParams));
  // ...
}`)}

    <h2 id="breakpoints">Pause inside it</h2>
    <p>Start <code>next dev</code> with <code>NODE_OPTIONS='--inspect'</code>, attach Chrome (<code>chrome://inspect</code>) or VS Code, and set a breakpoint in <code>route.ts</code>. With <a href="../../">qaisdebugs</a> you click the line in its Sources view instead, and the request, its logs and its outgoing calls are already on screen.</p>

    <h2 id="mistakes">The classic mistakes</h2>
    <h3>Reading the wrong query parameter</h3>
    <p>The page sends <code>?userId=2</code> but the handler reads another name, so the value is <code>null</code> and the API call goes out as <code>?userId=null</code>. No error is thrown; you just get empty data:</p>
    ${code(`const userId = request.nextUrl.searchParams.get('user');   // the page sends userId → null
const userId = request.nextUrl.searchParams.get('userId'); // correct`)}
    <p>This is exactly the kind of bug that is easy to see when the browser's request and the server's outgoing request are side by side.</p>
    <h3>Forgetting to await <code>params</code></h3>
    <p>In dynamic routes such as <code>app/api/users/[id]/route.ts</code>, the second argument's <code>params</code> is a Promise since Next.js 15: use <code>const { id } = await params</code>.</p>
    <h3>Reading the body twice</h3>
    <p><code>request.json()</code> and <code>request.text()</code> consume the body. A second read throws. Read it once and keep the result.</p>
    <h3>Swallowing errors</h3>
    <p>A <code>try/catch</code> that returns <code>{ ok: false }</code> with status 200 hides the real failure. Log the error and return a real status code.</p>
    <h3>An upstream error passed on as success</h3>
    <p>Check <code>response.ok</code> before <code>response.json()</code> when your route calls another API, or a 404 from upstream becomes a confusing empty list.</p>

    <h2 id="pages-router">Pages Router API routes</h2>
    <p>Routes in <code>pages/api/</code> debug the same way: they are Node.js handlers with <code>req</code> and <code>res</code>, logs go to the terminal, and breakpoints work with <code>--inspect</code>.</p>`,
  },

  {
    slug: 'debug-nextjs-server-actions',
    title: 'How to debug Next.js Server Actions | qaisdebugs',
    headline: 'How to debug Next.js Server Actions',
    summary: 'What an action sends, where its errors go, and the mistakes that break it.',
    description:
      'How to debug Next.js Server Actions: what the request looks like, where logs and errors go, breakpoints, and the redirect and revalidate pitfalls.',
    minutes: 5,
    lead: 'A Server Action looks like a function call, but it is an HTTP request in disguise. Once you know what that request looks like, Server Actions are much easier to debug.',
    related: ['debug-nextjs-api-routes', 'nextjs-logs', 'how-to-debug-nextjs'],
    body: `
    <h2 id="request">What a Server Action sends</h2>
    <p>Calling a Server Action, from a form or from code, makes the browser send a <code>POST</code> to the current page's URL with a <code>Next-Action</code> header that identifies the action. The body holds the serialized arguments (form data for forms), and the response is an RSC payload (<code>text/x-component</code>). In the browser's Network tab, look for a POST to the page itself.</p>

    <h2 id="logs">Where its logs and errors go</h2>
    <p>The action runs on the server, so <code>console.log</code> inside it prints in the terminal, not the browser. In development an error thrown inside it shows in the error overlay. In production the message is hidden from the client, so return errors as data instead of throwing for anything the user should see:</p>
    ${code(`'use server';

export async function createTask(formData: FormData) {
  const title = String(formData.get('title') ?? '');
  if (!title) return { error: 'Title is required' };

  await db.task.create({ data: { title } });
  revalidatePath('/tasks');
  return { ok: true };
}`)}

    <h2 id="breakpoints">Breakpoints</h2>
    <p>Server Actions are ordinary server code, so a breakpoint in the action pauses with the Node.js inspector (<code>NODE_OPTIONS='--inspect' next dev</code>) or with <a href="../../">qaisdebugs</a>, where the action's request, its logs and every call it makes appear together.</p>

    <h2 id="pitfalls">Common pitfalls</h2>
    <h3>The page does not update</h3>
    <p>After changing data, call <code>revalidatePath</code> or <code>revalidateTag</code>, or the page keeps showing the old result.</p>
    <h3><code>redirect()</code> inside <code>try/catch</code></h3>
    <p><code>redirect()</code> works by throwing a special error. If your <code>catch</code> catches it, the redirect never happens. Call <code>redirect()</code> after the <code>try/catch</code>.</p>
    <h3>Request body too large</h3>
    <p>Server Actions accept 1 MB by default. For larger uploads, raise <code>serverActions.bodySizeLimit</code> in <code>next.config</code> or upload in another way.</p>
    <h3>Trusting the input</h3>
    <p>An action is a public endpoint. Validate its arguments and check the user's permission inside it, just like an API route.</p>`,
  },

  {
    slug: 'nextjs-breakpoints-vscode-chrome',
    title: 'Next.js breakpoints in VS Code and Chrome DevTools | qaisdebugs',
    headline: 'Set breakpoints in Next.js with VS Code and Chrome DevTools',
    summary: 'The --inspect flag, chrome://inspect, launch.json, and why breakpoints do not hit.',
    description:
      'Set breakpoints in Next.js server and client code with Chrome DevTools or VS Code: the --inspect flag, a launch.json, and breakpoints that never hit.',
    minutes: 6,
    lead: 'Breakpoints beat console.log for any bug you cannot explain in a minute. Here is how to set them in both halves of a Next.js app, with Chrome DevTools, VS Code or no setup at all.',
    related: ['how-to-debug-nextjs', 'debug-nextjs-server-components', 'nextjs-debugging-tools'],
    body: `
    <h2 id="chrome-server">Server code with Chrome DevTools</h2>
    ${code(`NODE_OPTIONS='--inspect' npx next dev`)}
    <p>On Windows, set the variable with <code>cross-env</code> or <code>set NODE_OPTIONS=--inspect</code> first. Recent Next.js versions also accept <code>next dev --inspect</code>.</p>
    <ol>
      <li>Open <code>chrome://inspect</code> in Chrome.</li>
      <li>Click <strong>Open dedicated DevTools for Node</strong>, or <em>inspect</em> under the Next.js remote target.</li>
      <li>In <strong>Sources</strong>, press <kbd>Cmd/Ctrl + P</kbd> and open your file.</li>
      <li>Click a line number, then load the page or call the route.</li>
    </ol>

    <h2 id="chrome-client">Client code with Chrome DevTools</h2>
    <p>Open DevTools on your app's page, go to <strong>Sources</strong>, press <kbd>Cmd/Ctrl + P</kbd> and type the component's file name. Set the breakpoint and interact with the page. To pause during the first render, set it and reload.</p>

    <h2 id="vscode">VS Code</h2>
    <p>Add <code>.vscode/launch.json</code> to your project:</p>
    ${code(`{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Next.js: debug server-side",
      "type": "node-terminal",
      "request": "launch",
      "command": "npm run dev"
    },
    {
      "name": "Next.js: debug client-side",
      "type": "chrome",
      "request": "launch",
      "url": "http://localhost:3000"
    }
  ]
}`)}
    <p>Pick a configuration in the Run and Debug panel and press <kbd>F5</kbd>. Breakpoints set in the editor gutter now pause the server or the browser.</p>

    <h2 id="not-hitting">When a breakpoint never hits</h2>
    <ul>
      <li><strong>The file is not compiled yet.</strong> Next.js compiles routes on demand. Load a page that uses the file, then the breakpoint binds.</li>
      <li><strong>The code runs in the other place.</strong> A breakpoint in a Server Component never pauses the browser, and an <code>onClick</code> handler never pauses the server.</li>
      <li><strong>You attached to the wrong process.</strong> Next.js starts more than one Node process; pick the one that serves your pages.</li>
      <li><strong>The code did not run.</strong> Add a <code>console.log</code> or a <code>debugger;</code> statement to prove the line is reached.</li>
    </ul>

    <h2 id="no-setup">Breakpoints with no setup</h2>
    <p><a href="../../">qaisdebugs</a> connects to the dev server by itself. Run <code>qaisdebugs dev</code>, open the Sources view at <code>http://127.0.0.1:4983</code>, and click a line number in any Server Component, Route Handler, Server Action or Client Component. Client breakpoints pause in the Chrome window <code>qaisdebugs dev</code> opens, and a breakpoint set once applies to both the server and the page.</p>`,
  },

  {
    slug: 'nextjs-logs',
    title: 'Next.js logs: where console.log goes | qaisdebugs',
    headline: 'Next.js logs: where console.log goes on the server and in the browser',
    summary: 'Terminal or browser console, logs in production, and seeing them together.',
    description:
      'Where console.log goes in Next.js: the terminal, the browser console, Server Component log replay, production logs, and server and browser logs together.',
    minutes: 4,
    lead: '"My console.log does not show up" is the most common Next.js debugging question. The answer depends on where the code runs.',
    related: ['how-to-debug-nextjs', 'debug-nextjs-server-components', 'debug-nextjs-server-actions'],
    body: `
    <h2 id="where">Where each log goes</h2>
    <div class="table-scroll glass"><table>
      <thead><tr><th>Code</th><th>Development</th><th>Production</th></tr></thead>
      <tbody>
        <tr><td>Server Components</td><td>Terminal; also replayed in the browser console with a <em>Server</em> label (Next.js 15+)</td><td>Your host's server logs</td></tr>
        <tr><td>Route Handlers, Server Actions, middleware</td><td>Terminal</td><td>Your host's server or function logs</td></tr>
        <tr><td>Client Components (after hydration)</td><td>Browser console</td><td>The user's browser console</td></tr>
        <tr><td>Client Components (first render)</td><td>Terminal <em>and</em> browser console</td><td>Server logs and browser console</td></tr>
      </tbody>
    </table></div>
    <p>The last row surprises people: a <code>console.log</code> in the body of a Client Component runs during server rendering too, so it appears in the terminal as well.</p>

    <h2 id="fetch">Logging server fetches</h2>
    <p>Set <code>logging: { fetches: { fullUrl: true } }</code> in <code>next.config</code> to print every server <code>fetch</code> with its status, cache result and timing. It does not cover axios or other clients.</p>

    <h2 id="production">Logs in production</h2>
    <p>Server logs go to standard output, so read them wherever your host collects it: the Vercel dashboard's logs, <code>docker logs</code>, or your platform's log viewer. Server errors shown to users carry a <code>digest</code>; search the logs for it to find the real error. Prefer structured logs (one JSON object per line) once you have more than one server.</p>

    <h2 id="together">Seeing server and browser logs together</h2>
    <p>With two windows, it is hard to know which server line belongs to which click. <a href="../../">qaisdebugs</a> shows server and browser <code>console.*</code> output and uncaught errors in one list, each line with its file, line number and the request it belongs to. Tokens and passwords in logged objects are masked automatically.</p>
    ${code(`npm install -g qaisdebugs
qaisdebugs dev`)}`,
  },

  {
    slug: 'debug-nextjs-hydration-errors',
    title: 'How to debug and fix Next.js hydration errors | qaisdebugs',
    headline: 'How to debug and fix Next.js hydration errors',
    summary: 'What hydration mismatches are, the usual causes, and the right fix for each.',
    description:
      'Fix "Hydration failed" errors in Next.js: what causes hydration mismatches, how to find the component, and the right fix for each cause.',
    minutes: 5,
    lead: 'A hydration error means the HTML the server rendered is different from what React rendered in the browser. The fix is to find what differs, and make it the same or render it only in the browser.',
    related: ['how-to-debug-nextjs', 'nextjs-logs', 'nextjs-breakpoints-vscode-chrome'],
    body: `
    <h2 id="what">What a hydration error is</h2>
    <p>Next.js renders your page to HTML on the server. In the browser, React then <em>hydrates</em> that HTML: it renders the same components again and attaches event handlers. If the two renders produce different output, React reports a hydration mismatch and may re-render the whole tree on the client. Recent Next.js versions show a diff of the server and client output in the error overlay, which usually points straight at the problem.</p>

    <h2 id="causes">The usual causes</h2>
    <ul>
      <li><strong>Values that change between renders:</strong> <code>new Date()</code>, <code>Date.now()</code>, <code>Math.random()</code>, generated IDs.</li>
      <li><strong>Browser-only checks during render:</strong> <code>typeof window !== 'undefined'</code>, <code>localStorage</code>, media queries.</li>
      <li><strong>Locale and time zone differences:</strong> <code>toLocaleString()</code> on a server in UTC and a browser in another zone.</li>
      <li><strong>Invalid HTML nesting:</strong> a <code>&lt;div&gt;</code> inside a <code>&lt;p&gt;</code>, or a link inside a link. The browser fixes the HTML before React sees it.</li>
      <li><strong>Browser extensions</strong> that change the page before React hydrates. Test in a private window.</li>
    </ul>

    <h2 id="fixes">The fixes</h2>
    <h3>Render browser-only values after mounting</h3>
    ${code(`'use client';
import { useEffect, useState } from 'react';

export function LocalTime() {
  const [time, setTime] = useState<string>();
  useEffect(() => setTime(new Date().toLocaleTimeString()), []);
  return <span>{time ?? '…'}</span>;
}`)}
    <h3>Skip server rendering for a browser-only component</h3>
    ${code(`'use client';
import dynamic from 'next/dynamic';

const Map = dynamic(() => import('./Map'), { ssr: false });`)}
    <h3>Silence one expected difference</h3>
    <p>For a single element whose text is meant to differ, such as a timestamp, add <code>suppressHydrationWarning</code> to that element. It only applies one level deep, so do not use it to hide real bugs.</p>
    <h3>Fix the HTML</h3>
    <p>Change the outer <code>&lt;p&gt;</code> to a <code>&lt;div&gt;</code>, or move the nested block outside it.</p>

    <h2 id="find">Finding the component</h2>
    <p>Read the diff in the overlay, then search for the text it shows. If the stack is not enough, pause on the error: in Chrome DevTools enable <em>Pause on uncaught exceptions</em>, or in <a href="../../">qaisdebugs</a> turn on <em>On exceptions</em> in the Sources view, which also records the error in its Logs view with the file it came from.</p>`,
  },

  {
    slug: 'debug-nextjs-with-claude',
    title: 'Debug a Next.js app with Claude, Cursor and MCP | qaisdebugs',
    headline: 'Debug a Next.js app with Claude, Cursor and MCP',
    summary: 'Let an AI assistant read your requests and logs and set breakpoints.',
    description:
      'Let Claude Code, Cursor or another MCP client debug your Next.js app: real server and browser requests, logs and breakpoints, through qaisdebugs.',
    minutes: 4,
    lead: 'AI coding assistants are good at reading code, but they cannot see what your app actually did at runtime. The qaisdebugs MCP server gives them that: the real requests, logs, errors and a debugger.',
    related: ['how-to-debug-nextjs', 'nextjs-debugging-tools', 'debug-nextjs-api-routes'],
    body: `
    <h2 id="setup">Set it up</h2>
    ${code(`npm install -g qaisdebugs
claude mcp add qaisdebugs -- qaisdebugs mcp`)}
    <p>For Cursor, Windsurf and other MCP clients, add the same command to their MCP settings, for example Cursor's <code>mcp.json</code>:</p>
    ${code(`{
  "mcpServers": {
    "qaisdebugs": { "command": "qaisdebugs", "args": ["mcp"] }
  }
}`)}
    <p>Then start your app with <code>qaisdebugs dev</code> as usual.</p>

    <h2 id="ask">What to ask</h2>
    <ul>
      <li>"Clear qaisdebugs and wait while I reproduce the bug on the tasks page, then find out what went wrong."</li>
      <li>"Why does /api/orders return 500?"</li>
      <li>"Set a breakpoint in app/shop/page.tsx line 18 and tell me what searchParams is when I load /shop?category=shoes."</li>
    </ul>

    <h2 id="example">A real example</h2>
    <p>A team tasks card showed "No tasks found" for every person. Asked to investigate, the assistant used <code>list_problems</code> and <code>get_trace</code> and saw that the page called <code>/api/tasks?userId=2</code>, but the server then called the tasks API with <code>userId=null</code>, from line 13 of <code>route.ts</code>. Reading the file showed the handler read the query parameter <code>user</code> instead of <code>userId</code>. One look at both halves of the request found a bug that threw no error at all.</p>

    <h2 id="tools">The tools it gets</h2>
    <div class="table-scroll glass"><table>
      <thead><tr><th>Tools</th><th>What they do</th></tr></thead>
      <tbody>
        <tr><td><code>status</code>, <code>clear</code>, <code>wait_for</code></td><td>See what is running, start clean, wait while you reproduce the bug</td></tr>
        <tr><td><code>list_requests</code>, <code>get_request</code>, <code>get_trace</code></td><td>Browser and server requests with headers, bodies, timing and the line that made them</td></tr>
        <tr><td><code>list_logs</code>, <code>list_problems</code></td><td>Server and browser logs; failed requests, errors and warnings</td></tr>
        <tr><td><code>find_files</code>, <code>read_file</code></td><td>The app's source</td></tr>
        <tr><td><code>set_breakpoint</code>, <code>wait_for_pause</code>, <code>evaluate</code>, <code>step</code></td><td>Pause server or client code and read the variables</td></tr>
      </tbody>
    </table></div>

    <h2 id="privacy">Privacy</h2>
    <p>Everything stays on your machine. The MCP server reads from the local inspector, which masks passwords, tokens, API keys and cookies before it stores anything.</p>`,
  },
];
