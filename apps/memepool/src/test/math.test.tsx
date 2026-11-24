import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import Markdown, { MATH_LIMIT } from '../Markdown';

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
