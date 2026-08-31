// Serves the herald client, and gives /id/:name real metadata in the HTML.
//
// The bundle assembles the identity page in the browser, so anything that does
// not run JavaScript -- link unfurlers in Slack, iMessage, Signal, Discord and
// nostr clients, and search crawlers -- saw an empty <div id="root"> and the
// same generic title for every identity (#975). Sharing an identity link is how
// someone introduces themselves, so that is the moment the page has to describe
// itself without help from the bundle.
//
// Usage: node serve-herald.mjs <root> [port]

import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { createStaticHandler } from './serve-static.mjs';

const root = resolve(process.argv[2] ?? 'dist');
const port = Number(process.argv[3] ?? process.env.VITE_PORT ?? 8080);
const host = process.env.HOST ?? '0.0.0.0';

// Where this instance is reached from outside, used for og:url and to build the
// address shown on the card. Absent, the tags are still emitted without them
// rather than guessing at a hostname the deployment may not use.
const publicUrl = (process.env.ARCHON_HERALD_PUBLIC_URL ?? '').replace(/\/+$/, '');
const domain = process.env.ARCHON_HERALD_DOMAIN ?? '';

// Matches the server's own rule (routes.ts validateName): lowercase letters,
// digits, hyphen and underscore, 3-32 characters. Anything else cannot be a
// registered name, so it gets the shell untouched rather than a card for an
// identity that does not exist.
const ID_ROUTE = /^\/id\/([a-z0-9_-]{3,32})\/?$/;

function escapeHtml(value) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function metaTags(name) {
    const address = domain ? `${name}@${domain}` : name;
    const title = `${address}`;
    const description = domain
        ? `${address} — a decentralized identity anchored on ${domain}.`
        : `${name} — a decentralized identity.`;
    const url = publicUrl ? `${publicUrl}/id/${encodeURIComponent(name)}` : '';

    const tags = [
        `<title>${escapeHtml(title)}</title>`,
        `<meta name="description" content="${escapeHtml(description)}" />`,
        `<meta property="og:type" content="profile" />`,
        `<meta property="og:title" content="${escapeHtml(title)}" />`,
        `<meta property="og:description" content="${escapeHtml(description)}" />`,
        url ? `<meta property="og:url" content="${escapeHtml(url)}" />` : '',
        `<meta name="twitter:card" content="summary" />`,
        `<meta name="twitter:title" content="${escapeHtml(title)}" />`,
        `<meta name="twitter:description" content="${escapeHtml(description)}" />`,
    ];

    return tags.filter(Boolean).join('\n    ');
}

function transformHtml(html, pathname) {
    const match = ID_ROUTE.exec(pathname);
    if (!match) {
        return undefined;
    }

    // Replace the build's placeholder title rather than adding a second one,
    // which unfurlers resolve inconsistently.
    return html
        .replace(/<title>.*?<\/title>\s*/is, '')
        .replace(/<\/head>/i, `    ${metaTags(match[1])}\n  </head>`);
}

createServer(createStaticHandler({ root, transformHtml })).listen(port, host, () => {
    console.log(`Serving ${root} on http://${host}:${port}`);
});
