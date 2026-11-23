import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

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
// Embeds, which are images whose address is a version-pinned `did:` URL, and
// math are not rendered yet: an embed is shown by its alternative text.

const scheme = (url: string) => /^([a-z][a-z0-9+.-]*):/i.exec(url.trim())?.[1].toLowerCase();

// The address as it may be used, or nothing for one that may not.
export function safeUrl(url: string): string {
    const named = scheme(url);

    return named === 'https' || named === 'did' ? url.trim() : '';
}

const components: Components = {
    a({ href, children }) {
        // An address that is not followed leaves the words it was on.
        if (!href) {
            return <span>{children}</span>;
        }
        // A DID is not somewhere a browser can go.
        if (scheme(href) === 'did') {
            return <span className="mono" title={href}>{children}</span>;
        }

        return <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
    },
    img({ src, alt }) {
        const address = typeof src === 'string' ? src : '';
        const words = alt || 'image';

        if (scheme(address) === 'https') {
            return <a href={address} target="_blank" rel="noreferrer noopener">{words}</a>;
        }

        return <span className="muted" title={address || undefined}>{words}</span>;
    },
};

export default function Markdown({ text, className = 'text' }: { text: string; className?: string }) {
    return (
        <div className={`${className} markdown`}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={safeUrl} components={components}>
                {text}
            </ReactMarkdown>
        </div>
    );
}
