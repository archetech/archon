import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

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

// Keeps as math only what Text formatting says is math, and leaves the rest
// the text it was written as.
//
// The parser takes any two dollars in a line for math, so a sentence naming
// two prices would be. The rule shared with Pandoc is narrower: an opening
// dollar has something other than a space straight after it, and a closing
// dollar has something other than a space straight before it and no digit
// after it.
//
// Math between two dollars each side is set apart, wherever it is written.
const keepMath = () => (tree: Node, file: unknown) => {
    const source = String(file);
    const walk = (parent: Node) => {
        if (!parent.children) {
            return;
        }
        parent.children = parent.children.map(child => {
            const from = child.position?.start.offset;
            const to = child.position?.end.offset;

            if (child.type === 'math' || (child.type === 'code' && child.lang === 'math')) {
                // Too long to render: a block of the LaTeX as it was written.
                return (child.value ?? '').length > MATH_LIMIT ? { type: 'code', value: child.value } : child;
            }
            if (child.type !== 'inlineMath' || from === undefined || to === undefined) {
                walk(child);
                return child;
            }

            const written = source.slice(from, to);
            let dollars = 0;

            while (written.charAt(dollars) === DOLLAR) {
                dollars += 1;
            }

            const inside = written.slice(dollars, written.length - dollars);

            if (!inside || /^\s|\s$/.test(inside) || /\d/.test(source.charAt(to)) || inside.length > MATH_LIMIT) {
                return { type: 'text', value: written };
            }

            return dollars > 1
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
    const plugins = useMemo(() => [remarkGfm, remarkMath, keepMath, liftEmbeds(embeds ? EMBED_LIMIT : 0)], [embeds]);

    return (
        <div className={`${className} markdown`}>
            <ReactMarkdown remarkPlugins={plugins as never} rehypePlugins={MATH as never} urlTransform={safeUrl} components={components}>
                {text}
            </ReactMarkdown>
        </div>
    );
}
