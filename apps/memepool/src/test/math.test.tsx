import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import Markdown, { Embeds, MATH_LIMIT } from '../Markdown';
import type { Embedding } from '../Markdown';

// Math as Memeplex says a client shows it: docs/plans/memeplex-reference-1436.md,
// "Text formatting". It is written between dollars, as in Pandoc, Jupyter and
// GitHub, and is LaTeX that a stranger wrote.

const shown = (text: string) => render(<Markdown text={text} />).container;
const math = (page: HTMLElement) => [...page.querySelectorAll('.katex')];
// What was written, which KaTeX keeps beside what it renders.
const latex = (element: Element) => element.querySelector('annotation')?.textContent?.trim();
const apart = (element: Element) => element.closest('.katex-display') !== null;

describe('math', () => {
    it('is rendered in a line between single dollars', () => {
        const page = shown(String.raw`Euler wrote $e^{i\pi} + 1 = 0$ and it held.`);

        expect(math(page).map(latex)).toStrictEqual([String.raw`e^{i\pi} + 1 = 0`]);
        expect(math(page).map(apart)).toStrictEqual([false]);
        expect(page.querySelector('p')?.textContent?.startsWith('Euler wrote ')).toBe(true);
        expect(page.querySelector('p')?.textContent?.endsWith(' and it held.')).toBe(true);
    });

    it('is set apart between double dollars, in a line or on lines of its own, and in a block marked math', () => {
        const page = shown([
            String.raw`In a line: $$\int_0^1 x\,dx$$`,
            '',
            '$$',
            'x^2',
            '$$',
            '',
            '```math',
            String.raw`\frac{a}{b}`,
            '```',
        ].join('\n'));

        expect(math(page).map(latex)).toStrictEqual([String.raw`\int_0^1 x\,dx`, 'x^2', String.raw`\frac{a}{b}`]);
        expect(math(page).map(apart)).toStrictEqual([true, true, true]);
    });

    it('keeps its own marks: an underscore and a star are the math\'s, and not Markdown\'s', () => {
        const page = shown('$a_1 * b_2 * c_3$');

        expect(math(page).map(latex)).toStrictEqual(['a_1 * b_2 * c_3']);
        expect(page.querySelector('em')).toBeNull();
    });

    it.each([
        ['two prices', 'it costs $5 and $10', 'it costs $5 and $10'],
        ['a space after the opening dollar', 'p $ x$ q', 'p $ x$ q'],
        ['a space before the closing dollar', 'p $x $ q', 'p $x $ q'],
        ['a digit after the closing dollar', 'from $5$6 a head', 'from $5$6 a head'],
        ['dollars that are escaped', String.raw`that is \$5 and \$6`, 'that is $5 and $6'],
        ['dollars in code', 'in `code $x$` here', 'in code $x$ here'],
    ])('leaves %s as the text it is', (_name, text, read) => {
        const page = shown(text);

        expect(math(page)).toHaveLength(0);
        expect(page.textContent).toBe(read);
    });

    it('reads what is between dollars that are not math as the Markdown it is', () => {
        const page = shown('a $ **bold** $ and $ [a link](https://example.org/) $ and $ <b>not bold</b> $ end');

        expect(math(page)).toHaveLength(0);
        expect(page.querySelector('strong')?.textContent).toBe('bold');
        expect(page.querySelector('a')?.getAttribute('href')).toBe('https://example.org/');
        // And under the same rules as any text: HTML is shown as the text it is.
        expect(page.querySelector('b')).toBeNull();
        expect(page.textContent).toBe('a $ bold $ and $ a link $ and $ <b>not bold</b> $ end');
    });

    it('renders math that comes after a dollar that is not math', () => {
        const page = shown('It costs $5, and $x^2$ is math, as is $y$; so $6 is not.');

        expect(math(page).map(latex)).toStrictEqual(['x^2', 'y']);
        expect(page.textContent?.startsWith('It costs $5, and ')).toBe(true);
        expect(page.textContent?.endsWith('; so $6 is not.')).toBe(true);
    });

    it('does so inside emphasis, a list and a heading', () => {
        const page = shown('**costs $5 and $a$**\n\n- costs $5 and $b$\n\n# Costs $5 and $c$');

        expect(math(page).map(latex)).toStrictEqual(['a', 'b', 'c']);
        expect(page.querySelector('strong')?.textContent?.startsWith('costs $5 and ')).toBe(true);
        expect(page.querySelectorAll('li')).toHaveLength(1);
        expect(page.querySelector('h1')?.textContent?.startsWith('Costs $5 and ')).toBe(true);
    });

    it('still names a link and an image by an address given elsewhere in the text', () => {
        const page = shown([
            'Costs $5 and $x$, see [the site][ref] and ![a chart][pic].',
            '',
            '[ref]: https://example.org/',
            '[pic]: https://example.org/chart.png',
        ].join('\n'));

        expect(math(page).map(latex)).toStrictEqual(['x']);
        expect([...page.querySelectorAll('a')].map(each => [each.textContent, each.getAttribute('href')])).toStrictEqual([
            ['the site', 'https://example.org/'],
            // An image elsewhere is a link the reader may follow, and is not loaded.
            ['a chart', 'https://example.org/chart.png'],
        ]);
        expect(page.querySelector('img')).toBeNull();
        // The addresses are given once, and are no part of what is shown.
        expect(page.textContent).not.toContain('[ref]');
        expect(page.textContent?.startsWith('Costs $5 and ')).toBe(true);
    });

    it('still shows an embed whose address is given elsewhere, after a dollar that is not math', async () => {
        const asked: string[] = [];
        const embedding: Embedding = {
            object: async (did, version) => { asked.push(`${did} ${version}`); return { text: 'Quoted.' }; },
            image: () => '',
            card: object => <blockquote>{String((object as { text: string }).text)}</blockquote>,
        };

        render(
            <Embeds.Provider value={embedding}>
                <Markdown text={'Costs $5, and see:\n\n![a post][quoted]\n\nIt costs $6 too: ![again][quoted]\n\n[quoted]: did:cid:bagaaieraquoted?versionId=bafyv1'} />
            </Embeds.Provider>,
        );

        await waitFor(() => expect(screen.getAllByText('Quoted.')).toHaveLength(2));
        expect(asked).toStrictEqual(['did:cid:bagaaieraquoted bafyv1', 'did:cid:bagaaieraquoted bafyv1']);
    });

    it('reads a text of nothing but dollars only so many times, and loses none of it', () => {
        const text = Array.from({ length: 200 }, (_, index) => `$ ${index} $`).join(' ');
        const page = shown(text);

        expect(math(page)).toHaveLength(0);
        expect(page.textContent).toBe(text);
    });

    it('runs no command that reaches outside the math', () => {
        const page = shown([
            String.raw`$\href{javascript:alert(1)}{x}$`,
            String.raw`$\url{https://tracker.example/}$`,
            String.raw`$\includegraphics{https://tracker.example/x.png}$`,
            String.raw`$\htmlClass{top}{x}$`,
            String.raw`$\htmlData{a=b}{x}$`,
            String.raw`$\htmlStyle{position:fixed}{x}$`,
        ].join(' '));

        expect(page.querySelector('a')).toBeNull();
        expect(page.querySelector('img')).toBeNull();
        expect(page.querySelectorAll('[href], [src], [data-a]')).toHaveLength(0);
        expect(page.querySelector('.top')).toBeNull();
        expect([...page.querySelectorAll('[style]')].some(each => /position/.test(each.getAttribute('style') ?? ''))).toBe(false);
    });

    it('shows math that cannot be rendered as it was written, and makes no element of HTML in it', () => {
        const page = shown([String.raw`$\frac{a}{$`, String.raw`$\notacommand{x}$`, '$<img src=x onerror=alert(1)>$'].join(' and '));

        expect(page.querySelector('img')).toBeNull();
        expect(page.textContent).toContain(String.raw`\frac{a}{`);
        expect(page.textContent).toContain(String.raw`\notacommand`);
        expect(page.textContent).toContain('<img src=x onerror=alert(1)>');
    });

    it('does not let a macro grow without end', () => {
        const page = shown(String.raw`$\def\x{\x\x}\x$`);

        // KaTeX refuses it, and it is shown as written.
        expect(page.querySelector('.katex-html')).toBeNull();
        expect(page.textContent).toContain(String.raw`\def\x{\x\x}\x`);
    });

    it('renders no more than so much, and shows the rest as written', () => {
        const long = 'x'.repeat(MATH_LIMIT + 1);
        const page = shown(`$${long}$\n\n$$\n${long.replace(/x/g, 'y')}\n$$\n\n\`\`\`math\n${long.replace(/x/g, 'z')}\n\`\`\``);

        expect(math(page)).toHaveLength(0);
        expect(page.textContent).toContain(long);
        expect([...page.querySelectorAll('pre code')].map(each => each.textContent?.trim().charAt(0))).toStrictEqual(['y', 'z']);
    });

    it('is rendered beside the rest of Markdown, and inside what a card shows', () => {
        const page = render(<Markdown text={'A **bold** claim: $x < y$.\n\n- one $a$\n- two'} embeds={false} />).container;

        expect(math(page).map(latex)).toStrictEqual(['x < y', 'a']);
        expect(page.querySelector('strong')?.textContent).toBe('bold');
        expect(page.querySelectorAll('li')).toHaveLength(2);
    });
});
