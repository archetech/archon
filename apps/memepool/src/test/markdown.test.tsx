import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import Markdown, { safeUrl } from '../Markdown';

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
