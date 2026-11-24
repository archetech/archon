import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import Markdown, { EMBED_LIMIT, Embeds, embedOf, safeUrl } from '../Markdown';
import type { Embedding } from '../Markdown';

// Text as Memeplex says a client shows it: docs/plans/memeplex-reference-1436.md,
// "Text formatting". What is written here is by strangers.

const shown = (text: string) => render(<Markdown text={text} />).container;
// The scheme of an address that runs what follows it.
const SCRIPT = ['java', 'script'].join('');

describe('GitHub Flavored Markdown', () => {
    it('lays out headings, emphasis, lists and code', () => {
        const page = shown('# A heading\n\nSome **bold** and *slanted* words, and `code`.\n\n- one\n- two\n\n```\nblock\n```\n');

        expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('A heading');
        expect(page.querySelector('strong')?.textContent).toBe('bold');
        expect(page.querySelector('em')?.textContent).toBe('slanted');
        expect(screen.getAllByRole('listitem').map(item => item.textContent)).toStrictEqual(['one', 'two']);
        expect(page.querySelector('pre code')?.textContent).toBe('block\n');
        expect(page.textContent).not.toMatch(/[#*`]/);
    });

    it('lays out what GFM adds: tables, strikethrough, task lists and bare addresses', () => {
        const page = shown('| a | b |\n|---|---|\n| 1 | 2 |\n\n~~gone~~\n\n- [x] done\n- [ ] not yet\n\nSee https://example.org/page for more.');

        expect(screen.getAllByRole('cell').map(cell => cell.textContent)).toStrictEqual(['1', '2']);
        expect(page.querySelector('del')?.textContent).toBe('gone');
        expect(screen.getAllByRole('checkbox').map(box => (box as HTMLInputElement).checked)).toStrictEqual([true, false]);
        expect(screen.getByRole('link', { name: 'https://example.org/page' }).getAttribute('href')).toBe('https://example.org/page');
    });

    it('shows a plain line as it is', () => {
        expect(shown('Every post is a DID.').textContent).toBe('Every post is a DID.');
    });
});

describe('what a stranger cannot do with text', () => {
    it('shows HTML as the text it is, and makes no element of it', () => {
        const page = shown('Before <script>window.pwned = 1</script> <img src="https://tracker.example/x.png" onerror="window.pwned = 1"> <b>after</b>\n\n<iframe src="https://example.org"></iframe>');

        for (const tag of ['script', 'img', 'iframe', 'b']) {
            expect(page.querySelector(tag)).toBeNull();
        }
        expect(page.textContent).toContain('<script>window.pwned = 1</script>');
        expect(page.textContent).toContain('<iframe src="https://example.org"></iframe>');
        expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
    });

    it.each([
        ['a script', `${SCRIPT}:alert(1)`],
        ['a script, however it is cased or spaced', ` ${SCRIPT.replace(/[acit]/g, letter => letter.toUpperCase())}:alert(1)`],
        ['data', 'data:text/html,alert(1)'],
        ['plain http', 'http://example.org/'],
        ['a file', 'file:///etc/passwd'],
        ['a relative address', '/memepool/api/v1/logout'],
        ['an address with no scheme', '//example.org/'],
    ])('follows no link to %s, and leaves the words it was on', (_name, url) => {
        expect(safeUrl(url)).toBe('');

        const page = shown(`[the words](${url.trim()})`);

        expect(page.querySelector('a')).toBeNull();
        expect(page.textContent).toContain('the words');
    });

    it('follows a link to an https address, in another tab and saying nothing of where it came from', () => {
        shown('[a page](https://example.org/a?b=c#d)');
        const link = screen.getByRole('link', { name: 'a page' });

        expect(link.getAttribute('href')).toBe('https://example.org/a?b=c#d');
        expect(link.getAttribute('target')).toBe('_blank');
        expect(link.getAttribute('rel')).toBe('noreferrer noopener');
    });

    it('shows a link to a DID as its words, which a browser has nowhere to follow', () => {
        const page = shown('[this post](did:cid:bagaaieraexample)');

        expect(page.querySelector('a')).toBeNull();
        expect(screen.getByText('this post').getAttribute('title')).toBe('did:cid:bagaaieraexample');
    });

    it('makes one link of an image that is the words of a link, to where the author pointed', () => {
        const page = shown('[![a chart](https://example.org/chart.png)](https://example.org/article)');

        expect(page.querySelectorAll('a')).toHaveLength(1);
        expect(screen.getByRole('link', { name: 'a chart' }).getAttribute('href')).toBe('https://example.org/article');
        expect(page.querySelector('img')).toBeNull();
    });

    it.each([
        ['a DID', 'did:cid:bagaaieraexample'],
        ['an address that is not followed', `${SCRIPT}:alert(1)`],
        ['a relative address', '/memepool/api/v1/logout'],
    ])('makes no link of an image that is the words of a link to %s', (_name, url) => {
        const page = shown(`[![a chart](https://tracker.example/chart.png)](${url})`);

        expect(page.querySelector('a')).toBeNull();
        expect(page.querySelector('img')).toBeNull();
        expect(page.textContent).toContain('a chart');
    });

    it('loads no image, from anywhere', () => {
        const page = shown('![a chart](https://tracker.example/chart.png) ![a photo](did:cid:bagaaieraphoto?versionId=bafyreiaaaa) ![](data:image/png;base64,AAAA) ![local](/x.png)');

        // Nothing a browser would fetch.
        expect(page.querySelector('img')).toBeNull();
        expect(page.querySelectorAll('[src]')).toHaveLength(0);
        // An https image is a link the reader may follow, by its description.
        expect(screen.getByRole('link', { name: 'a chart' }).getAttribute('href')).toBe('https://tracker.example/chart.png');
        // An embed is shown by its description, and the rest by a word for what was there.
        expect(screen.getByText('a photo').getAttribute('title')).toBe('did:cid:bagaaieraphoto?versionId=bafyreiaaaa');
        expect(screen.getByText('local')).toBeTruthy();
        expect(screen.getAllByText('image')).toHaveLength(1);
    });
});

// An embed is an image whose address is a DID and a version of it. What it
// shows depends on what the DID is.
describe('an embed', () => {
    const POST = 'did:cid:bagaaierapostpostpostpost';
    const IMAGE = 'did:cid:bagaaieraimageimageimage';
    const embedding = (objects: Record<string, unknown> = {}) => {
        const asked: string[] = [];
        const value: Embedding = {
            object: async (did, version) => { asked.push(`${did} ${version}`); return objects[`${did} ${version}`]; },
            image: (did, version) => `/images/${did}?versionId=${version}`,
            card: object => <blockquote>{String((object as { text: string }).text)}</blockquote>,
        };

        return { value, asked };
    };
    const shownWith = (text: string, value: Embedding, embeds = true) =>
        render(<Embeds.Provider value={value}><Markdown text={text} embeds={embeds} /></Embeds.Provider>).container;

    it('is told from other addresses by a DID and a version, and nothing more', () => {
        expect(embedOf(`${POST}?versionId=bafyv1`)).toStrictEqual({ did: POST, version: 'bafyv1' });

        for (const not of [POST, `${POST}?versionId=`, `${POST}?versionId=a&x=1`, `${POST}?versionId=a#b`, `${POST}/path?versionId=a`, `https://example.org/?versionId=a`, `${POST}?version=a`]) {
            expect(embedOf(not)).toBeUndefined();
        }
    });

    it('shows an object as a card, with what that version said', async () => {
        const { value, asked } = embedding({ [`${POST} bafyv1`]: { text: 'What was said.' } });
        const page = shownWith(`Before.\n\n![a post](${POST}?versionId=bafyv1)\n\nAfter.`, value);

        expect((await screen.findByText('What was said.')).closest('.embed.card')).not.toBeNull();
        expect(asked).toStrictEqual([`${POST} bafyv1`]);
        expect(page.querySelector('img')).toBeNull();
        expect(page.textContent).toContain('Before.');
        expect(page.textContent).toContain('After.');
    });

    it('shows an image asset as the image, from the service and nowhere else, by its words when it cannot be', async () => {
        const { value } = embedding();
        const page = shownWith(`![a chart](${IMAGE}?versionId=bafyv1)`, value);
        await waitFor(() => expect(page.querySelector('img')).not.toBeNull());
        const image = page.querySelector('img') as HTMLImageElement;

        expect(image.getAttribute('src')).toBe(`/images/${IMAGE}?versionId=bafyv1`);
        expect(image.getAttribute('alt')).toBe('a chart');

        // The service serves no such image.
        fireEvent.error(image);
        expect(page.querySelector('img')).toBeNull();
        expect(screen.getByText('a chart').getAttribute('title')).toBe(`${IMAGE}?versionId=bafyv1`);
    });

    it('says so when the version embedded is no longer in the object\'s history, and shows no other', async () => {
        const { value } = embedding({ [`${POST} bafygone`]: 'no-revision' });
        const page = shownWith(`![a post](${POST}?versionId=bafygone)`, value);

        expect(await screen.findByText(/a post: this version is no longer in its history/)).toBeTruthy();
        expect(page.querySelector('img')).toBeNull();
    });

    it('may give its address apart from itself, in each way Markdown allows', async () => {
        const { value, asked } = embedding({ [`${POST} bafyv1`]: { text: 'Quoted.' } });
        const page = shownWith(`![a post][one]\n\n![two][]\n\n![three]\n\n![nowhere][none]\n\n[one]: ${POST}?versionId=bafyv1\n[two]: ${IMAGE}?versionId=bafyv2\n[three]: ${IMAGE}?versionId=bafyv3`, value);

        expect((await screen.findByText('Quoted.')).closest('.embed.card')).not.toBeNull();
        await waitFor(() => expect(page.querySelectorAll('img')).toHaveLength(2));
        expect([...page.querySelectorAll('img')].map(each => each.getAttribute('alt'))).toStrictEqual(['two', 'three']);
        expect(asked).toStrictEqual([`${POST} bafyv1`, `${IMAGE} bafyv2`, `${IMAGE} bafyv3`]);
        // A name with no address is the text it is.
        expect(page.textContent).toContain('![nowhere][none]');
    });

    it('is read anew when what it is shown in is, and shows what it showed meanwhile', async () => {
        const objects: Record<string, unknown> = {};
        const { value, asked } = embedding(objects);
        const text = `![a post](${POST}?versionId=bafyv1)`;
        const view = render(<Embeds.Provider value={{ ...value, read: 1 }}><Markdown text={text} /></Embeds.Provider>);

        // The indexer has no such object yet: it may be an image, and the service has none.
        await waitFor(() => expect(view.container.querySelector('img')).not.toBeNull());
        fireEvent.error(view.container.querySelector('img')!);
        expect(screen.getByText('a post')).toBeTruthy();

        objects[`${POST} bafyv1`] = { text: 'Quoted.' };
        view.rerender(<Embeds.Provider value={{ ...value, read: 2 }}><Markdown text={text} /></Embeds.Provider>);
        expect(await screen.findByText('Quoted.')).toBeTruthy();

        // A replay puts the version out of the history.
        objects[`${POST} bafyv1`] = 'no-revision';
        view.rerender(<Embeds.Provider value={{ ...value, read: 3 }}><Markdown text={text} /></Embeds.Provider>);
        expect(screen.queryByText('Reading what is embedded.')).toBeNull();
        expect(await screen.findByText(/this version is no longer in its history/)).toBeTruthy();
        expect(screen.queryByText('Quoted.')).toBeNull();
        expect(asked).toHaveLength(3);
    });

    it('is ended a paragraph for and taken up after, so that a card is in no paragraph', async () => {
        const { value } = embedding({ [`${POST} bafyv1`]: { text: 'Quoted.' } });
        const page = shownWith(`As ![a post](${POST}?versionId=bafyv1) says, and so on.`, value);

        await screen.findByText('Quoted.');
        expect([...page.querySelectorAll('.markdown > p')].map(each => each.textContent)).toStrictEqual(['As ', ' says, and so on.']);
        expect(page.querySelector('p .card')).toBeNull();
        expect(page.querySelector('p blockquote')).toBeNull();
    });

    it('is shown by its words in a heading, a table or the words of a link, and with no version', async () => {
        const { value, asked } = embedding({ [`${POST} bafyv1`]: { text: 'Quoted.' } });
        const embed = `![a post](${POST}?versionId=bafyv1)`;
        const page = shownWith(`# ${embed}\n\n| a |\n|---|\n| ${embed} |\n\n[${embed}](https://example.org/)\n\n![no version](${POST})`, value);

        await waitFor(() => expect(screen.getAllByText('a post').length).toBeGreaterThanOrEqual(2));
        expect(page.querySelector('.card')).toBeNull();
        expect(page.querySelector('img')).toBeNull();
        expect(screen.getByText('no version')).toBeTruthy();
        expect(asked).toStrictEqual([]);
    });

    it('is shown as what it is only so many times in one text', async () => {
        const { value, asked } = embedding();
        const page = shownWith(Array.from({ length: EMBED_LIMIT + 3 }, (_, index) => `![image ${index}](${IMAGE}?versionId=bafyv${index})`).join('\n\n'), value);

        await waitFor(() => expect(page.querySelectorAll('img')).toHaveLength(EMBED_LIMIT));
        expect(asked).toHaveLength(EMBED_LIMIT);
        expect(screen.getByText(`image ${EMBED_LIMIT + 2}`)).toBeTruthy();
    });

    it('is shown by its words where embeds are not shown, as inside a card, and where nothing shows them', () => {
        const { value, asked } = embedding({ [`${POST} bafyv1`]: { text: 'Quoted.' } });
        const inside = shownWith(`![a post](${POST}?versionId=bafyv1)`, value, false);

        expect(inside.querySelector('.card')).toBeNull();
        expect(screen.getByText('a post')).toBeTruthy();
        expect(asked).toStrictEqual([]);
    });
});
