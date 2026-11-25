import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { embedsIn, headOf, pageRoutes, wordsOf } from '../../services/memepool/src/pages.ts';
import type { Previews, Shown } from '../../services/memepool/src/pages.ts';

// The page at the address of a publication or an author: what it says of
// itself to whatever shows a link to it, which reads the page's head and runs
// none of its script.

const ALICE = 'did:cid:bagaaieraalice';
const POST = 'did:cid:bagaaierapost';
const ARTICLE = 'did:cid:bagaaieraarticle';
const IMAGE = 'did:cid:bagaaieraimage';

// The page as the build makes it.
const BUILT = `<!doctype html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <title>Memepool</title>
  <script type="module" crossorigin src="./assets/index-abc.js"></script>
  <link rel="stylesheet" crossorigin href="./assets/index-abc.css">
</head>
<body>
<div id="root"></div>
</body>
</html>
`;

let dir: string;
let known: Record<string, Shown>;
let bodies: Record<string, string>;
let names: Record<string, string>;
let asked: string[];
let checked: string[];

const previews: Previews = {
    publication: async did => { asked.push(did); return known[did]; },
    body: async cid => bodies[cid],
    name: async did => names[did],
    image: async (did, version) => { checked.push(`${did} ${version}`); return did === IMAGE; },
};

const isDid = (did: string) => /^did:[a-z0-9]+:[A-Za-z0-9._%-]{1,200}$/.test(did);

function app(options: { publicURL?: string; previews?: Previews } = { publicURL: 'https://node.example/memepool', previews }) {
    const made = express();

    made.use(pageRoutes({ pagesDir: dir, site: 'Memepool', isDid, ...options }));

    return made;
}

const tag = (html: string, name: string): string | undefined =>
    new RegExp(`<meta (?:property|name)="${name}" content="([^"]*)" />`).exec(html)?.[1];

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memepool-pages-'));
    writeFileSync(join(dir, 'index.html'), BUILT);
    asked = [];
    checked = [];
    bodies = { bafybody: `# Heading\n\nThe *first* line of the [body](https://example.org), at length.\n\n![a chart](${IMAGE}?versionId=bafyversion)\n` };
    names = { [ALICE]: 'Alice A.' };
    known = {
        [POST]: { state: 'published', memeplex: { kind: 'post', author: ALICE, text: 'Just **words**, and a [link](https://example.org).' } },
        [ARTICLE]: {
            state: 'published',
            memeplex: { kind: 'post', author: ALICE, title: 'Rights Do Not Dilute', subtitle: 'A fear of utilitarian arithmetic', content: { cid: 'bafybody', type: 'text/markdown', bytes: 100 } },
        },
    };
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe('the page at the address of a publication', () => {
    it('says what an article is: its title, its subtitle, and the first image it embeds', async () => {
        const answer = await request(app()).get(`/p/${ARTICLE}`);

        expect(answer.status).toBe(200);
        expect(answer.headers['content-type']).toContain('text/html');
        expect(answer.headers['cache-control']).toBe('no-cache');
        expect(answer.text).toContain('<title>Rights Do Not Dilute</title>');
        expect(answer.text).not.toContain('<title>Memepool</title>');
        expect(tag(answer.text, 'og:title')).toBe('Rights Do Not Dilute');
        expect(tag(answer.text, 'og:description')).toBe('A fear of utilitarian arithmetic');
        expect(tag(answer.text, 'description')).toBe('A fear of utilitarian arithmetic');
        expect(tag(answer.text, 'og:site_name')).toBe('Memepool');
        expect(tag(answer.text, 'og:type')).toBe('article');
        expect(tag(answer.text, 'og:url')).toBe(`https://node.example/memepool/p/${ARTICLE}`);
        expect(tag(answer.text, 'og:image')).toBe(`https://node.example/memepool/api/v1/images/${encodeURIComponent(IMAGE)}?versionId=bafyversion`);
        expect(tag(answer.text, 'twitter:card')).toBe('summary_large_image');
    });

    it('takes for its image the first thing the text embeds that is an image, and not a post it quotes or what is written as code', async () => {
        bodies.bafybody = [
            'A post is quoted first, which is embedded as an image is:',
            `![a post](${POST}?versionId=bafypost)`,
            '```',
            `![in code](${IMAGE}?versionId=bafycode)`,
            '```',
            `![the chart](${IMAGE}?versionId=bafychart)`,
        ].join('\n');

        const answer = (await request(app()).get(`/p/${ARTICLE}`)).text;

        expect(tag(answer, 'og:image')).toBe(`https://node.example/memepool/api/v1/images/${encodeURIComponent(IMAGE)}?versionId=bafychart`);
        expect(checked).toStrictEqual([`${POST} bafypost`, `${IMAGE} bafychart`]);

        // Where none of them is an image, the page names none.
        bodies.bafybody = `![a post](${POST}?versionId=bafypost)`;
        expect(tag((await request(app()).get(`/p/${ARTICLE}`)).text, 'og:image')).toBeUndefined();
    });

    it('is no page with a slash after its address, from which its files would not be found', async () => {
        for (const path of [`/p/${ARTICLE}/`, `/a/${ALICE}/`, `/a/${ALICE}/replies/`]) {
            const answer = await request(app()).get(path);

            expect([path, answer.status]).toStrictEqual([path, 404]);
        }
    });

    it('reads a text made to be slow to read no slower than any other', async () => {
        const started = Date.now();

        for (const hostile of ['!['.repeat(100_000), '['.repeat(200_000), '```'.repeat(60_000), `${'*'.repeat(100_000)}](`, '](did:cid:x?versionId='.repeat(8_000)]) {
            bodies.bafybody = hostile;
            known[ARTICLE].memeplex = { ...known[ARTICLE].memeplex, subtitle: undefined };
            expect((await request(app()).get(`/p/${ARTICLE}`)).status).toBe(200);
        }
        expect(Date.now() - started).toBeLessThan(3000);
    });

    it('is the page the script shows the publication in, with its files found from there', async () => {
        const answer = await request(app()).get(`/p/${ARTICLE}`);

        expect(answer.text).toContain('<div id="root"></div>');
        expect(answer.text).toContain('src="../assets/index-abc.js"');
        expect(answer.text).toContain('href="../assets/index-abc.css"');
        expect(answer.text).not.toContain('"./assets');
    });

    it('takes an article\'s line from its body where it has no subtitle, and a post\'s from its words', async () => {
        known[ARTICLE].memeplex = { ...known[ARTICLE].memeplex, subtitle: undefined };

        expect(tag((await request(app()).get(`/p/${ARTICLE}`)).text, 'og:description')).toBe('Heading The first line of the body, at length.');

        const posted = (await request(app()).get(`/p/${POST}`)).text;

        // A post has no title: it is named for who wrote it, by the name they give themselves.
        expect(tag(posted, 'og:title')).toBe('Alice A. on Memepool');
        expect(tag(posted, 'og:description')).toBe('Just words, and a link.');
        expect(tag(posted, 'og:image')).toBeUndefined();
        expect(tag(posted, 'twitter:card')).toBe('summary');

        names = {};
        expect(tag((await request(app()).get(`/p/${POST}`)).text, 'og:title')).toBe('A post on Memepool');
    });

    it('cuts a long line, and writes nothing of a stranger\'s as markup', async () => {
        known[POST].memeplex = { kind: 'post', author: ALICE, text: `"><script>alert(1)</script> & ${'word '.repeat(100)}` };
        names[ALICE] = '<b>Alice</b> "A"';

        const answer = (await request(app()).get(`/p/${POST}`)).text;
        const line = tag(answer, 'og:description')!;

        expect(answer).not.toContain('<script>alert');
        expect(answer).not.toContain('<b>Alice');
        expect(line.startsWith('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp; word')).toBe(true);
        expect(line.endsWith('…')).toBe(true);
        expect(tag(answer, 'og:title')).toBe('&lt;b&gt;Alice&lt;/b&gt; &quot;A&quot; on Memepool');
        expect(answer).toContain('<title>&lt;b&gt;Alice&lt;/b&gt; &quot;A&quot; on Memepool</title>');
    });

    it('is the page as it is, saying nothing of itself, for what is not published or cannot be read', async () => {
        known['did:cid:bagaaierawithdrawn'] = { state: 'withdrawn' };
        known['did:cid:bagaaierapending'] = { state: 'pending', memeplex: { kind: 'post', author: ALICE, text: 'Not yet.' } };

        for (const did of ['did:cid:bagaaieranone', 'did:cid:bagaaierawithdrawn', 'did:cid:bagaaierapending']) {
            const answer = await request(app()).get(`/p/${did}`);

            expect([did, answer.status]).toStrictEqual([did, 200]);
            expect(answer.text).toContain('<title>Memepool</title>');
            expect(answer.text).toContain('src="../assets/index-abc.js"');
            expect(answer.text).not.toContain('og:title');
            expect(answer.text).not.toContain('Not yet.');
        }

        // An indexer that cannot be reached is no reason to serve no page.
        const failing = app({ publicURL: 'https://node.example/memepool', previews: { publication: async () => { throw new Error('no indexer'); } } });
        const unread = await request(failing).get(`/p/${POST}`);

        expect(unread.status).toBe(200);
        expect(unread.text).toContain('<title>Memepool</title>');

        // Nor is a service with no indexer to ask.
        expect((await request(app({})).get(`/p/${POST}`)).text).toContain('<title>Memepool</title>');
    });

    it('asks the indexer for nothing that has not the shape of a DID', async () => {
        for (const did of ['not-a-did', 'did:cid:x/../../api/v1/me', 'did:cid:']) {
            const answer = await request(app()).get(`/p/${encodeURIComponent(did)}`);

            expect([did, answer.status]).toStrictEqual([did, 200]);
            expect(answer.text).toContain('<title>Memepool</title>');
        }
        expect(asked).toStrictEqual([]);
    });

    it('names no address of its own and no image where the service does not know its own address', async () => {
        const answer = (await request(app({ previews })).get(`/p/${ARTICLE}`)).text;

        expect(tag(answer, 'og:title')).toBe('Rights Do Not Dilute');
        expect(tag(answer, 'og:url')).toBeUndefined();
        expect(tag(answer, 'og:image')).toBeUndefined();
        expect(tag(answer, 'twitter:card')).toBe('summary');
    });
});

describe('the page at the address of an author', () => {
    it('names the author, with their avatar, for their posts and for their replies', async () => {
        const posts = (await request(app()).get(`/a/${ALICE}`)).text;

        expect(tag(posts, 'og:title')).toBe('Alice A. on Memepool');
        expect(tag(posts, 'og:type')).toBe('profile');
        expect(tag(posts, 'og:description')).toBe('What Alice A. has published on Memepool.');
        expect(tag(posts, 'og:image')).toBe(`https://node.example/memepool/api/v1/avatars/${encodeURIComponent(ALICE)}`);
        expect(tag(posts, 'og:url')).toBe(`https://node.example/memepool/a/${ALICE}`);
        // A face is shown small.
        expect(tag(posts, 'twitter:card')).toBe('summary');
        expect(posts).toContain('src="../assets/index-abc.js"');

        const replies = (await request(app()).get(`/a/${ALICE}/replies`)).text;

        expect(tag(replies, 'og:title')).toBe('Alice A. on Memepool');
        // Its files are two directories up from there.
        expect(replies).toContain('src="../../assets/index-abc.js"');
    });

    it('names an author who gives no name as an author', async () => {
        names = {};

        expect(tag((await request(app()).get(`/a/${ALICE}`)).text, 'og:title')).toBe('An author on Memepool');
    });
});

describe('what a line about a text says', () => {
    it('is its words, without its marks', () => {
        expect(wordsOf('# A *heading*\n\n> quoted, with `code` and ~~struck~~\n\n- an item\n1. another')).toBe('A heading quoted, with code and struck an item another');
        expect(wordsOf('See [this](https://example.org) and ![an image](did:cid:x?versionId=y).')).toBe('See this and .');
        expect(wordsOf('before\n```js\nlet a = 1;\n```\nafter\u0007\ttabbed')).toBe('before after tabbed');
        expect(wordsOf('')).toBe('');
    });

    it('finds what a text embeds, in its order: each a DID at a version', () => {
        expect(embedsIn(`![one](${IMAGE}?versionId=bafyone) and ![two](${POST}?versionId=bafytwo)`)).toStrictEqual([
            { did: IMAGE, version: 'bafyone' }, { did: POST, version: 'bafytwo' },
        ]);
        expect(embedsIn('![remote](https://example.org/a.png)')).toStrictEqual([]);
        expect(embedsIn(`![no version](${IMAGE})`)).toStrictEqual([]);
        // A link is no embed, nor is what follows the end of other words.
        expect(embedsIn(`[a link](${IMAGE}?versionId=bafyone)`)).toStrictEqual([]);
        expect(embedsIn(`![words] then [a link](${IMAGE}?versionId=bafyone)`)).toStrictEqual([]);
        expect(embedsIn(`\`\`\`\n![in code](${IMAGE}?versionId=bafycode)\n\`\`\`\n![after](${IMAGE}?versionId=bafyafter)`)).toStrictEqual([{ did: IMAGE, version: 'bafyafter' }]);
        // No more than a few are taken, however many there are.
        expect(embedsIn(`![x](${IMAGE}?versionId=v) `.repeat(50))).toHaveLength(5);
    });

    it('is written into a head with nothing of it as markup', () => {
        const head = headOf({ title: 'A & B', line: '"quoted" <tag>', kind: 'article' }, 'Memepool');

        expect(head).toContain('<title>A &amp; B</title>');
        expect(head).toContain('content="&quot;quoted&quot; &lt;tag&gt;"');
    });
});
