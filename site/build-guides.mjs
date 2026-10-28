/**
 * Builds the guide pages of the qaisdebugs website (docs/guides/), its sitemap, and the list of
 * guides on the home page.
 * Each guide answers one question people search for; the shared layout lives here.
 *
 *   node site/build-guides.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GUIDES } from './guides.mjs';

const SITE = 'https://themdkaish.github.io/qaisdebugs/';
const UPDATED = '2026-10-28';
const docs = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs');

const escapeAttr = (value) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const stripTags = (html) => html.replace(/<[^>]+>/g, '');

const LOGO = `<svg viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="m" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#22d3ee"/><stop offset="1" stop-color="#a78bfa"/></linearGradient></defs><rect x="2" y="2" width="60" height="60" rx="16" fill="#0f172a" stroke="url(#m)" stroke-width="2.5"/><g fill="none" stroke="url(#m)" stroke-width="3.6" stroke-linecap="round"><ellipse cx="32" cy="34" rx="10" ry="13"/><path d="M32 21v26M22 29h-7M22 37h-8M23 44l-6 5M42 29h7M42 37h8M41 44l6 5M27 20l-3-5M37 20l3-5"/></g><rect x="9" y="32" width="46" height="2.6" rx="1.3" fill="#22d3ee"/></svg>`;

/** The page around a guide's content. `root` is the relative path back to docs/. */
function page({ root, url, title, description, ogTitle, ogType, jsonLd, content }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <meta name="description" content="${escapeAttr(description)}">
  <meta name="author" content="Mahammad Kaish">
  <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">
  <meta name="theme-color" content="#0a0e1a">
  <meta name="color-scheme" content="dark">
  <link rel="canonical" href="${url}">

  <meta property="og:type" content="${ogType}">
  <meta property="og:site_name" content="qaisdebugs">
  <meta property="og:title" content="${escapeAttr(ogTitle)}">
  <meta property="og:description" content="${escapeAttr(description)}">
  <meta property="og:url" content="${url}">
  <meta property="og:image" content="${SITE}og.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeAttr(ogTitle)}">
  <meta name="twitter:description" content="${escapeAttr(description)}">
  <meta name="twitter:image" content="${SITE}og.png">

  <link rel="icon" type="image/svg+xml" href="${root}favicon.svg">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="${root}site.css">
  <script type="application/ld+json">
${JSON.stringify(jsonLd, null, 2)}
  </script>
</head>
<body>
  <div class="backdrop" aria-hidden="true"><div class="orb cyan"></div><div class="orb violet"></div><div class="orb green"></div></div>

  <header class="wrap nav">
    <div class="bar glass">
      <a class="brand" href="${root}" aria-label="qaisdebugs home">
        ${LOGO}
        qaisdebugs
      </a>
      <nav class="nav-links" aria-label="Main">
        <a href="${root}guides/">Guides</a>
        <a class="section-link" href="${root}#features">Features</a>
        <a class="section-link" href="${root}#faq">FAQ</a>
        <a class="pill" href="https://github.com/themdkaish/qaisdebugs">GitHub</a>
      </nav>
    </div>
  </header>

  <main class="article">
${content}
  </main>

  <footer>
    <div class="wrap">
      <span>qaisdebugs · MIT © Mahammad Kaish</span>
      <nav aria-label="Footer">
        <a href="${root}guides/">Guides</a>
        <a href="https://www.npmjs.com/package/qaisdebugs">npm</a>
        <a href="https://github.com/themdkaish/qaisdebugs">GitHub</a>
      </nav>
    </div>
  </footer>
</body>
</html>
`;
}

const CTA = `
    <aside class="guide-cta glass">
      <h2>Debug your Next.js app on one screen</h2>
      <p class="lead">qaisdebugs shows every server and browser request, every log line, and lets you pause Server and Client Components. Free, no code changes.</p>
      <div class="install glass" style="width:min(460px,100%)"><span class="prompt">$</span><code>npm install -g qaisdebugs</code></div>
      <p class="lead">Then run <code>qaisdebugs dev</code> in your app's folder and open <code>http://127.0.0.1:4983</code>.</p>
      <a class="btn primary" href="../../">See how it works</a>
    </aside>`;

const guideUrl = (guide) => `${SITE}guides/${guide.slug}/`;

function relatedCards(slugs, root) {
  return slugs
    .map((slug) => GUIDES.find((guide) => guide.slug === slug))
    .map((guide) => `        <a class="glass" href="${root}guides/${guide.slug}/">${guide.headline}<span>${guide.summary}</span></a>`)
    .join('\n');
}

function guidePage(guide) {
  const headings = [...guide.body.matchAll(/<h2 id="([^"]+)">(.*?)<\/h2>/g)];
  const toc = headings.map(([, id, text]) => `        <li><a href="#${id}">${text}</a></li>`).join('\n');
  const url = guideUrl(guide);
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'TechArticle',
        headline: stripTags(guide.headline),
        description: guide.description,
        url,
        mainEntityOfPage: url,
        image: `${SITE}og.png`,
        datePublished: UPDATED,
        dateModified: UPDATED,
        inLanguage: 'en',
        proficiencyLevel: 'Beginner',
        about: [{ '@type': 'Thing', name: 'Next.js' }, { '@type': 'Thing', name: 'Debugging' }],
        author: { '@type': 'Person', name: 'Mahammad Kaish', url: 'https://github.com/themdkaish' },
        publisher: { '@type': 'Person', name: 'Mahammad Kaish', url: 'https://github.com/themdkaish' },
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'qaisdebugs', item: SITE },
          { '@type': 'ListItem', position: 2, name: 'Guides', item: `${SITE}guides/` },
          { '@type': 'ListItem', position: 3, name: stripTags(guide.headline), item: url },
        ],
      },
    ],
  };

  const content = `    <nav class="crumbs" aria-label="Breadcrumb"><a href="../../">qaisdebugs</a> / <a href="../">Guides</a> /</nav>
    <h1 class="gradient-text">${guide.headline}</h1>
    <p class="meta">Updated ${new Date(UPDATED).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })} · ${guide.minutes} min read</p>
    <p class="lead">${guide.lead}</p>

    <nav class="toc glass" aria-label="On this page">
      <b>On this page</b>
      <ol>
${toc}
      </ol>
    </nav>
${guide.body}
${CTA}

    <section aria-labelledby="related">
      <h2 id="related">Related guides</h2>
      <div class="related">
${relatedCards(guide.related, '../../')}
      </div>
    </section>`;

  return page({ root: '../../', url, title: guide.title, description: guide.description, ogTitle: stripTags(guide.headline), ogType: 'article', jsonLd, content });
}

function indexPage() {
  const url = `${SITE}guides/`;
  const description = 'Guides to debugging Next.js apps: server and client breakpoints, server-side network requests, logs, API routes, Server Actions, hydration errors and the best tools.';
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: 'Next.js debugging guides',
    description,
    url,
    hasPart: GUIDES.map((guide) => ({ '@type': 'TechArticle', headline: stripTags(guide.headline), url: guideUrl(guide) })),
  };
  const content = `    <nav class="crumbs" aria-label="Breadcrumb"><a href="../">qaisdebugs</a> /</nav>
    <h1 class="gradient-text">Next.js debugging guides</h1>
    <p class="lead">How to find out what a Next.js app is really doing: on the server, in the browser and in between. Each guide covers the built-in tools first, then shows where qaisdebugs saves time.</p>
    <div class="related" style="margin-top:36px">
${relatedCards(GUIDES.map((guide) => guide.slug), '../')}
    </div>`;

  return page({ root: '../', url, title: 'Next.js debugging guides: server, client, network and logs | qaisdebugs', description, ogTitle: 'Next.js debugging guides', ogType: 'website', jsonLd, content });
}

function sitemap() {
  const urls = [
    { loc: SITE, priority: '1.0' },
    { loc: `${SITE}guides/`, priority: '0.9' },
    ...GUIDES.map((guide) => ({ loc: guideUrl(guide), priority: '0.8' })),
  ];
  const entries = urls
    .map(({ loc, priority }) => `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${UPDATED}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>${priority}</priority>\n  </url>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
}

for (const guide of GUIDES) {
  const file = join(docs, 'guides', guide.slug, 'index.html');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, guidePage(guide));
}
writeFileSync(join(docs, 'guides', 'index.html'), indexPage());
writeFileSync(join(docs, 'sitemap.xml'), sitemap());

// The home page lists the guides between two markers.
const home = join(docs, 'index.html');
const cards = relatedCards(GUIDES.map((guide) => guide.slug), '').replace(/^ {8}/gm, '          ');
writeFileSync(
  home,
  readFileSync(home, 'utf8').replace(/(<!-- guides:start -->\n)[\s\S]*?( *<!-- guides:end -->)/, `$1${cards}\n$2`)
);
console.log(`Wrote ${GUIDES.length} guides, the guides index and the sitemap.`);
