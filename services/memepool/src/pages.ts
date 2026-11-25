import { readFile } from 'fs/promises';
import { join } from 'path';
import express from 'express';
import type { Request, Response } from 'express';

// The pages at the address of one publication or one author.
//
// A link given to someone is read first by whatever shows it: a chat, a feed,
// a search engine. Those ask for the address and read what the page says of
// itself in its head, and run none of its script. So the page at the address
// of a publication says there what the publication is: its title, a line of
// it, and an image where it has one.
//
// It is the same page as any other, and the script in it shows the
// publication to a person as it would have.

// What is known of a publication, which is what an indexer says of it.
export interface Shown {
    state: string;
    memeplex?: Record<string, unknown>;
}

export interface Previews {
    // An object's publication, or nothing where it has none.
    publication(did: string): Promise<Shown | undefined>;
    // The body of an article, by the CID its entry gives.
    body?(cid: string): Promise<string | undefined>;
    // The name an identity gives itself, which is a claim.
    name?(did: string): Promise<string | undefined>;
    // Whether what a text embeds is an image the service serves. A text
    // embeds a publication the same way, which is shown as a card and is no
    // image. Without it, a page names no image a text embeds.
    image?(did: string, version: string): Promise<boolean>;
}

export interface PageOptions {
    pagesDir: string;
    // What the service is called, which is the name of the site.
    site: string;
    // The address users reach the service at. Without it a page names no
    // address of its own and no image, which have to be whole addresses.
    publicURL?: string;
    previews?: Previews;
    isDid: (did: string) => boolean;
}

const TITLE = 90;
const LINE = 200;
// How much of a text is read for a line about it, and for the images it
// embeds. It is a stranger's text, read for every asking, so no more of it is
// gone over than those need.
const READ = 4000;
const EMBEDS = 5;

const escape = (text: string): string => text.replace(/[&<>"']/g, found => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;',
}[found] as string));

// A text cut to a number of characters, at a space where there is one near.
function short(text: string, most: number): string {
    const letters = Array.from(text);

    if (letters.length <= most) {
        return text;
    }

    const cut = letters.slice(0, most - 1).join('');
    const space = cut.lastIndexOf(' ');

    return `${(space > most * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

// The words of a Markdown text, without its marks: what a line about it says.
export function wordsOf(markdown: string): string {
    return markdown
        .slice(0, READ)
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\$\$[\s\S]*?\$\$/g, ' ')
        .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
        .replace(/[*_`~]/g, '')
        // Whatever cannot be printed, with every run of space, is one space.
        .replace(/[\p{Cc}\s]+/gu, ' ')
        .trim();
}

// What a text embeds, in the order it does: each a DID at a version, which is
// an image or a publication. Code is not read, since what is written in it
// is shown as it is written and embeds nothing.
//
// The text is gone over once. An embed ends in `](<DID>?versionId=<version>)`,
// which is looked for, and is one where a `![` opens the words before it.
export function embedsIn(markdown: string, most = EMBEDS): { did: string; version: string }[] {
    const text = markdown.replace(/```[^`]*```/g, ' ');
    const ends = /\]\(\s*(did:[a-z0-9]+:[A-Za-z0-9._%-]{1,200})\?versionId=([A-Za-z0-9]{1,200})\s*\)/g;
    const found: { did: string; version: string }[] = [];
    let from = 0;

    for (let end = ends.exec(text); end && found.length < most; end = ends.exec(text)) {
        const words = text.slice(from, end.index);
        const opens = words.lastIndexOf('![');

        if (opens !== -1 && !words.slice(opens + 2).includes(']')) {
            found.push({ did: end[1], version: end[2] });
        }
        from = end.index + end[0].length;
    }

    return found;
}

interface Described {
    title: string;
    line: string;
    kind: 'article' | 'profile';
    // The image's path under the service's API.
    image?: string;
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

async function publicationAt(did: string, site: string, previews: Previews): Promise<Described | undefined> {
    const shown = await previews.publication(did);
    const object = shown?.memeplex;

    if (shown?.state !== 'published' || !object) {
        return undefined;
    }

    const cid = text((object.content as { cid?: unknown } | undefined)?.cid);
    const body = cid && previews.body ? await previews.body(cid).catch(() => undefined) ?? '' : '';
    const written = text(object.text) || body;
    const words = wordsOf(written);
    let image: string | undefined;

    // The first of what it embeds that is an image, and not a publication.
    for (const embed of previews.image ? embedsIn(written) : []) {
        if (await previews.image!(embed.did, embed.version).catch(() => false)) {
            image = `/api/v1/images/${encodeURIComponent(embed.did)}?versionId=${embed.version}`;
            break;
        }
    }
    const title = wordsOf(text(object.title));

    if (title) {
        return {
            title: short(title, TITLE),
            line: short(wordsOf(text(object.subtitle)) || wordsOf(text(object.summary)) || words, LINE),
            kind: 'article',
            image,
        };
    }

    const author = text(object.author);
    const name = wordsOf(await previews.name?.(author).catch(() => undefined) ?? '');

    return {
        title: `${name ? short(name, 60) : 'A post'} on ${site}`,
        line: short(words, LINE),
        kind: 'article',
        image,
    };
}

async function authorAt(did: string, site: string, previews: Previews): Promise<Described> {
    const name = wordsOf(await previews.name?.(did).catch(() => undefined) ?? '');

    return {
        title: `${name ? short(name, 60) : 'An author'} on ${site}`,
        line: `What ${name ? short(name, 60) : 'this author'} has published on ${site}.`,
        kind: 'profile',
        image: `/api/v1/avatars/${encodeURIComponent(did)}`,
    };
}

// What a page says of itself in its head.
export function headOf(described: Described, site: string, address?: string, root?: string): string {
    const tags: [string, string, string][] = [
        ['name', 'description', described.line],
        ['property', 'og:site_name', site],
        ['property', 'og:type', described.kind],
        ['property', 'og:title', described.title],
        ['property', 'og:description', described.line],
        ...(address ? [['property', 'og:url', address] as [string, string, string]] : []),
        ...(root && described.image ? [['property', 'og:image', `${root}${described.image}`] as [string, string, string]] : []),
        // A card with the image large is for an article's own image, and not for a face.
        ['name', 'twitter:card', root && described.image && described.kind === 'article' ? 'summary_large_image' : 'summary'],
        ['name', 'twitter:title', described.title],
        ['name', 'twitter:description', described.line],
    ];

    return [
        `<title>${escape(described.title)}</title>`,
        ...tags.filter(([, , content]) => content).map(([kind, name, content]) => `<meta ${kind}="${name}" content="${escape(content)}" />`),
    ].join('\n    ');
}

export function pageRoutes({ pagesDir, site, publicURL, previews, isDid }: PageOptions): express.Router {
    // A path with a slash after it is another address, from which the page's
    // files would be looked for a directory further down.
    const router = express.Router({ strict: true });
    const root = publicURL?.replace(/\/+$/, '');

    // The page, with its files found from where it is served: they are named
    // relative to the pages' directory, which is `up` from here.
    const page = async (res: Response, up: string, head?: string): Promise<void> => {
        let html: string;

        try {
            html = await readFile(join(pagesDir, 'index.html'), 'utf8');
        }
        catch {
            res.status(404).json({ error: 'no such page' });
            return;
        }

        html = html.replace(/(\s(?:src|href)=")\.\//g, `$1${up}`);
        if (head) {
            html = html.replace(/<title>[^<]*<\/title>/, () => head);
        }
        res.setHeader('Cache-Control', 'no-cache');
        res.type('html').send(html);
    };

    const serve = (up: string, describe: (did: string, known: Previews) => Promise<Described | undefined>) => async (req: Request, res: Response) => {
        const did = String(req.params.did);
        let described: Described | undefined;

        if (previews && isDid(did)) {
            // What cannot be read is a page that says nothing of itself.
            described = await describe(did, previews).catch(() => undefined);
        }
        await page(res, up, described && headOf(described, site, root && `${root}${req.path}`, root));
    };

    router.get('/p/:did', serve('../', (did, known) => publicationAt(did, site, known)));
    router.get('/a/:did', serve('../', (did, known) => authorAt(did, site, known)));
    router.get('/a/:did/replies', serve('../../', (did, known) => authorAt(did, site, known)));

    return router;
}
