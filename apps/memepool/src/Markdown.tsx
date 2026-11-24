import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

// Text as Memeplex says a client shows it: docs/plans/memeplex-reference-1436.md,
// "Text formatting". It is GitHub Flavored Markdown, and it is written by
// strangers, so three of that section's rules are about what is not done:
//
// - No raw HTML. The renderer builds elements from the Markdown and has no way
//   to make one from HTML in it, which is shown as the text it is.
// - Safe links only: `https:` and `did:`. Anything else is shown as its text.
// - Nothing is loaded from elsewhere. An image at an `https:` address would be
//   fetched by every reader's browser, which tells its host who is reading, so
//   it is shown as a link the reader may follow.
//
// An embed is an image whose address is a `did:` URL that names a version:
// `![words](did:cid:…?versionId=…)`. What it shows depends on what the DID is.
// An object is shown as a card, with what that version said. An image asset is
// shown as the image, which the pages' own service serves. Anything else, and
// a DID with no version, is shown by its words.
//
// Math is written as it is in Pandoc, Jupyter and GitHub: between single
// dollars in a line, between double dollars set apart, and in a fenced block
// marked `math`. It is LaTeX, which KaTeX renders to elements, with the
// commands that reach outside the math turned off. Math that cannot be
// rendered is shown as it was written.

const scheme = (url: string) => /^([a-z][a-z0-9+.-]*):/i.exec(url.trim())?.[1].toLowerCase();

// The address as it may be used, or nothing for one that may not.
export function safeUrl(url: string): string {
    const named = scheme(url);

    return named === 'https' || named === 'did' ? url.trim() : '';
}

// What an embed is of, where an address is one an embed can have: a DID and a
// version of it, and nothing more.
export function embedOf(url: string): { did: string; version: string } | undefined {
    const found = /^(did:[a-z0-9]+:[A-Za-z0-9._:%-]+)\?versionId=([A-Za-z0-9]+)$/.exec(url.trim());

    return found ? { did: found[1], version: found[2] } : undefined;
}

// How many embeds of one text are shown as what they are. The rest are shown
// by their words.
export const EMBED_LIMIT = 20;

// What shows an embed: the pages' way to an object at a version, to an image
// at one, and to a card for an object.
export interface Embedding {
    // The object as it was at the version, 'no-revision' where the version is
    // not in its history, and nothing where the DID is no object's.
    object: (did: string, version: string) => Promise<unknown | 'no-revision' | undefined>;
    // Where an image asset at a version is served from.
    image: (did: string, version: string) => string;
    // The card for an object that `object` gave.
    card: (object: unknown) => ReactNode;
    // Counts the reads of what the text is shown in. An embed is read anew at
    // each, and shows what it showed meanwhile.
    read?: number;
}

export const Embeds = createContext<Embedding | undefined>(undefined);

interface Node {
    type: string;
    value?: string;
    lang?: string | null;
    position?: { start: { offset?: number }; end: { offset?: number } };
    url?: string;
    alt?: string | null;
    identifier?: string;
    children?: Node[];
    data?: { hProperties?: Record<string, unknown> };
}

// Lifts embeds out of the paragraphs they are written in, up to a number of
// them. A card is not something a paragraph can hold, so a paragraph with an
// embed in it is ended before the embed and taken up after. An embed anywhere
// else, in a heading, a table or the words of a link, stays where it is and is
// shown by its words.
const liftEmbeds = (limit: number) => () => (tree: Node) => {
    let lifted = 0;
    // An image may give its address apart from itself, `![words][name]` with
    // `[name]: address` elsewhere in the text. It is the same image.
    const defined = new Map<string, string>();
    const define = (node: Node) => {
        if (node.type === 'definition' && node.identifier !== undefined && node.url !== undefined && !defined.has(node.identifier)) {
            defined.set(node.identifier, node.url);
        }
        node.children?.forEach(define);
    };
    const addressOf = (node: Node) =>
        (node.type === 'image' ? node.url : node.type === 'imageReference' ? defined.get(node.identifier ?? '') : undefined);
    const embeds = (node: Node) => embedOf(addressOf(node) ?? '') !== undefined;
    const walk = (parent: Node) => {
        // A node that holds nothing is given no list of what it holds: one
        // that is there and empty of meaning is read as a list by what follows.
        if (!parent.children) {
            return;
        }
        parent.children = parent.children.flatMap(child => {
            if (child.type !== 'paragraph' || !child.children?.some(embeds)) {
                walk(child);
                return [child];
            }

            const parts: Node[] = [];
            let run: Node[] = [];
            const end = () => {
                // White space alone between two embeds is no paragraph.
                if (run.some(each => each.type !== 'text' || (each as { value?: string }).value?.trim())) {
                    parts.push({ ...child, children: run });
                }
                run = [];
            };

            for (const each of child.children) {
                if (embeds(each) && lifted < limit) {
                    lifted += 1;
                    end();
                    parts.push({ type: 'image', url: addressOf(each), alt: each.alt, data: { ...each.data, hProperties: { ...each.data?.hProperties, 'data-embed': 'true' } } });
                }
                else {
                    run.push(each);
                }
            }
            end();

            return parts;
        });
    };

    define(tree);
    walk(tree);
};

// The longest math rendered, in characters of LaTeX. Longer is shown as written.
export const MATH_LIMIT = 4000;

const DOLLAR = String.fromCharCode(36);

// Says which dollars are math, before the text is read as Markdown.
//
// The parser takes any two dollars in a line for math, so a sentence naming
// two prices would be. The rule shared with Pandoc is narrower, and it is a
// rule about the dollars themselves, whatever Markdown is around them: a
// dollar opens math when something other than a space comes straight after
// it, and the next dollar closes that math when something other than a space
// comes straight before it and no digit after it. Math holds no dollar of its
// own, so a dollar is math only with the very next one, and only where both
// are as the rule says.
//
// Every other dollar is written with a backslash before it, which Markdown
// reads as the dollar alone. The parser is then left with the pairs that are
// math, and the text around them is Markdown as it would be anyway.
//
// Dollars in code, in math set apart on lines of its own, in HTML and in an
// address given apart from its link are left as they are: a backslash there
// would be shown.
//
// What is code is found by reading the text with no math in it, since a
// dollar before a span of code would otherwise be taken to open math that
// closes inside the span. Math set apart is found by reading it with math.
const plain = unified().use(remarkParse).use(remarkGfm);
const withMath = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
const BACKSLASH = String.fromCharCode(92);

export function settleDollars(text: string): string {
    if (!text.includes(DOLLAR)) {
        return text;
    }

    const left: [number, number][] = [];
    const leave = (kinds: string[]) => function each(node: Node): void {
        const from = node.position?.start.offset;
        const to = node.position?.end.offset;

        if (from !== undefined && to !== undefined && kinds.includes(node.type)) {
            left.push([from, to]);
            return;
        }
        node.children?.forEach(each);
    };

    const read = plain.parse(text) as unknown as Node;

    leave(['code', 'inlineCode', 'html', 'definition'])(read);
    leave(['math'])(withMath.parse(text) as unknown as Node);

    // An address written bare, with no brackets, is a link as it stands. A
    // dollar in one may be math, where it is one of a pair. Where it is not,
    // it is left without a backslash, which would become part of the address.
    const bare: [number, number][] = [];
    const addresses = (node: Node) => {
        const from = node.position?.start.offset;
        const to = node.position?.end.offset;

        if (node.type === 'link' && from !== undefined && to !== undefined && text.charAt(from) !== '[') {
            bare.push([from, to]);
        }
        node.children?.forEach(addresses);
    };

    addresses(read);

    const within = (at: number) => left.some(([from, to]) => at >= from && at < to);
    // The runs of dollars that may be math: outside what is left alone, and
    // with no backslash already before them.
    const runs: { at: number; length: number }[] = [];

    for (let at = 0; at < text.length; at += 1) {
        if (text.charAt(at) !== DOLLAR || within(at)) {
            continue;
        }

        let slashes = 0;

        while (text.charAt(at - 1 - slashes) === BACKSLASH) {
            slashes += 1;
        }

        // A backslash is before this dollar alone: the next may open math.
        if (slashes % 2 === 1) {
            continue;
        }

        let length = 1;

        while (text.charAt(at + length) === DOLLAR && !within(at + length)) {
            length += 1;
        }
        runs.push({ at, length });
        at += length - 1;
    }

    const opens = ({ at, length }: { at: number; length: number }) => /\S/.test(text.charAt(at + length));
    const closes = ({ at, length }: { at: number; length: number }) => /\S/.test(text.charAt(at - 1)) && !/\d/.test(text.charAt(at + length));
    const math = new Set<number>();

    for (let index = 0; index < runs.length; index += 1) {
        const open = runs[index];
        const close = runs[index + 1];

        // Math is one or two dollars each side, the same number, with
        // something between them and no line left empty.
        if (close && open.length <= 2 && open.length === close.length && opens(open) && closes(close)
            && !/\n[ \t]*\n/.test(text.slice(open.at, close.at))) {
            math.add(open.at).add(close.at);
            index += 1;
        }
    }

    let settled = '';
    let from = 0;

    for (const { at, length } of runs) {
        if (!math.has(at) && !bare.some(([start, end]) => at >= start && at < end)) {
            settled += text.slice(from, at) + (BACKSLASH + DOLLAR).repeat(length);
            from = at + length;
        }
    }

    return settled + text.slice(from);
}

// Math between two dollars each side is set apart, wherever it is written,
// and math too long to render is shown as it was written.
const markMath = () => (tree: Node, file: unknown) => {
    const source = String(file);
    const walk = (parent: Node) => {
        if (!parent.children) {
            return;
        }
        parent.children = parent.children.map(child => {
            const from = child.position?.start.offset;
            const long = (child.value ?? '').length > MATH_LIMIT;

            if (child.type === 'math' || (child.type === 'code' && child.lang === 'math')) {
                return long ? { type: 'code', value: child.value } : child;
            }
            if (child.type !== 'inlineMath' || from === undefined) {
                walk(child);
                return child;
            }
            if (long) {
                return { type: 'inlineCode', value: child.value };
            }

            return source.charAt(from + 1) === DOLLAR
                ? { ...child, data: { ...child.data, hProperties: { className: ['language-math', 'math-display'] } } }
                : child;
        });
    };

    walk(tree);
};

// How KaTeX is asked to render: what is written is a stranger's, so no command
// that makes a link, loads an image or sets a class or an attribute is run, and
// a macro may expand only so far.
const MATH = [[rehypeKatex, { trust: false, strict: 'ignore', maxExpand: 500, maxSize: 20 }]];

// One embed, as what its DID turns out to be.
function Embed({ did, version, words }: { did: string; version: string; words: string }) {
    const embeds = useContext(Embeds);
    // What was found for the embed named: an object, a version that is not in
    // an object's history, or no object, which may be an image.
    const [held, setHeld] = useState<{ of: string; found: unknown } | undefined>(undefined);
    const [imageless, setImageless] = useState(false);
    const of = `${did} ${version}`;
    const read = embeds?.read;
    const object = embeds?.object;

    useEffect(() => {
        let current = true;

        setImageless(false);
        (object ? object(did, version) : Promise.resolve(undefined)).then(
            found => { if (current) setHeld({ of, found }); },
            () => { if (current) setHeld({ of, found: undefined }); },
        );

        return () => { current = false; };
    }, [object, read, did, version, of]);

    const address = `${did}?versionId=${version}`;
    const byWords = <span className="muted" title={address}>{words}</span>;

    if (!embeds) {
        return <p className="embed">{byWords}</p>;
    }
    if (held?.of !== of) {
        return <p className="embed muted">Reading what is embedded.</p>;
    }
    if (held.found === 'no-revision') {
        return <p className="embed muted">{words}: this version is no longer in its history.</p>;
    }
    if (held.found !== undefined) {
        return <div className="embed card">{embeds.card(held.found)}</div>;
    }
    if (imageless) {
        return <p className="embed">{byWords}</p>;
    }

    return (
        <p className="embed">
            <img src={embeds.image(did, version)} alt={words === 'image' ? '' : words} loading="lazy" onError={() => setImageless(true)} />
        </p>
    );
}

// Whether what is being rendered is the words of a link. An image there is the
// link's description, and is not made a link of its own inside it.
const InLink = createContext(false);

function Image({ src, alt, lifted }: { src?: unknown; alt?: string; lifted?: boolean }) {
    const linked = useContext(InLink);
    const address = typeof src === 'string' ? src : '';
    const words = alt || 'image';
    const embed = lifted ? embedOf(address) : undefined;

    if (embed) {
        return <Embed did={embed.did} version={embed.version} words={words} />;
    }
    if (linked) {
        return <>{words}</>;
    }
    if (scheme(address) === 'https') {
        return <a href={address} target="_blank" rel="noreferrer noopener">{words}</a>;
    }

    return <span className="muted" title={address || undefined}>{words}</span>;
}

const components: Components = {
    a({ href, children }) {
        // What is inside is the words of a link whether or not the link is
        // followed, so an image there is a description wherever it points.
        const words = <InLink.Provider value={true}>{children}</InLink.Provider>;

        // An address that is not followed leaves the words it was on.
        if (!href) {
            return <span>{words}</span>;
        }
        // A DID is not somewhere a browser can go.
        if (scheme(href) === 'did') {
            return <span className="mono" title={href}>{words}</span>;
        }

        return <a href={href} target="_blank" rel="noreferrer noopener">{words}</a>;
    },
    img: ({ src, alt, ...rest }) => <Image src={src} alt={alt} lifted={(rest as Record<string, unknown>)['data-embed'] === 'true'} />,
};

// `embeds` says whether the text's embeds are shown as what they are. What is
// shown inside a card has its own embeds shown by their words, so that an embed
// is never inside another.
export default function Markdown({ text, className = 'text', embeds = true }: { text: string; className?: string; embeds?: boolean }) {
    const plugins = useMemo(() => [remarkGfm, remarkMath, markMath, liftEmbeds(embeds ? EMBED_LIMIT : 0)], [embeds]);
    const settled = useMemo(() => settleDollars(text), [text]);

    return (
        <div className={`${className} markdown`}>
            <ReactMarkdown remarkPlugins={plugins as never} rehypePlugins={MATH as never} urlTransform={safeUrl} components={components}>
                {settled}
            </ReactMarkdown>
        </div>
    );
}
