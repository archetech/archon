import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { linkTo, pathOf, routeOf } from './route';
import type { Listing } from './route';
import type { MouseEvent, ReactNode } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { Api, Coauthor, FileRef, Me, Person, Publication, Reply, Responses } from './api';
import Markdown, { Embeds } from './Markdown';
import type { Embedding } from './Markdown';

// Memepool's pages. A reader signs in with a wallet, grants the service once,
// and then reads the authors they follow and publishes posts and replies.
//
// Follows are the reader's own: kept in this browser and published nowhere.

const FOLLOWS = 'memepool.follows';

// Where an identity's avatar is asked for.
const Avatars = createContext<((did: string) => string) | undefined>(undefined);

// A number from a DID, the same each time, to tell one author's place from
// another's where neither has an avatar.
const hueOf = (did: string) => [...did].reduce((sum, letter) => (sum * 31 + letter.charCodeAt(0)) % 360, 7);

// An identity's avatar: the image it names, over a figure that shows where
// there is none, or none the service will serve.
function Picture({ did }: { did: string }) {
    const address = useContext(Avatars);
    const [missing, setMissing] = useState(false);
    const [loaded, setLoaded] = useState(false);

    return (
        <span className="avatar" aria-hidden="true" style={{ background: `hsl(${hueOf(did)} 35% 55%)` }}>
            <svg viewBox="0 0 24 24" focusable="false">
                <circle cx="12" cy="9" r="4" />
                <path d="M4 22c0-4.4 3.6-8 8-8s8 3.6 8 8z" />
            </svg>
            {address && !missing && (
                <img
                    src={address(did)}
                    alt=""
                    loading="lazy"
                    className={loaded ? 'loaded' : undefined}
                    onLoad={() => setLoaded(true)}
                    onError={() => setMissing(true)}
                />
            )}
        </span>
    );
}

// Who is asked what an identity says of itself. One answer serves every place
// an identity is shown.
const People = createContext<((did: string) => Promise<Person>) | undefined>(undefined);

function usePerson(did: string): Person {
    const ask = useContext(People);
    const [person, setPerson] = useState<{ did: string; found: Person }>({ did, found: {} });

    useEffect(() => {
        let current = true;

        ask?.(did).then(found => { if (current) setPerson({ did, found }); }, () => undefined);

        return () => { current = false; };
    }, [ask, did]);

    return person.did === did ? person.found : {};
}

// How a reader goes to an author's own posts.
const Visits = createContext<((did: string) => void) | undefined>(undefined);

// An identity as the pages name one: its avatar, the name it gives itself and
// its address, where it has them, and its DID, shortened. A name is a claim
// anyone can make, so the DID is always beside it: the DID is who wrote.
function Identity({ did }: { did: string }) {
    const { name, address } = usePerson(did);
    const visit = useContext(Visits);
    const shown = (
        <>
            <Picture key={did} did={did} />
            <span className="who">
                {(name || address) && (
                    <span className="called">
                        {name && <strong>{name}</strong>}
                        {address && <span className="address">{address}</span>}
                    </span>
                )}
                <span className="mono" title={did}>{short(did)}</span>
            </span>
        </>
    );

    // Where there is somewhere to go, an identity is the way to its posts.
    return visit
        ? <button type="button" className="identity visit" title="Posts by this author" onClick={() => visit(did)}>{shown}</button>
        : <span className="identity">{shown}</span>;
}

export const short = (did: string) => (did.length > 24 ? `${did.slice(0, 14)}…${did.slice(-6)}` : did);

function readFollows(): string[] {
    try {
        const stored = JSON.parse(localStorage.getItem(FOLLOWS) ?? '[]');

        return Array.isArray(stored) ? stored.filter(each => typeof each === 'string') : [];
    }
    catch {
        return [];
    }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const when = (publication: Publication) => {
    const time = publication.versions[0]?.position?.time;

    return time ? new Date(time).toLocaleString() : '';
};

function SignIn({ api, onSignedIn, onStarted, pollMs }: {
    api: Api; onSignedIn: (did: string) => void; pollMs: number;
    // Told when a challenge is asked for, before it is.
    onStarted?: () => void;
}) {
    const [asked, setAsked] = useState<{ challenge: string; link: string } | null>(null);
    const [answered, setAnswered] = useState<string | null>(null);
    const [response, setResponse] = useState('');
    const [error, setError] = useState('');
    const [requesting, setAsking] = useState(false);

    // Counts the challenges asked for, so that an answer about one that has been
    // replaced is not taken for the one on show.
    const asking = useRef(0);

    const ask = useCallback(async () => {
        const mine = asking.current += 1;

        onStarted?.();
        setError('');
        setAnswered(null);
        setAsked(null);
        // One at a time: each challenge sets the cookie that says which one
        // this browser asked for, and the last to arrive would win.
        setAsking(true);
        try {
            const challenge = await api.challenge();

            if (mine === asking.current) {
                setAsked(challenge);
            }
        }
        catch (failure) {
            if (mine === asking.current) {
                setError(message(failure));
            }
        }
        finally {
            setAsking(false);
        }
    }, [api, onStarted]);

    // While a challenge is out and unanswered, ask whether a wallet has sent
    // its answer to the service.
    useEffect(() => {
        if (!asked || answered) {
            return;
        }

        const mine = asking.current;
        const timer = setInterval(async () => {
            try {
                const state = await api.login();

                if (mine === asking.current && state.answered) {
                    setAnswered(state.answered);
                }
            }
            catch (failure) {
                if (mine === asking.current) {
                    setAsked(null);
                    setError(message(failure));
                }
            }
        }, pollMs);

        return () => clearInterval(timer);
    }, [api, asked, answered, pollMs]);

    const finish = async (body: { response?: string; confirm?: string }) => {
        setError('');
        try {
            const state = await api.login(body);

            if (state.did) {
                onSignedIn(state.did);
            }
            else if (state.answered) {
                setAnswered(state.answered);
            }
        }
        catch (failure) {
            setAsked(null);
            setAnswered(null);
            setError(message(failure));
        }
    };

    return (
        <section className="card">
            <h2>Sign in</h2>
            <p>Memepool publishes for you with your permission. Your key stays in your wallet.</p>
            {error && <p role="alert" className="error">{error}</p>}

            {!asked && <button disabled={requesting} onClick={ask}>Sign in with your wallet</button>}

            {asked && !answered && (
                <>
                    <p>Scan this with your wallet, or open it on this device.</p>
                    <QRCodeSVG className="qr" value={asked.link} size={176} aria-label="Sign-in challenge" />
                    <p><a href={asked.link}>Open in your wallet</a></p>
                    <p className="muted">Waiting for your wallet…</p>
                    <details>
                        <summary>My wallet gave me a response to paste</summary>
                        <p className="mono">Challenge: {asked.challenge}</p>
                        <label>
                            Response
                            <input value={response} onChange={event => setResponse(event.target.value)} placeholder="did:cid:…" />
                        </label>
                        <button disabled={!response.trim()} onClick={() => finish({ response: response.trim() })}>Sign in</button>
                    </details>
                </>
            )}

            {asked && answered && (
                <>
                    <p>A wallet answered as:</p>
                    <p className="mono">{answered}</p>
                    <p>Anyone can answer a sign-in challenge. Continue only if this is your identity.</p>
                    <button onClick={() => finish({ confirm: answered })}>This is me</button>{' '}
                    <button className="quiet" onClick={ask}>That is not me</button>
                </>
            )}
        </section>
    );
}

// A button that puts a link on the clipboard, and says whether it did. Where a
// page may not write to the clipboard, the link beside it is selected for the
// reader to copy by hand.
// `unable` is what is said when the browser will not copy. Where the text is
// not on the page to be selected, it says the text.
function Copy({ text, label, unable = 'Could not copy. Select the link and copy it.' }: { text: string; label: string; unable?: string }) {
    const [said, setSaid] = useState('');

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(text);
            setSaid('Copied');
        }
        catch {
            setSaid(unable);
        }
    };

    return (
        <>
            <button className="quiet" onClick={copy}>{label}</button>
            {said && <span className="muted" role="status"> {said}</span>}
        </>
    );
}

// Whether a click was on a publication itself: not on something in it that
// does something of its own, and not the end of selecting some of its text.
const onItself = (event: MouseEvent<HTMLElement>) =>
    event.button === 0
    && !(event.target as Element).closest('a, button, input, textarea, select, label, summary, [role="menu"]')
    && !window.getSelection()?.toString();

// What else can be done with a publication, behind one button: each thing is
// done when chosen, and what it has to say of how that went is said beside
// the button.
function Menu({ items }: { items: { label: string; act: () => Promise<string | void> | string | void }[] }) {
    const [open, setOpen] = useState(false);
    const [said, setSaid] = useState('');
    const within = useRef<HTMLSpanElement>(null);
    const button = useRef<HTMLButtonElement>(null);
    const list = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) {
            return undefined;
        }

        list.current?.querySelector('button')?.focus();

        const outside = (event: Event) => {
            if (!within.current?.contains(event.target as Node)) {
                setOpen(false);
            }
        };

        document.addEventListener('mousedown', outside);

        return () => document.removeEventListener('mousedown', outside);
    }, [open]);

    const choose = async (act: () => Promise<string | void> | string | void) => {
        setOpen(false);
        button.current?.focus();
        setSaid((await act()) || '');
    };

    return (
        <span
            className="more"
            ref={within}
            onBlur={event => {
                // The keyboard has left it for something else.
                if (!within.current?.contains(event.relatedTarget as Node | null)) {
                    setOpen(false);
                }
            }}
            onKeyDown={event => {
                // From the button as from what is under it.
                if (open && event.key === 'Escape') {
                    setOpen(false);
                    button.current?.focus();
                }
            }}
        >
            {said && <span className="muted" role="status">{said} </span>}
            <button ref={button} className="quiet" aria-label="More" aria-haspopup="menu" aria-expanded={open} onClick={() => { setSaid(''); setOpen(!open); }}>⋯</button>
            {open && (
                <div
                    ref={list}
                    role="menu"
                    onKeyDown={event => {
                        const each = [...list.current!.querySelectorAll('button')];
                        const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;

                        if (step) {
                            event.preventDefault();
                            each[(each.indexOf(document.activeElement as HTMLButtonElement) + step + each.length) % each.length].focus();
                        }
                    }}
                >
                    {items.map(item => <button key={item.label} role="menuitem" className="quiet" onClick={() => choose(item.act)}>{item.label}</button>)}
                </div>
            )}
        </span>
    );
}

// What copies a text when it is chosen, and says how that went.
const copying = (text: string, unable: string) => async () => {
    try {
        await navigator.clipboard.writeText(text);

        return 'Copied';
    }
    catch {
        return unable;
    }
};

function GrantPrompt({ me, onChecked }: { me: Me; onChecked: () => void }) {
    return (
        <section className="card">
            <h2>Let Memepool publish for you</h2>
            {me.pending && me.pending.length > 0 ? (
                <>
                    <p>Your grant is waiting to be anchored on its chain. Memepool can publish for you once it is.</p>
                    <button onClick={onChecked}>Check again</button>
                </>
            ) : (
                <>
                    <p>
                        Open this in your wallet and approve it. The grant lets Memepool publish in your
                        name, and you can change or revoke it in your wallet at any time.
                    </p>
                    {me.link && (
                        <>
                            <QRCodeSVG className="qr" value={me.link} size={176} aria-label="Grant request" />
                            <p><a href={me.link}>Open in your wallet</a></p>
                            <label>
                                Or copy the grant link
                                <input readOnly value={me.link} onFocus={event => event.target.select()} />
                            </label>
                            <p><Copy text={me.link} label="Copy grant link" /></p>
                        </>
                    )}
                    {me.unavailable
                        ? <p role="alert" className="error">Memepool cannot be granted here: {me.unavailable}.</p>
                        : <button onClick={onChecked}>I have approved it</button>}
                </>
            )}
        </section>
    );
}

// What an object says. A short one says it in `text`. A longer one keeps its
// words apart, under `content`, and a paper gives a `summary` of them. A post
// with neither and a `target` is a boost of that object.
// Which version of a publication is shown, as something to compare.
const versionKey = (publication: Publication) => `${publication.current ?? 0} ${publication.versions[publication.current ?? 0]?.opid ?? ''}`;

// The Markdown that embeds the version of a publication that is shown. Its
// words are what is shown where the embed cannot be: the title, or what it is.
const embedFor = (publication: Publication) => {
    const words = String(publication.memeplex?.title ?? publication.memeplex?.kind ?? 'post').replace(/[[\]\\\n]/g, ' ').trim();

    return `![${words}](${publication.did}?versionId=${shownVersion(publication)})`;
};

// The version of a publication that is shown: the last one attributed.
const shownVersion = (publication: Publication) => publication.versions[publication.current ?? 0]?.opid;

// What the node has of a publication, where that is a version its chain has
// yet to anchor: one the indexer has not read, or has read and says is
// pending. A version that will never be published is none.
//
// Nothing is known where what the node has is not the same object: an edit
// changes neither what kind of object it is nor whose.
const awaited = (
    publication: Publication, last: { versionId: string; memeplex: NonNullable<Publication['memeplex']> } | undefined,
): NonNullable<Publication['memeplex']> | null | undefined => {
    const known = publication.versions.find(each => each.opid === last?.versionId);

    if (!last || (known && known.outcome !== 'pending')) {
        return null;
    }

    return last.memeplex.kind === publication.memeplex?.kind && last.memeplex.author === publication.memeplex?.author
        ? last.memeplex
        : undefined;
};

// Has each of some things done, a few at a time, and gives what each made.
async function inTurn<T, R>(things: T[], make: (thing: T) => Promise<R>, atOnce = 6): Promise<R[]> {
    const made: R[] = new Array(things.length);
    let next = 0;

    await Promise.all(Array.from({ length: Math.min(atOnce, things.length) }, async () => {
        while (next < things.length) {
            const at = next;

            next += 1;
            made[at] = await make(things[at]);
        }
    }));

    return made;
}

// The body of an article, which is kept apart from its entry, on IPFS. The
// entry gives its CID, and the node serves it: an article is read wherever
// it is shown. A CID names one text, so another version's is another CID.
function Article({ api, cid }: { api: Api; cid: string }) {
    const [body, setBody] = useState<{ text?: string; error?: string } | null>(null);

    useEffect(() => {
        let stale = false;

        setBody(null);
        api.content(cid).then(
            text => { if (!stale) setBody({ text }); },
            failure => { if (!stale) setBody({ error: message(failure) }); },
        );

        return () => { stale = true; };
    }, [api, cid]);

    if (!body) {
        return <p className="muted">Reading the full text.</p>;
    }
    if (body.error) {
        return <p role="alert" className="error">The full text could not be read: {body.error}</p>;
    }
    if (body.text === undefined) {
        return <p className="muted">The full text is not on this node.</p>;
    }

    return <Markdown text={body.text} className="text article" />;
}

// `full` shows the body of an article, where a list shows its summary alone.
function Body({ object, full, embeds = true }: {
    object: NonNullable<Publication['memeplex']>; full?: Api; embeds?: boolean;
}) {
    const words = object.text ?? (typeof object.summary === 'string' ? object.summary : undefined);
    const article = object.text === undefined && object.content !== undefined;
    const cid = (object.content as { cid?: unknown } | undefined)?.cid;

    return (
        <>
            {/* A post's text is Markdown. An article's summary is a line about it, shown as it is. */}
            {words && (article ? <p className="text summary">{words}</p> : <Markdown text={words} embeds={embeds} />)}
            {article && (full && typeof cid === 'string' ? <Article api={full} cid={cid} /> : <p className="muted">Open it to read the full text.</p>)}
            {!words && !article && object.target && (
                <p className="muted">A boost of <span className="mono" title={object.target}>{short(object.target)}</span></p>
            )}
        </>
    );
}

// Who is asked for publications: the indexer. `at` gives one as it was at a
// version, and `now` as it is.
interface Reading {
    at: (did: string, versionId: string) => Promise<Publication | 'no-revision' | undefined>;
    now: (did: string) => Promise<Publication | undefined>;
}

const Publications = createContext<Reading | undefined>(undefined);

// Counts the reads of the list a publication is shown in. What a boost shows
// is read apart from that list, and is read anew when the list is: the indexer
// may not have had it, and it may since have been withdrawn.
const Reads = createContext(0);

// How many boosts of boosts are followed to the post they pass on.
const BOOST_DEPTH = 5;

// How a reader opens a publication from inside another's text.
const Opens = createContext<((publication: Publication) => void) | undefined>(undefined);
// How many times the reader has gone somewhere. A post that is read before it
// is opened is opened only if the reader has gone nowhere since asking.
const Goings = createContext<() => number>(() => 0);

// A publication as it is, where it is one that can be opened: read at this
// moment, and published. A version read earlier is not opened in its place,
// since an answer would be to a version the post may have left behind.
const asItIs = async (read: Reading | undefined, did: string): Promise<Publication | undefined> => {
    const now = await read?.now(did).catch(() => undefined);

    return now?.state === 'published' && now.memeplex ? now : undefined;
};

// How a reader has the service store an image to embed, where they may.
const Uploads = createContext<((image: Blob) => Promise<{ did: string; versionId: string }>) | undefined>(undefined);

// The images text may embed, as Text formatting bounds them.
const IMAGE_KINDS = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const IMAGE_BYTES = 10_000_000;

// What a reader's pages are given to go by: the way to an author's posts, the
// way to open a publication, and how an embed is shown.
function Ways({ visit, open, gone, withdrawals, embedding, upload, children }: {
    visit: (did: string) => void; open: (publication: Publication) => void; gone: () => number; embedding: Embedding;
    withdrawals: { dids: ReadonlySet<string>; add: (did: string) => void };
    upload?: (image: Blob) => Promise<{ did: string; versionId: string }>; children: ReactNode;
}) {
    return (
        <Visits.Provider value={visit}>
            <Opens.Provider value={open}>
                <Uploads.Provider value={upload}>
                    <Goings.Provider value={gone}>
                        <Withdrawn.Provider value={withdrawals}><Embeds.Provider value={embedding}>{children}</Embeds.Provider></Withdrawn.Provider>
                    </Goings.Provider>
                </Uploads.Provider>
            </Opens.Provider>
        </Visits.Provider>
    );
}

// An object embedded in another's text, as a card: who wrote it, when, and what
// it said at the version embedded. Its own embeds are shown by their words, so
// that a card is never inside a card.
function Quoted({ publication }: { publication: Publication }) {
    const read = useContext(Publications);
    const onOpen = useContext(Opens);
    const gone = useContext(Goings);
    const [opening, setOpening] = useState(false);
    const [unopened, setUnopened] = useState(false);
    const object = publication.memeplex!;
    const withdrawn = publication.state === 'withdrawn';

    const open = async () => {
        setOpening(true);
        setUnopened(false);
        try {
            const from = gone();
            const now = await asItIs(read, publication.did!);

            if (gone() !== from) {
                return;
            }
            if (now) {
                onOpen?.(now);
            }
            else {
                setUnopened(true);
            }
        }
        finally {
            setOpening(false);
        }
    };

    const opens = Boolean(onOpen && !withdrawn && publication.did);

    // A click on the card is the card's: it opens what the card shows where
    // that can be opened, and never what the card is in.
    return (
        <div
            className={opens ? 'quoted opens' : 'quoted'}
            onClick={event => {
                if (onItself(event)) {
                    event.stopPropagation();
                    if (opens && !opening) {
                        open();
                    }
                }
            }}
        >
            <header>
                <Identity did={object.author} />
                {/* The time is the link to what is shown, which the keyboard and a new tab open it by. */}
                {opens
                    ? <a className="when" href={pathOf({ publication: publication.did! })} title="Link to this"><time>{when(publication)}</time></a>
                    : <time>{when(publication)}</time>}
            </header>
            <Titled object={object} />
            <Body object={object} embeds={false} />
            {withdrawn && <p className="muted note">Its author has since withdrawn this.</p>}
            {unopened && <p role="alert" className="error">It cannot be opened as it is. Refresh, and try once more.</p>}
        </div>
    );
}

// What a boost is of, or nothing for an object that is not a boost: a post
// with no words of its own that names another, and the version of it.
const boosted = (object: NonNullable<Publication['memeplex']>): { did: string; version?: string } | undefined =>
    (object.kind === 'post' && object.text === undefined && object.content === undefined && typeof object.target === 'string'
        ? { did: object.target, version: typeof object.targetVersion === 'string' ? object.targetVersion : undefined }
        : undefined);

// A boost, shown as what it passes on: the post it is of, as that post is
// shown, under a line saying who boosted it.
//
// A boost is of one version of a post, and that version is what is shown,
// whatever the post says since. A boost of a boost is of one version of that
// boost, so the whole way to the post is fixed as well.
function Boost({ publication, target, onOpen, onWithdraw }: {
    publication: Publication; target: { did: string; version?: string }; onOpen?: (publication: Publication) => void; onWithdraw?: () => void;
}) {
    const read = useContext(Publications);
    const reads = useContext(Reads);
    const gone = useContext(Goings);
    // What was found for the boost named: the post as it was, that its version
    // is not in its history, or nothing the indexer can show.
    const [held, setHeld] = useState<{ of: string; found: Publication | 'no-revision' | null; did: string } | undefined>(undefined);
    const [opening, setOpening] = useState(false);
    // Whether the post could not be opened as it is when that was asked.
    const [unopened, setUnopened] = useState(false);
    const author = publication.memeplex!.author;
    const { did, version } = target;
    const of = `${did} ${version ?? ''}`;

    useEffect(() => {
        let current = true;
        // Follows boosts of boosts, each at the version the one before names,
        // no further than a few and never to one already seen.
        const find = async (): Promise<{ found: Publication | 'no-revision' | null; did: string }> => {
            const seen = new Set<string>();
            let next: { did: string; version?: string } = { did, version };

            for (let depth = 0; read && next.version && depth < BOOST_DEPTH && !seen.has(`${next.did} ${next.version}`); depth += 1) {
                seen.add(`${next.did} ${next.version}`);
                const found = await read.at(next.did, next.version);

                if (found === 'no-revision' || !found) {
                    return { found: found ?? null, did: next.did };
                }

                const further = found.memeplex ? boosted(found.memeplex) : undefined;

                if (!further) {
                    return { found, did: next.did };
                }
                next = further;
            }

            return { found: null, did: next.did };
        };

        find().then(
            answer => { if (current) setHeld({ of, ...answer }); },
            () => { if (current) setHeld({ of, found: null, did }); },
        );

        return () => { current = false; };
    }, [read, did, version, of, reads]);

    // What was read for another boost is not this one's. What was read for
    // this one stays while it is read anew.
    const answer = held?.of === of ? held : undefined;
    const shown = answer && answer.found && answer.found !== 'no-revision' && answer.found.memeplex ? answer.found : undefined;
    const address = answer?.did ?? did;
    const withdrawn = shown?.state === 'withdrawn';

    // The post is opened as it is, which is what there is to read and answer.
    // The version boosted is not opened in its place: an answer would be to a
    // version the post may have left behind, or to a post since withdrawn.
    const open = async () => {
        setOpening(true);
        setUnopened(false);
        try {
            const from = gone();
            const now = await asItIs(read, shown!.did!);

            if (gone() !== from) {
                return;
            }
            if (now) {
                onOpen?.(now);
            }
            else {
                setUnopened(true);
            }
        }
        finally {
            setOpening(false);
        }
    };

    const opens = Boolean(onOpen && shown && !withdrawn);

    return (
        <article className={opens ? 'post boost opens' : 'post boost'} onClick={event => { if (opens && !opening && onItself(event)) { open(); } }}>
            <p className="boosted">
                <Identity did={author} />
                <span>boosted</span>
                <time>{when(publication)}</time>
            </p>
            {answer === undefined && <p className="muted">Reading the post.</p>}
            {answer && !shown && (
                <p className="muted">
                    {answer.found === 'no-revision' ? 'The version boosted is no longer in the history of ' : 'The post cannot be shown: '}
                    <span className="mono" title={address}>{short(address)}</span>
                </p>
            )}
            {shown && (
                <div className="original">
                    <header>
                        <Identity did={shown.memeplex!.author} />
                        <a className="when" href={pathOf({ publication: address })} title="Link to this"><time>{when(shown)}</time></a>
                    </header>
                    <Titled object={shown.memeplex!} />
                    <Body object={shown.memeplex!} />
                    {withdrawn && <p className="muted note">Its author has since withdrawn this post.</p>}
                </div>
            )}
            {unopened && <p role="alert" className="error">The post cannot be opened as it is. Refresh, and try once more.</p>}
            {onWithdraw && <footer><button className="quiet" onClick={onWithdraw}>Undo boost</button></footer>}
        </article>
    );
}

// A row of tabs, of which one is chosen: it is the one in the order the Tab
// key follows, and the arrow keys move between them. `panel` is the id of what
// the tabs choose between.
function Tabs<T extends string>({ label, tabs, selected, onSelect, panel }: {
    label: string; tabs: [T, string][]; selected: T; onSelect: (tab: T) => void; panel: string;
}) {
    const buttons = useRef<Partial<Record<T, HTMLButtonElement | null>>>({});

    return (
        <div role="tablist" aria-label={label} className="tabs">
            {tabs.map(([tab, name], index) => (
                <button
                    key={tab}
                    role="tab"
                    className="quiet"
                    aria-selected={selected === tab}
                    aria-controls={panel}
                    tabIndex={selected === tab ? 0 : -1}
                    ref={element => { buttons.current[tab] = element; }}
                    onClick={() => onSelect(tab)}
                    onKeyDown={event => {
                        const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;

                        if (step) {
                            const [next] = tabs[(index + step + tabs.length) % tabs.length];

                            event.preventDefault();
                            onSelect(next);
                            buttons.current[next]?.focus();
                        }
                    }}
                >
                    {name}
                </button>
            ))}
        </div>
    );
}

// What a reply answers, shown above the reply where it is read apart from its
// thread: the post or reply it is to, as that was at the version answered.
function Answered({ did, version }: { did: string; version?: string }) {
    const read = useContext(Publications);
    const reads = useContext(Reads);
    const [held, setHeld] = useState<{ of: string; found: Publication | 'no-revision' | null } | undefined>(undefined);
    const of = `${did} ${version ?? ''}`;

    useEffect(() => {
        let current = true;

        (read && version ? read.at(did, version) : Promise.resolve(undefined)).then(
            found => { if (current) setHeld({ of, found: found ?? null }); },
            () => { if (current) setHeld({ of, found: null }); },
        );

        return () => { current = false; };
    }, [read, reads, did, version, of]);

    const found = held?.of === of ? held.found : undefined;

    return (
        <div className="answered">
            <p className="muted">Replying to</p>
            {found === undefined && <p className="muted">Reading what it answers.</p>}
            {found === 'no-revision' && <p className="muted">A version that is no longer in the history of <span className="mono" title={did}>{short(did)}</span></p>}
            {found === null && <p className="muted"><span className="mono" title={did}>{short(did)}</span>, which cannot be shown</p>}
            {found && found !== 'no-revision' && found.memeplex && <div className="embed card"><Quoted publication={found} /></div>}
        </div>
    );
}

// `answers` says whether a reply is shown with what it answers: it is where a
// reply is read apart from its thread, and not in the thread itself.
function Post({ publication, onOpen, opened, onWithdraw, undo, full, answers, waiting, reader, past }: {
    publication: Publication; onOpen?: (publication: Publication) => void; opened?: boolean; onWithdraw?: () => Promise<string | void>;
    // How a boost of the reader's own is undone, where it is listed.
    undo?: () => void; full?: Api; answers?: boolean;
    // Who is reading, where the post is open to them: a paper that lists them
    // is theirs to confirm.
    reader?: Me;
    // Whether it is an earlier version that is shown. How a paper's coauthors
    // stand is known of its latest, and is not said of another.
    past?: boolean;
    // Whether what is shown is an edit of the reader's own that its chain has
    // not anchored, which nobody else is shown yet.
    waiting?: boolean;
}) {
    const object = publication.memeplex;

    if (publication.state === 'withdrawn' || !object) {
        return <article className="post muted">Withdrawn</article>;
    }

    const target = boosted(object);

    if (target) {
        return <Boost publication={publication} target={target} onOpen={onOpen} onWithdraw={undo} />;
    }

    // What else there is to do with a post is offered where it is open: to
    // withdraw it where that is the reader's to do, and to copy its address
    // in these pages, its DID, which another wallet or node resolves it by,
    // and what another text is given to show this version of it.
    const link = publication.did ? linkTo({ publication: publication.did }) : '';
    const more = opened && publication.did ? [
        ...(onWithdraw ? [{ label: 'Withdraw', act: onWithdraw }] : []),
        { label: 'Copy link', act: copying(link, `Could not copy. The link is ${link}`) },
        ...(shownVersion(publication) && !waiting
            ? [{ label: 'Copy embed', act: copying(embedFor(publication), `Could not copy. The embed is ${embedFor(publication)}`) }]
            : []),
        { label: 'Copy DID', act: copying(publication.did, `Could not copy. The DID is ${publication.did}`) },
    ] : null;

    return (
        <article
            className={['post', ...(waiting ? ['waiting'] : []), ...(onOpen ? ['opens'] : [])].join(' ')}
            onClick={event => { if (onOpen && onItself(event)) { onOpen(publication); } }}
        >
            <header>
                <Identity did={object.author} />
                {waiting && <span className="badge" role="status">Edit waiting to be anchored</span>}
                {!waiting && publication.versions.slice(0, (publication.current ?? 0) + 1).filter(each => each.outcome === 'attributed' && each.type !== 'delete').length > 1
                    && <span className="muted">edited</span>}
                {/* The time is the link to this publication alone, as it is elsewhere. */}
                {publication.did
                    ? <a className="when" href={pathOf({ publication: publication.did })} title="Link to this"><time>{when(publication)}</time></a>
                    : <time>{when(publication)}</time>}
                {more && <Menu items={more} />}
            </header>
            {answers && object.kind === 'reply' && typeof object.target === 'string' && (
                <Answered did={object.target} version={typeof object.targetVersion === 'string' ? object.targetVersion : undefined} />
            )}
            {object.kind === 'reply' && typeof object.verdict === 'string' && object.verdict.trim() && <Verdict verdict={object.verdict.trim()} />}
            <Titled object={object} />
            {/* Of one revision: another's standings, and what the reader did about it, are not this one's. */}
            {object.kind === 'paper' && (
                <Authors key={`${publication.did} ${shownVersion(publication)}`} publication={publication} api={full} reader={waiting ? undefined : reader} past={past} />
            )}
            <Body object={object} full={full} />
            {object.kind === 'paper' && full && <Downloads object={object} api={full} />}
        </article>
    );
}

// The largest file of a paper the service stores.
const FILE_BYTES = 10_000_000;

// A size as a reader is told it.
const sized = (bytes: number) => (bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} kB`);

// What a paper says of one of its files, where it is one that can be asked
// for: the paper is a stranger's, and so is what it says.
const fileOf = (value: unknown): FileRef | undefined => {
    const file = value as { cid?: unknown; type?: unknown; bytes?: unknown } | undefined;

    return file && typeof file.cid === 'string' && /^[A-Za-z0-9]{1,128}$/.test(file.cid) && typeof file.type === 'string' && typeof file.bytes === 'number'
        ? { cid: file.cid, type: file.type, bytes: file.bytes }
        : undefined;
};

// A paper's downloads: its PDF, and its source. They are offered and never
// shown: a browser saves them, under the paper's name.
function Downloads({ object, api }: { object: NonNullable<Publication['memeplex']>; api: Api }) {
    const pdf = fileOf(object.pdf);
    const source = fileOf(object.source);
    const name = (object.title ?? 'paper').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'paper';

    if (!pdf && !source) {
        return null;
    }

    return (
        <p className="downloads">
            {pdf && <a href={api.download(pdf, `${name}.pdf`)} download={`${name}.pdf`}>PDF ({sized(pdf.bytes)})</a>}
            {pdf && source && ' · '}
            {source && (
                <a
                    href={api.download(source, `${name}${source.type === 'application/gzip' ? '.tar.gz' : '.tex'}`)}
                    download={`${name}${source.type === 'application/gzip' ? '.tar.gz' : '.tex'}`}
                >
                    Source ({sized(source.bytes)})
                </a>
            )}
        </p>
    );
}

// A file chosen for a paper, which the service stores when it is chosen. It
// is the paper's once it is published with it.
function FileField({ label, kind, accept, value, onChange, store, disabled, onStoring }: {
    label: string; kind: 'pdf' | 'source'; accept: string; value: (FileRef & { name: string }) | null;
    onChange: (file: (FileRef & { name: string }) | null) => void;
    store: (kind: 'pdf' | 'source', file: Blob) => Promise<FileRef>; disabled: boolean; onStoring: (storing: boolean) => void;
}) {
    const [storing, setStoring] = useState(false);
    const [problem, setProblem] = useState('');
    const here = useRef(true);

    useEffect(() => {
        here.current = true;

        return () => { here.current = false; };
    }, []);

    const choose = async (file: File) => {
        setProblem('');
        if (file.size > FILE_BYTES) {
            setProblem(`${label} may be 10 MB at most.`);
            return;
        }
        setStoring(true);
        onStoring(true);
        try {
            const stored = await store(kind, file);

            if (here.current) {
                onChange({ ...stored, name: file.name });
            }
        }
        catch (failure) {
            if (here.current) {
                setProblem(`${label} was not stored: ${message(failure)}`);
            }
        }
        finally {
            if (here.current) {
                setStoring(false);
                onStoring(false);
            }
        }
    };

    return (
        <div className="file">
            {value
                ? (
                    <p>
                        {label}: {value.name} ({sized(value.bytes)}){' '}
                        <button className="quiet" disabled={disabled} onClick={() => onChange(null)}>Remove</button>
                    </p>
                )
                : (
                    <label>
                        {label}
                        <input
                            type="file"
                            accept={accept}
                            disabled={disabled || storing}
                            onChange={event => {
                                const [file] = event.target.files ?? [];

                                event.target.value = '';
                                if (file) {
                                    choose(file);
                                }
                            }}
                        />
                    </label>
                )}
            {storing && <p className="muted">Storing {label}…</p>}
            {problem && <p role="alert" className="error">{problem}</p>}
        </div>
    );
}

// Who wrote a paper. Its publisher lists them, which is the publisher's claim:
// each of the others is shown as having confirmed it, of this revision or of
// an earlier one, or as listed by the publisher. Where the paper is open, how
// each stands is read from the indexer, and a reader it lists can confirm it.
const LISTED = 5;

function Authors({ publication, api, reader, past = false }: { publication: Publication; api?: Api; reader?: Me; past?: boolean }) {
    const object = publication.memeplex!;
    const authors = Array.isArray(object.authors) ? (object.authors as unknown[]).filter((each): each is string => typeof each === 'string') : [];
    const others = authors.filter(each => each !== object.author);
    const revision = shownVersion(publication);
    const [stands, setStands] = useState<Coauthor[] | null>(null);
    // Read anew whenever what the paper is shown in is: a confirmation is
    // anchored, or taken back, without the paper changing.
    const reads = useContext(Reads);
    const [confirming, setConfirming] = useState(false);
    const [confirmed, setConfirmed] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        if (!api || past || !publication.did || others.length === 0) {
            return undefined;
        }

        let stale = false;

        api.coauthors(publication.did).then(read => { if (!stale) setStands(read); }, () => undefined);

        return () => { stale = true; };
        // How each stands is of the revision shown.
    }, [api, past, publication.did, revision, others.length, reads]);

    const standing = (did: string) => stands?.find(each => each.did === did)?.status;
    const mine = reader && others.includes(reader.did) ? standing(reader.did) : undefined;

    // Once the indexer shows the reader's confirmation it waits no more, and
    // one they take back after that is theirs to make once more.
    useEffect(() => {
        if (mine === 'confirmed') {
            setConfirmed(false);
        }
    }, [mine]);
    const confirm = async () => {
        setConfirming(true);
        setError('');
        try {
            await api!.publish({ kind: 'tag', target: publication.did, targetVersion: revision, tag: 'coauthor' });
            setConfirmed(true);
        }
        catch (failure) {
            setError(message(failure));
        }
        finally {
            setConfirming(false);
        }
    };

    return (
        <div className="authors">
            <ul>
                <li><Identity did={object.author} /></li>
                {(api ? others : others.slice(0, LISTED - 1)).map(did => (
                    <li key={did}>
                        <Identity did={did} />
                        {api && stands && (
                            <span className="muted">
                                {' '}
                                {standing(did) === 'confirmed'
                                    ? 'confirmed'
                                    : standing(did) === 'confirmed-other' ? 'confirmed an earlier revision' : 'listed by the publisher'}
                            </span>
                        )}
                    </li>
                ))}
            </ul>
            {!api && others.length > LISTED - 1 && <p className="muted">and {others.length - (LISTED - 1)} more</p>}
            {/* A reader the paper lists says so themselves, of the revision they have read. */}
            {api && reader && stands && mine !== undefined && mine !== 'confirmed' && !confirmed && may(reader, 'memeplex:tag') && revision && (
                <p>
                    {mine === 'confirmed-other' ? 'You confirmed an earlier revision of this paper. ' : 'This paper lists you as a coauthor. '}
                    <button className="quiet" disabled={confirming} onClick={confirm}>Confirm this revision</button>
                </p>
            )}
            {confirmed && mine !== 'confirmed' && <p className="muted">Your confirmation is waiting to be anchored.</p>}
            {error && <p role="alert" className="error">{error}</p>}
        </div>
    );
}

// What an entry shows above its text, as it was written: its title, and the
// subtitle a writer may give under it. A summary is a paper's, and is shown
// under them where there is one.
function Heading({ title, subtitle = '', summary = '' }: { title: string; subtitle?: string; summary?: string }) {
    return (
        <>
            {title.trim() && <h3>{title.trim()}</h3>}
            {subtitle.trim() && <p className="subtitle">{subtitle.trim()}</p>}
            {summary.trim() && <p className="text summary">{summary.trim()}</p>}
        </>
    );
}

// Whether a text is an address the protocol takes for where a work first
// appeared: an `https` one, with no space in it, of no more code points than
// the protocol counts.
const ORIGINAL_LENGTH = 2000;
const isOriginal = (text: string) => /^https:\/\/\S+$/.test(text) && [...text].length <= ORIGINAL_LENGTH;

// A date as the protocol writes it, in words. It is a day and no instant, so
// it is read in no time zone but its own.
const dayOf = (date: string): string | undefined => {
    const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);

    if (!parts) {
        return undefined;
    }

    // The year is set as it is written: given to a Date at its making, one below 100 is read as one in the 1900s.
    const [year, month, of] = parts.slice(1).map(Number);
    const day = new Date(0);

    day.setUTCFullYear(year, month - 1, of);

    // A day that is none comes out as another, and is not shown as that one.
    return day.getUTCFullYear() === year && day.getUTCMonth() === month - 1 && day.getUTCDate() === of
        ? day.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
        : undefined;
};

// When and where a work first appeared, as its author says: a claim, shown
// apart from the time the version was anchored. The address is a stranger's,
// followed as a link in text is and only where it is an `https` one.
function First({ object }: { object: NonNullable<Publication['memeplex']> }) {
    const day = typeof object.firstPublished === 'string' ? dayOf(object.firstPublished) : undefined;
    const original = typeof object.original === 'string' && isOriginal(object.original) ? object.original : undefined;

    if (!day && !original) {
        return null;
    }

    return (
        <p className="first muted">
            {day ? `First published ${day}` : 'First published elsewhere'}
            {original && <>{' · '}<a href={original} target="_blank" rel="noreferrer noopener">original</a></>}
        </p>
    );
}

// The places to say when and where a work first appeared, for one that is
// brought here from somewhere else. Both may be left empty.
function FirstFields({ date, original, disabled, onDate, onOriginal }: {
    date: string; original: string; disabled: boolean; onDate: (date: string) => void; onOriginal: (original: string) => void;
}) {
    return (
        <fieldset className="first-fields">
            <legend>If it was first published elsewhere</legend>
            <label>
                First published
                <input type="date" value={date} disabled={disabled} onChange={event => onDate(event.target.value)} />
            </label>
            <label>
                Original
                <input type="url" value={original} disabled={disabled} placeholder="https://" onChange={event => onOriginal(event.target.value)} />
            </label>
            {original.trim() && !isOriginal(original.trim()) && <p className="muted" role="status">The original is an https address, with no spaces.</p>}
        </fieldset>
    );
}

// The title and subtitle of an object that has them, and where it first appeared.
function Titled({ object }: { object: NonNullable<Publication['memeplex']> }) {
    return (
        <>
            <Heading title={object.title ?? ''} subtitle={typeof object.subtitle === 'string' ? object.subtitle : ''} />
            <First object={object} />
        </>
    );
}

// A text the reader writes, which is Markdown, with a view of how it will be
// shown. The view is made by what shows a published entry, so it is what
// readers will see. `before` is what an entry shows above its text: an
// article's title and summary, under which its body is set apart. `published` is the text as it will be published,
// where that is not the text as it is typed: a post is published trimmed, and
// white space before a line changes what Markdown makes of it.
//
// The two views are tabs: one of them is in the order the Tab key follows, and
// the arrow keys move between them. A panel is named for the text it is of, as
// a page can hold more than one of these.
function Draft({ label, value, onChange, disabled, rows, before, published = value, onStoring }: {
    label: string;
    value: string;
    onChange: (value: string) => void;
    // Told while an image is being stored for this text: what is written is
    // not whole until its embed is in it, so it is not yet to be published.
    onStoring?: (storing: boolean) => void;
    disabled?: boolean;
    rows: number;
    before?: ReactNode;
    published?: string;
}) {
    const [showing, setShowing] = useState<'write' | 'preview'>('write');
    const id = useId();
    const tabs = useRef<Partial<Record<'write' | 'preview', HTMLButtonElement | null>>>({});
    const upload = useContext(Uploads);
    const area = useRef<HTMLTextAreaElement | null>(null);
    const chooser = useRef<HTMLInputElement | null>(null);
    // Where the reader was writing, kept apart from the text box: the box is
    // gone while the preview is shown, and comes back without its place.
    const caret = useRef<number | undefined>(undefined);
    // Called when the text box comes and when it goes, and at no other time:
    // the box as it comes back is given the place the reader left.
    const placed = useCallback((element: HTMLTextAreaElement | null) => {
        if (element && caret.current !== undefined) {
            element.setSelectionRange(caret.current, caret.current);
        }
        area.current = element;
    }, []);
    const [storing, setStoring] = useState(false);
    const [problem, setProblem] = useState('');
    // The text as it is when an image has been stored, which may be later than when it was chosen.
    const latest = useRef(value);

    latest.current = value;

    // A text that has been put away takes no image that was still being stored for it.
    const here = useRef(true);

    useEffect(() => {
        here.current = true;

        return () => { here.current = false; };
    }, []);
    useEffect(() => { onStoring?.(storing); }, [onStoring, storing]);

    // Has the service store the image chosen, and puts its embed where the
    // reader was writing. The words of the embed are the file's name, for the
    // reader to change to what the image shows.
    const add = async (image: File) => {
        setProblem('');
        if (!IMAGE_KINDS.includes(image.type)) {
            setProblem('An image is PNG, JPEG, WebP or GIF.');
            return;
        }
        if (image.size > IMAGE_BYTES) {
            setProblem('An image may be 10 MB at most.');
            return;
        }

        setStoring(true);
        try {
            const { did, versionId } = await upload!(image);

            if (!here.current) {
                return;
            }

            const words = image.name.replace(/\.[^.]*$/, '').replace(/[[\]\\\n]/g, ' ').trim() || 'image';
            // Where the reader is writing when the image has been stored, in
            // the text as it then is: they may have gone on writing meanwhile.
            const text = latest.current;
            const place = Math.min(area.current?.selectionStart ?? caret.current ?? text.length, text.length);
            const before = text.slice(0, place);
            const after = text.slice(place);

            onChange([
                before,
                before.trim() && !/\n\s*$/.test(before) ? '\n\n' : '',
                `![${words}](${did}?versionId=${versionId})`,
                after.trim() && !/^\s*\n/.test(after) ? '\n\n' : '',
                after,
            ].join(''));
        }
        catch (failure) {
            if (here.current) {
                setProblem(`The image was not stored: ${message(failure)}`);
            }
        }
        finally {
            if (here.current) {
                setStoring(false);
            }
        }
    };

    const tab = (view: 'write' | 'preview', name: string) => (
        <button
            role="tab"
            className="quiet"
            id={`${id}-${view}-tab`}
            aria-selected={showing === view}
            aria-controls={`${id}-${view}`}
            tabIndex={showing === view ? 0 : -1}
            ref={element => { tabs.current[view] = element; }}
            onClick={() => setShowing(view)}
            onKeyDown={event => {
                if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                    const other = view === 'write' ? 'preview' : 'write';

                    event.preventDefault();
                    setShowing(other);
                    tabs.current[other]?.focus();
                }
            }}
        >
            {name}
        </button>
    );

    return (
        <div className="draft">
            <div role="tablist" aria-label={`${label}: write or preview`}>
                {tab('write', 'Write')}
                {tab('preview', 'Preview')}
            </div>
            {showing === 'write' ? (
                <div role="tabpanel" id={`${id}-write`} aria-label={`${label}: write`}>
                    <label>
                        {label}
                        <textarea
                            ref={placed}
                            value={value}
                            disabled={disabled}
                            rows={rows}
                            onSelect={event => { caret.current = event.currentTarget.selectionStart; }}
                            onChange={event => {
                                caret.current = event.target.selectionStart;
                                onChange(event.target.value);
                            }}
                            onPaste={event => {
                                if (!upload || storing) {
                                    return;
                                }
                                // What was copied as text is pasted as text. A spreadsheet or a
                                // document puts a picture of what was copied on the clipboard
                                // beside its words, and that picture is not what the reader meant.
                                if ([...event.clipboardData.items].some(item => item.kind === 'string' && item.type === 'text/plain')) {
                                    return;
                                }
                                // The first file on the clipboard, which is an image copied from
                                // a page or another app, or a screenshot. Pasting more than one
                                // at a time is left to the Add image button, one at a time.
                                for (const item of event.clipboardData.items) {
                                    if (item.kind === 'file') {
                                        const image = item.getAsFile();

                                        if (image) {
                                            event.preventDefault();
                                            add(image);
                                            return;
                                        }
                                    }
                                }
                            }}
                        />
                    </label>
                    {upload && (
                        <p className="adding">
                            <input
                                ref={chooser}
                                type="file"
                                hidden
                                accept={IMAGE_KINDS.join(',')}
                                aria-label={`An image to add to ${label}`}
                                onChange={event => {
                                    const [image] = event.target.files ?? [];

                                    // The same image may be chosen once more.
                                    event.target.value = '';
                                    if (image) {
                                        add(image);
                                    }
                                }}
                            />
                            <button type="button" className="quiet" disabled={disabled || storing} onClick={() => chooser.current?.click()}>
                                {storing ? 'Storing the image…' : 'Add image'}
                            </button>
                            {problem && <span role="alert" className="error"> {problem}</span>}
                        </p>
                    )}
                </div>
            ) : (
                <div role="tabpanel" id={`${id}-preview`} aria-label={`${label} preview`} className="post preview">
                    {before}
                    {published.trim()
                        ? <Markdown text={published} className={before ? 'text article' : 'text'} />
                        : <p className="muted">Nothing to preview.</p>}
                </div>
            )}
        </div>
    );
}

// A reply that gives a verdict is a review. The verdict is a few words of the
// reviewer's own, which a venue words as it likes, and is asked for where what
// is answered is something reviewed.
const VERDICT = 300;

function Verdict({ verdict }: { verdict: string }) {
    return <p className="verdict"><span className="badge">Review</span> {verdict}</p>;
}

function Composer({ label, onPublish, reviewing = false }: {
    label: string; onPublish: (text: string, verdict?: string) => Promise<void>;
    // Whether a verdict may be given with what is written.
    reviewing?: boolean;
}) {
    // Whether an image is being stored for what is written.
    const [storing, setStoring] = useState(false);
    const [text, setText] = useState('');
    const [verdict, setVerdict] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    const publish = async () => {
        setBusy(true);
        setError('');
        try {
            await onPublish(text.trim(), ...(reviewing && verdict.trim() ? [verdict.trim()] : []));
            setText('');
            setVerdict('');
        }
        catch (failure) {
            setError(message(failure));
        }
        finally {
            setBusy(false);
        }
    };

    return (
        <div className="composer">
            {reviewing && (
                <label>
                    Verdict
                    <input
                        value={verdict}
                        disabled={busy}
                        maxLength={VERDICT}
                        placeholder="For a review: accept, minor revisions… Leave it empty for a reply."
                        onChange={event => setVerdict(event.target.value)}
                    />
                </label>
            )}
            <Draft
                label={label}
                value={text}
                onChange={setText}
                disabled={busy}
                rows={3}
                published={text.trim()}
                before={reviewing && verdict.trim() ? <Verdict verdict={verdict.trim()} /> : undefined}
                onStoring={setStoring}
            />
            {error && <p role="alert" className="error">{error}</p>}
            <button disabled={busy || storing || !text.trim()} onClick={publish}>{reviewing && verdict.trim() ? 'Publish review' : 'Publish'}</button>
        </div>
    );
}

// An article: a post with a title, whose body the service stores apart from
// the entry. A timeline shows its title, and the subtitle where it has one.
// The DIDs written in a list of coauthors, one to a line or with commas
// between, and whatever in it is no DID.
export function coauthorsIn(written: string): { dids: string[]; others: string[] } {
    const parts = written.split(/[\s,]+/).filter(Boolean);
    const dids = [...new Set(parts.filter(part => /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/.test(part)))];

    return { dids, others: parts.filter(part => !dids.includes(part)) };
}

// The most authors a paper lists, its publisher among them.
const AUTHORS = 100;

// An article, or a paper: a paper has an abstract, and lists who wrote it with
// its publisher. Listing someone is the publisher's claim, which each of them
// confirms for themselves.
function ArticleComposer({ onPublish, onCancel, paper = false, store }: {
    onPublish: (article: {
        title: string; subtitle?: string; body: string; summary?: string; coauthors?: string[]; pdf?: FileRef; source?: FileRef;
        firstPublished?: string; original?: string;
    }) => Promise<void>;
    onCancel: () => void;
    paper?: boolean;
    // How a paper's files are stored, where the reader may have them stored.
    store?: (kind: 'pdf' | 'source', file: Blob) => Promise<FileRef>;
}) {
    const [pdf, setPdf] = useState<(FileRef & { name: string }) | null>(null);
    const [source, setSource] = useState<(FileRef & { name: string }) | null>(null);
    // How many of the paper's files are being stored.
    const [filing, setFiling] = useState(0);
    const reference = (file: (FileRef & { name: string }) | null) => (file ? { cid: file.cid, type: file.type, bytes: file.bytes } : undefined);
    const [title, setTitle] = useState('');
    const [subtitle, setSubtitle] = useState('');
    const [summary, setSummary] = useState('');
    const [listed, setListed] = useState('');
    const [first, setFirst] = useState('');
    const [original, setOriginal] = useState('');
    const [body, setBody] = useState('');
    const others = coauthorsIn(listed);
    const [busy, setBusy] = useState(false);
    // Whether an image is being stored for what is written.
    const [storing, setStoring] = useState(false);
    const [error, setError] = useState('');

    const publish = async () => {
        setBusy(true);
        setError('');
        try {
            await onPublish({
                title: title.trim(),
                ...(subtitle.trim() ? { subtitle: subtitle.trim() } : {}),
                body,
                ...(paper ? { summary: summary.trim(), coauthors: others.dids } : {}),
                ...(paper && pdf ? { pdf: reference(pdf) } : {}),
                ...(paper && source ? { source: reference(source) } : {}),
                ...(first ? { firstPublished: first } : {}),
                ...(original.trim() ? { original: original.trim() } : {}),
            });
        }
        catch (failure) {
            setError(message(failure));
            setBusy(false);
        }
    };

    return (
        <div className="composer">
            <label>
                Title
                <input value={title} disabled={busy} onChange={event => setTitle(event.target.value)} />
            </label>
            <label>
                Subtitle
                <input value={subtitle} disabled={busy} maxLength={300} onChange={event => setSubtitle(event.target.value)} />
            </label>
            {paper && (
                <>
                    <label>
                        Abstract
                        <textarea value={summary} disabled={busy} rows={4} maxLength={5000} onChange={event => setSummary(event.target.value)} />
                    </label>
                    <label>
                        Coauthors
                        <textarea
                            value={listed}
                            disabled={busy}
                            rows={2}
                            placeholder="Their DIDs, one to a line. You are the first author."
                            onChange={event => setListed(event.target.value)}
                        />
                    </label>
                    {others.others.length > 0 && <p role="alert" className="error">Not a DID: {others.others.join(', ')}</p>}
                    {others.dids.length >= AUTHORS && <p role="alert" className="error">A paper lists {AUTHORS} authors at most.</p>}
                    {others.dids.length > 0 && (
                        <p className="muted">Each is listed by you until they confirm it, which they do from the paper.</p>
                    )}
                    {/* A paper may carry its typeset PDF and its source, which readers download. */}
                    {store && (
                        <>
                            <FileField
                                label="PDF"
                                kind="pdf"
                                accept="application/pdf,.pdf"
                                value={pdf}
                                onChange={setPdf}
                                store={store}
                                disabled={busy}
                                onStoring={storing => setFiling(count => count + (storing ? 1 : -1))}
                            />
                            <FileField
                                label="Source"
                                kind="source"
                                accept=".tex,.gz,.tgz,application/x-tex,application/gzip"
                                value={source}
                                onChange={setSource}
                                store={store}
                                disabled={busy}
                                onStoring={storing => setFiling(count => count + (storing ? 1 : -1))}
                            />
                        </>
                    )}
                </>
            )}
            <Draft
                label={paper ? 'Paper' : 'Article'}
                value={body}
                onChange={setBody}
                disabled={busy}
                rows={14}
                before={<Heading title={title} subtitle={subtitle} summary={paper ? summary : ''} />}
                onStoring={setStoring}
            />
            <FirstFields date={first} original={original} disabled={busy} onDate={setFirst} onOriginal={setOriginal} />
            {error && <p role="alert" className="error">{error}</p>}
            <button
                disabled={busy || storing || filing > 0 || !title.trim() || !body.trim() || Boolean(original.trim() && !isOriginal(original.trim()))
                    || (paper && (!summary.trim() || others.others.length > 0 || others.dids.length >= AUTHORS))}
                onClick={publish}
            >
                {paper ? 'Publish paper' : 'Publish article'}
            </button>{' '}
            <button className="quiet" disabled={busy} onClick={onCancel}>Cancel</button>
        </div>
    );
}

// Something the user has published that its chain has not anchored yet. It is
// not a publication until then, and the indexer does not show it.
interface Waiting {
    did: string;
    // A post's or a reply's text, which is Markdown.
    text?: string;
    // The verdict a review gives.
    verdict?: string;
    // Whether it is a paper, which is listed apart from an article.
    paper?: boolean;
    // An article's title and subtitle, which are shown as they were written.
    title?: string;
    subtitle?: string;
    target?: string;
    // The chain it waits to be anchored on, once the service has said.
    registry?: string;
    // Whether the service says it will never be published.
    failed?: boolean;
}

// What the reader has published and the indexer has not shown is kept in this
// browser, for each reader, so that it is still there when the page is read
// anew. It is put away when the indexer shows it, or the service says it is
// published, and it is the reader's to put away when it never will be.
const WAITING = 'memepool.waiting.';

function readWaiting(reader: string): Waiting[] {
    try {
        const stored = JSON.parse(localStorage.getItem(WAITING + reader) ?? '[]');

        return Array.isArray(stored)
            ? stored.filter(each => each && typeof each === 'object' && typeof each.did === 'string').map(each => ({
                did: each.did,
                ...(typeof each.text === 'string' ? { text: each.text } : {}),
                ...(typeof each.verdict === 'string' ? { verdict: each.verdict } : {}),
                ...(each.paper === true ? { paper: true } : {}),
                ...(typeof each.title === 'string' ? { title: each.title } : {}),
                ...(typeof each.subtitle === 'string' ? { subtitle: each.subtitle } : {}),
                ...(typeof each.target === 'string' ? { target: each.target } : {}),
                ...(typeof each.registry === 'string' ? { registry: each.registry } : {}),
                ...(each.failed === true ? { failed: true } : {}),
            }))
            : [];
    }
    catch {
        return [];
    }
}

// What the reader published that the indexer does not show yet, as the post it
// will be and marked as waiting: who wrote it, where it waits, and what it says.
function Awaited({ entry, author, onDismiss }: { entry: Waiting; author: string; onDismiss: (did: string) => void }) {
    return (
        <article className={`post waiting${entry.failed ? ' failed' : ''}`}>
            <header>
                <Identity did={author} />
                <span className="badge" role="status">
                    {entry.failed ? 'Not published' : ['Waiting to be anchored', ...(entry.registry ? ['on', entry.registry] : [])].join(' ')}
                </span>
            </header>
            {entry.title !== undefined && <Heading title={entry.title} subtitle={entry.subtitle} />}
            {entry.verdict !== undefined && <Verdict verdict={entry.verdict} />}
            {entry.text !== undefined && <Markdown text={entry.text} />}
            {entry.failed && (
                <footer>
                    <span className="muted">This was not anchored under a grant in force, and will not be published.</span>{' '}
                    <button className="quiet" onClick={() => onDismiss(entry.did)}>Dismiss</button>
                </footer>
            )}
        </article>
    );
}

// A word as a tag is published: lower case, composed, with the spaces inside
// it made hyphens, so that one tag does not splinter across spellings.
export function tagWord(written: string): string {
    // Composed after lower-casing, which can take a composed letter apart.
    return written.trim().toLowerCase().normalize('NFC').replace(/\s+/g, '-');
}

const LIKE = '❤️';

// Whether the reader's grant lets the service publish with an action. What it
// does not allow is not offered: it would be refused, or published and never
// attributed.
const may = (me: Me, action: string) => me.grant !== undefined && (!me.actions || me.actions.includes(action));

// What others have made of an object, and the reader's own responses to it: a
// boost, a thumb up or down, a like, a tag. Each is an object of the reader's,
// and counts once its chain has anchored it.
// A response the reader has sent that its chain has not anchored yet, and how
// to tell from what the indexer shows that it has been.
// The objects the reader has withdrawn in this session, which the indexer
// shows until their withdrawal is anchored. It is kept above any one post, so
// that leaving a post and coming back offers no undoing of what is undone.
const Withdrawn = createContext<{ dids: ReadonlySet<string>; add: (did: string) => void }>({ dids: new Set(), add: () => undefined });

interface Sent {
    what: string;
    shown: (responses: Responses) => boolean;
    // Responses that share one replace each other: the reader's rating is one
    // object, and its last thumb is the one that waits.
    replaces?: string;
}

// What was made of an object at one of its versions: the boosts, ratings and
// tags that name that version, of all that name the object. A response is of
// the version it was made on, whatever the object has become since.
export function responsesAt(all: Responses, version: string): Responses {
    const ratings = all.ratings.ratings.filter(each => each.memeplex?.targetVersion === version);
    const values = ratings.flatMap(each => {
        const { rating, min, max } = each.memeplex as { rating?: unknown; min?: unknown; max?: unknown };

        return typeof rating === 'number' && typeof min === 'number' && typeof max === 'number' && max > min ? [(rating - min) / (max - min)] : [];
    });

    return {
        boosts: all.boosts.filter(each => each.memeplex?.targetVersion === version),
        ratings: { ratings, ...(values.length ? { mean: values.reduce((sum, value) => sum + value, 0) / values.length } : {}) },
        // A view of the tags that does not say which version each was put on tells nothing of one version.
        tags: all.tags.flatMap(each => {
            const applied = each.applied?.filter(made => made.version === version) ?? [];

            return applied.length ? [{ tag: each.tag, authors: [...new Set(applied.map(made => made.author))].sort(), applied }] : [];
        }),
    };
}

function Respond({ api, me, grants, target, version, past = false }: {
    api: Api; me: Me; grants: Set<string>; target: Publication;
    // A version whose responses alone are counted, where the reader asks for
    // one version's and not all that were made of the object.
    version?: string;
    // Whether an earlier version is looked at: nothing more is made of it from here.
    past?: boolean;
}) {
    const [all, setResponses] = useState<Responses | null>(null);
    // What is counted and shown, which may be one version's. What the reader
    // has made of the object is looked for among all of it: a rating of an
    // earlier version is still their rating, to change or take back.
    const responses = all && version ? responsesAt(all, version) : all;
    const [sent, setSent] = useState<Sent[]>([]);
    // The rating the reader made here, before the indexer shows it.
    const [rated, setRated] = useState<string | undefined>(undefined);
    const [word, setWord] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const reads = useRef(0);

    const load = useCallback(async () => {
        const mine = reads.current += 1;

        try {
            const read = await api.responses(target.did!);

            if (mine === reads.current) {
                setResponses(read);
                setError('');
                // What the indexer shows has been anchored, and waits no more.
                setSent(current => current.filter(each => !each.shown(read)));
            }
        }
        catch (failure) {
            if (mine === reads.current) {
                setError(message(failure));
            }
        }
    }, [api, target.did]);

    useEffect(() => {
        load();

        return () => { reads.current += 1; };
    }, [load]);

    const about = { target: target.did, targetVersion: target.versions[target.current ?? 0]?.opid };
    // The reader has one rating of an object: a second thumb changes it. It is
    // one this service can change, made here or shown by the indexer under a
    // grant of the reader's to this service. A rating made through another
    // client is left alone, and a new one made, which counts as the later.
    const withdrawn = useContext(Withdrawn);
    const mine = rated ?? all?.ratings.ratings.find(
        each => each.memeplex?.author === me.did && grants.has(String(each.memeplex.grant)) && !withdrawn.dids.has(each.did ?? ''),
    )?.did;

    // Whether the response was sent.
    const send = async (what: string, shown: Sent['shown'], act: () => Promise<unknown>, replaces?: string): Promise<boolean> => {
        setBusy(true);
        setError('');
        try {
            await act();
            setSent(current => [...current.filter(each => !replaces || each.replaces !== replaces), { what, shown, replaces }]);

            return true;
        }
        catch (failure) {
            setError(message(failure));

            return false;
        }
        finally {
            setBusy(false);
        }
    };

    const byMe = (each: Publication) => each.memeplex?.author === me.did;

    const rate = (rating: 0 | 1) => send(
        rating ? 'Your thumb up' : 'Your thumb down',
        read => read.ratings.ratings.some(each => byMe(each) && each.memeplex?.rating === rating),
        async () => {
            const object = { kind: 'rating', ...about, rating, min: 0, max: 1 };

            if (mine) {
                await api.edit(mine, object);
            }
            else {
                setRated(await api.publish(object));
            }
        },
        'rating',
    );
    const tag = (value: string, what: string) => {
        let did: string | undefined;

        // It is shown once the indexer has this object, where it names the
        // objects: one of the reader's that was there before, and is being
        // taken off, is not this one.
        return send(
            what,
            read => read.tags.some(each => each.tag === value
                && (each.applied ? each.applied.some(made => made.did === did) : each.authors.includes(me.did))),
            async () => { did = await api.publish({ kind: 'tag', ...about, tag: value }); },
        );
    };
    const boost = () => {
        let did: string | undefined;

        return send('Your boost', read => read.boosts.some(each => each.did === did), async () => {
            did = await api.publish({ kind: 'post', ...about });
        });
    };

    // What the reader has made of this that the indexer shows and this
    // service can take back: made under a grant of theirs to it. A response
    // made through another client is that client's to withdraw.
    //
    // One already withdrawn here is not among them, though the indexer shows
    // it until that is anchored.
    //
    // A boost has no words of its own. A post of the reader's that quotes
    // this one is among what the indexer lists, and is not undone as a boost:
    // it is their writing.
    const boosts = all?.boosts
        .filter(each => byMe(each) && each.did && each.memeplex && boosted(each.memeplex)
            && grants.has(String(each.memeplex.grant)) && !withdrawn.dids.has(each.did))
        .map(each => each.did!) ?? [];
    const own = (each: Responses['tags'][number]) => each.applied
        ?.filter(made => made.author === me.did && grants.has(made.grant) && !withdrawn.dids.has(made.did)).map(made => made.did) ?? [];
    // Each tag the reader has put on this, with the objects that apply it, read once.
    const mineByTag = new Map(all?.tags.map(each => [each.tag, own(each)] as const).filter(([, dids]) => dids.length > 0));
    const tagged = (value: string) => mineByTag.get(value) ?? [];
    const myTags = [...mineByTag.keys()].filter(value => value !== LIKE);

    // The reader's rating as the indexer shows it, which is one that can be withdrawn.
    const ratedShown = all?.ratings.ratings
        .find(each => byMe(each) && grants.has(String(each.memeplex?.grant)) && !withdrawn.dids.has(each.did ?? ''))?.did;
    // Whether something of this name waits to be anchored: it is not asked for twice.
    const waits = (what: string) => sent.some(each => each.what === what);

    // Takes back responses of the reader's, which are objects they withdraw.
    // Each is counted as withdrawn as soon as it is, so that where a later one
    // fails, trying once more is of those that are left. It is done once the
    // indexer shows none of them, whatever else of the same kind it shows.
    const undo = (what: string, dids: string[], shows: (read: Responses) => (string | undefined)[], replaces?: string) => send(
        what,
        read => !shows(read).some(did => dids.includes(did ?? '')),
        async () => {
            for (const did of dids) {
                await api.withdraw(did);
                withdrawn.add(did);
            }
            if (replaces === 'rating') {
                setRated(undefined);
            }
        },
        replaces,
    );
    const boostsIn = (read: Responses) => read.boosts.map(each => each.did);
    const ratings = (read: Responses) => read.ratings.ratings.map(each => each.did);
    const applying = (value: string) => (read: Responses) => read.tags.find(each => each.tag === value)?.applied?.map(each => each.did) ?? [];

    return (
        <div className="respond">
            {responses && (
                <p className="muted">
                    {responses.boosts.length} {responses.boosts.length === 1 ? 'boost' : 'boosts'}
                    {' · '}
                    {responses.ratings.mean === undefined
                        ? 'no ratings'
                        : `rated ${Math.round(responses.ratings.mean * 100)}% by ${responses.ratings.ratings.length}`}
                    {responses.tags.map(each => (
                        <span key={each.tag} className="tag" title={each.authors.join(', ')}> · {each.tag} {each.authors.length}</span>
                    ))}
                </p>
            )}
            {error && <p role="alert" className="error">{error}</p>}
            {me.grant && !past && (
                <>
                    {boosts.length > 0
                        ? (
                            <button
                                className="quiet"
                                disabled={busy || waits('The undoing of your boost')}
                                onClick={() => undo('The undoing of your boost', boosts, boostsIn)}
                            >
                                Undo boost
                            </button>
                        )
                        : may(me, 'memeplex:post') && <button className="quiet" disabled={busy} onClick={boost}>Boost</button>}
                    {/* Not until the ratings have been read: a thumb has to know
                        whether the reader has a rating to change. A rating the
                        reader has can be changed whatever the scope is since:
                        the permission it was made with covers its edits. */}
                    {(may(me, 'memeplex:rate') || mine) && (
                        <>
                            <button className="quiet" disabled={busy || !responses} onClick={() => rate(1)} aria-label="Thumb up">👍</button>
                            <button className="quiet" disabled={busy || !responses} onClick={() => rate(0)} aria-label="Thumb down">👎</button>
                            {ratedShown && (
                                <button
                                    className="quiet"
                                    disabled={busy || waits('The removal of your rating')}
                                    onClick={() => undo('The removal of your rating', [ratedShown], ratings, 'rating')}
                                >
                                    Remove rating
                                </button>
                            )}
                        </>
                    )}
                    {may(me, 'memeplex:tag') && (
                        <>
                            {tagged(LIKE).length === 0 && <button className="quiet" disabled={busy} onClick={() => tag(LIKE, 'Your like')} aria-label="Like">{LIKE}</button>}
                            <label className="inline">
                                Tag
                                <input value={word} disabled={busy} onChange={event => setWord(event.target.value)} placeholder="a word" />
                            </label>
                            <button
                                className="quiet"
                                disabled={busy || !tagWord(word)}
                                onClick={async () => {
                                    if (await tag(tagWord(word), `Your tag ${tagWord(word)}`)) {
                                        setWord('');
                                    }
                                }}
                            >
                                Add tag
                            </button>
                        </>
                    )}
                    {/* A like or a tag the reader put on this is theirs to take off, whatever their grant allows since. */}
                    {tagged(LIKE).length > 0 && (
                        <button
                            className="quiet"
                            disabled={busy || waits('The removal of your like')}
                            aria-label="Unlike"
                            aria-pressed="true"
                            onClick={() => undo('The removal of your like', tagged(LIKE), applying(LIKE))}
                        >
                            {LIKE} ✓
                        </button>
                    )}
                    {myTags.map(value => (
                        <button
                            key={value}
                            className="quiet"
                            disabled={busy || waits(`The removal of your tag ${value}`)}
                            onClick={() => undo(`The removal of your tag ${value}`, tagged(value), applying(value))}
                        >
                            Remove tag {value}
                        </button>
                    ))}
                </>
            )}
            {sent.map((each, index) => <p key={index} className="muted">{each.what} is waiting to be anchored.</p>)}
            <button className="quiet" onClick={load}>Refresh counts</button>
        </div>
    );
}

// The reader's own post or reply, being rewritten. Its kind and what it answers
// stay as they are: an edit that changed them would not be the same object.
function Edit({ api, publication, blocked = false, onDone }: {
    api: Api; publication: Publication; onDone: (saved?: boolean) => void;
    // Whether what is written cannot be saved: an edit of this already waits,
    // or the node cannot say that none does, and this one would be made of
    // the version before it.
    blocked?: boolean;
}) {
    const object = publication.memeplex!;
    const article = object.text === undefined && object.content !== undefined;
    const [text, setText] = useState(object.text ?? '');
    const [title, setTitle] = useState(object.title ?? '');
    const [subtitle, setSubtitle] = useState(typeof object.subtitle === 'string' ? object.subtitle : '');
    const [summary, setSummary] = useState(typeof object.summary === 'string' ? object.summary : '');
    const was = {
        first: typeof object.firstPublished === 'string' ? object.firstPublished : '',
        original: typeof object.original === 'string' ? object.original : '',
    };
    const [first, setFirst] = useState(was.first);
    const [original, setOriginal] = useState(was.original);
    // A summary is a paper's. An article that was given one keeps the place to change it.
    const summarized = object.kind === 'paper' || typeof object.summary === 'string';
    // The body as the service holds it, once it has been read.
    const [held, setHeld] = useState<string | undefined>(undefined);
    const [body, setBody] = useState('');
    const [busy, setBusy] = useState(false);
    // Whether an image is being stored for what is written.
    const [storing, setStoring] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        if (!article) {
            return undefined;
        }

        let stale = false;

        api.content(String((object.content as { cid?: unknown } | undefined)?.cid ?? '')).then(
            read => {
                if (stale) {
                    return;
                }
                if (read === undefined) {
                    setError('The full text is not on this node, so it cannot be changed here.');
                    return;
                }
                setHeld(read);
                setBody(read);
            },
            failure => { if (!stale) setError(message(failure)); },
        );

        return () => { stale = true; };
        // The body is that of the version the editor was opened on.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [api, article, publication.did]);

    const save = async () => {
        setBusy(true);
        setError('');
        try {
            const { v: _v, author: _author, grant: _grant, ...fields } = object;

            void _v; void _author; void _grant;
            if (!article) {
                await api.edit(publication.did!, { ...fields, text: text.trim() });
                onDone(true);
                return;
            }

            // A body that has not changed is the one the entry already refers
            // to. A changed one is sent, and the service stores it.
            const { content, summary: _summary, subtitle: _subtitle, firstPublished: _first, original: _original, ...rest } = fields;

            void _summary; void _subtitle; void _first; void _original;
            await api.edit(publication.did!, {
                ...rest,
                title: title.trim(),
                ...(subtitle.trim() ? { subtitle: subtitle.trim() } : {}),
                // A paper has a summary, which may be empty. A post has one or none.
                ...(summary.trim() || object.kind === 'paper' ? { summary: summary.trim() } : {}),
                ...(first ? { firstPublished: first } : {}),
                ...(original.trim() ? { original: original.trim() } : {}),
                ...(body === held ? { content } : { body }),
            });
            onDone(true);
        }
        catch (failure) {
            setError(message(failure));
            setBusy(false);
        }
    };

    if (article) {
        const unchanged = title.trim() === object.title && body === held
            && subtitle.trim() === (typeof object.subtitle === 'string' ? object.subtitle : '')
            && summary.trim() === (typeof object.summary === 'string' ? object.summary : '')
            && first === was.first && original.trim() === was.original;

        return (
            <div className="composer">
                <label>
                    Title
                    <input value={title} disabled={busy} onChange={event => setTitle(event.target.value)} />
                </label>
                <label>
                    Subtitle
                    <input value={subtitle} disabled={busy} maxLength={300} onChange={event => setSubtitle(event.target.value)} />
                </label>
                {summarized && (
                    <label>
                        Summary
                        <textarea value={summary} disabled={busy} onChange={event => setSummary(event.target.value)} rows={2} />
                    </label>
                )}
                <Draft
                    label="Article"
                    value={body}
                    onChange={setBody}
                    disabled={busy || held === undefined}
                    rows={14}
                    before={<Heading title={title} subtitle={subtitle} summary={summary} />}
                    onStoring={setStoring}
                />
                <FirstFields date={first} original={original} disabled={busy} onDate={setFirst} onOriginal={setOriginal} />
                {error && <p role="alert" className="error">{error}</p>}
                {blocked && <p className="muted">An edit of this is waiting to be anchored, and another cannot be saved until it is.</p>}
                <button disabled={blocked || busy || storing || held === undefined || !title.trim() || !body.trim() || unchanged || Boolean(original.trim() && !isOriginal(original.trim()))} onClick={save}>Save</button>{' '}
                <button className="quiet" disabled={busy} onClick={() => onDone()}>Cancel</button>
            </div>
        );
    }

    return (
        <div className="composer">
            <Draft label="Edit" value={text} onChange={setText} disabled={busy} rows={3} published={text.trim()} onStoring={setStoring} />
            {error && <p role="alert" className="error">{error}</p>}
            {blocked && <p className="muted">An edit of this is waiting to be anchored, and another cannot be saved until it is.</p>}
            <button disabled={blocked || busy || storing || !text.trim() || text.trim() === object.text} onClick={save}>Save</button>{' '}
            <button className="quiet" disabled={busy} onClick={() => onDone()}>Cancel</button>
        </div>
    );
}

function Thread({ api, me, grants, root: opened, mine, waiting, onPublished, onDismiss, onBack, onWithdrawn, onRead }: {
    api: Api; me: Me; grants: Set<string>; root: Publication; mine: boolean; waiting: Waiting[];
    onPublished: (waiting: Waiting) => void; onDismiss: (did: string) => void; onBack: () => void;
    // Told that the reader withdrew the post, which is then no longer there to show.
    onWithdrawn: () => void;
    // Told each time the thread has been read, with the replies it shows: what its
    // texts embed is read anew, and a reply of the reader's that is shown waits no more.
    onRead?: (shown: string[]) => void;
}) {
    const open = useContext(Opens);
    // The post as the indexer last showed it, which an edit changes once it is anchored.
    const [root, setRoot] = useState(opened);

    // A post opened anew is given as it is at that moment, which may be a later
    // version than the one shown here.
    useEffect(() => { setRoot(opened); }, [opened]);
    const [editing, setEditing] = useState(false);
    // The version an edit was made of, while its chain has not anchored the
    // edit: the edit is anchored once another version is the one shown.
    const [edited, setEdited] = useState<string | undefined>(undefined);
    const [replies, setReplies] = useState<Reply[] | null>(null);
    const [error, setError] = useState('');
    const reads = useRef(0);
    // What an edit of the reader's says while its chain has not anchored it,
    // as the node has it: none where the node says there is none, and not
    // known until the node has said. A post is another's to edit, or nobody's,
    // until then.
    const [waits, setWaits] = useState<NonNullable<Publication['memeplex']> | null | undefined>(undefined);
    // How many times the thread has been read, for what is read with it.
    const [loads, setLoads] = useState(0);
    // An earlier version of the post that is being looked at, and the post as
    // it was then: it is read from the indexer, which keeps every version.
    const [at, setAt] = useState<string | null>(null);
    const [earlier, setEarlier] = useState<{ of: string; found: Publication | 'no-revision' | null } | null>(null);
    // Whether only what was made of the version shown is shown. What is shown
    // otherwise is all that was made of the post, whichever version each was
    // of: an edit puts nothing out of sight. An earlier version is opened with
    // what was made of it alone, which is what it is opened for.
    const [only, setOnly] = useState(false);
    const see = (version: string | null) => {
        setAt(version);
        setOnly(version !== null);
    };
    // The same for each reply of the reader's own that the thread shows.
    const [answers, setAnswers] = useState<Record<string, NonNullable<Publication['memeplex']>>>({});

    const load = useCallback(async () => {
        const asked = reads.current += 1;

        setLoads(asked);

        try {
            // What the node has of what the reader wrote, which is ahead of the
            // indexer while an edit waits. The page may have been read anew
            // since the edit was made, and only the node still knows of it.
            const own = (each: Publication) => each.did !== undefined && each.memeplex?.author === me.did && each.state === 'published';
            const last = (each: Publication) => api.unanchored(each.did!).catch(() => undefined);
            const [thread, latest, mineLast] = await Promise.all([
                api.thread(opened.did!),
                api.publication(opened.did!),
                own(opened) ? last(opened) : undefined,
            ]);

            // The reader's own replies are read apart, each for itself, so
            // that one the node is slow to give keeps nothing else from showing.
            inTurn(thread.map(reply => reply.publication).filter(own), async reply => {
                const edit = awaited(reply, await last(reply));

                if (asked === reads.current) {
                    setAnswers(current => {
                        const { [reply.did!]: had, ...others } = current;

                        return edit ? { ...others, [reply.did!]: edit } : had ? others : current;
                    });
                }
            });

            if (asked === reads.current) {
                const shown = latest ?? opened;

                onRead?.(thread.flatMap(each => each.publication.did ?? []));
                setReplies(thread);
                if (latest) {
                    setRoot(latest);
                    setEdited(of => (of !== undefined && versionKey(latest) !== of ? undefined : of));
                }
                // Where the node could not say, it is not known that no edit waits.
                setWaits(own(shown) && mineLast === undefined ? undefined : awaited(shown, mineLast));
                setError('');
            }
        }
        catch (failure) {
            if (asked === reads.current) {
                setError(message(failure));
            }
        }
    }, [api, opened, me.did, onRead]);

    useEffect(() => {
        load();

        return () => { reads.current += 1; };
    }, [load]);

    // A reply the indexer shows is a publication, and no longer waits.
    const shown = new Set(replies?.map(each => each.publication.did));

    // A reply that gives a verdict is a review of the revision it answers.
    const reply = async (text: string, verdict?: string) => {
        const targetVersion = root.versions[root.current ?? 0]?.opid;
        const did = await api.publish({ kind: 'reply', target: root.did, targetVersion, text, ...(verdict ? { verdict } : {}) });

        onPublished({ did, text, target: root.did, ...(verdict ? { verdict } : {}) });
    };

    // The versions of the post a reader may look at: each one that was
    // published, in the order they were. One that was never attributed is none.
    const revisions = root.versions.filter(each => each.outcome === 'attributed' && each.type !== 'delete' && typeof each.opid === 'string');
    const latest = shownVersion(root);
    // One asked for is looked at whether or not it is among them: where it is
    // not in the history, that is said, and the latest is not shown in its place.
    const looking = at !== null && at !== latest ? at : null;
    const then = looking && earlier?.of === looking ? earlier.found : undefined;

    useEffect(() => {
        if (!looking) {
            return undefined;
        }

        let stale = false;

        api.revision(root.did!, looking).then(
            found => { if (!stale) setEarlier({ of: looking, found: found ?? null }); },
            () => { if (!stale) setEarlier({ of: looking, found: null }); },
        );

        return () => { stale = true; };
    }, [api, root.did, looking]);

    // The replies that answered a version: each that named it, with what was
    // said in answer to that reply.
    const answering = (version: string) => {
        let kept = false;

        return (replies ?? []).filter(each => {
            if (each.depth === 1) {
                kept = each.publication.memeplex?.targetVersion === version;
            }

            return kept;
        });
    };
    const versions = (revisions.length > 1 || looking) && (
        <label className="inline versions">
            Version
            <select value={looking ?? latest ?? ''} onChange={event => see(event.target.value === latest ? null : event.target.value)}>
                {looking && !revisions.some(each => each.opid === looking) && <option value={looking}>not in the history</option>}
                {revisions.map((each, index) => (
                    <option key={each.opid} value={each.opid}>
                        {index + 1} of {revisions.length}
                        {each.position?.time ? `, ${new Date(each.position.time).toLocaleString()}` : ''}
                        {each.opid === latest ? ' (latest)' : ''}
                    </option>
                ))}
            </select>
        </label>
    );

    const withdraw = async () => {
        try {
            await api.withdraw(root.did!);
            onWithdrawn();

            return undefined;
        }
        catch (failure) {
            return message(failure);
        }
    };

    // The latest version, with all that is made of it; or an earlier one: the
    // post as it was and what was made of it then, of which nothing is made
    // from here and nothing is changed. What the reader has made of the post
    // and is waiting on is kept between the two.
    return (
        <section>
            <button className="quiet" onClick={onBack}>Back</button>{' '}
            {looking
                ? <button className="quiet" onClick={() => see(null)}>Latest version</button>
                : <button className="quiet" onClick={load}>Refresh</button>}{' '}
            {versions}
            {(revisions.length > 1 || looking) && (
                <label className="inline">
                    <input type="checkbox" checked={only} onChange={event => setOnly(event.target.checked)} />
                    Only responses to this version
                </label>
            )}
            {looking && <p className="muted note">An earlier version of this.</p>}
            {looking && then === undefined && <p className="muted">Reading that version.</p>}
            {looking && then === null && <p role="alert" className="error">That version could not be read.</p>}
            {looking && then === 'no-revision' && <p className="muted">That version is no longer in its history.</p>}
            {looking && then && then !== 'no-revision' && <Post publication={then} full={api} past opened />}
            {/* The latest is put out of sight while an earlier version is looked at, and
                not put away: what the reader was writing of it, and what they have
                made of it that waits, is there when they come back. */}
            <div hidden={Boolean(looking)}>
                {/* The reader's own post is shown as their edit leaves it, marked as waiting. */}
                <Reads.Provider value={loads}>
                    <Post
                        publication={waits ? { ...root, memeplex: waits } : root}
                        full={api}
                        waiting={Boolean(waits)}
                        reader={me}
                        opened
                        // A boost that is open is opened no further: a click on it goes to the post it is of.
                        onOpen={root.memeplex && boosted(root.memeplex) ? open : undefined}
                        onWithdraw={mine && root.state === 'published' ? withdraw : undefined}
                    />
                </Reads.Provider>
                {/* One edit at a time: the next is of the post as the last one left it. */}
                {mine && root.state === 'published' && (root.memeplex?.text !== undefined || root.memeplex?.content !== undefined) && !editing && edited === undefined && waits === null && (
                    <button className="quiet" onClick={() => setEditing(true)}>Edit</button>
                )}
                {/* An editor is of one version. When another is shown it starts again from that one,
                    so that what is saved was written against what the reader saw. */}
                {editing && <Edit key={versionKey(root)} api={api} publication={root} blocked={waits !== null} onDone={saved => { setEditing(false); if (saved) { setEdited(versionKey(root)); load(); } }} />}
                {(edited !== undefined || waits) && <p className="muted">Your edit is waiting to be anchored. Until it is, others see this as it was.</p>}
            </div>
            <Respond api={api} me={me} grants={grants} target={root} version={only ? (looking ?? latest) : undefined} past={Boolean(looking)} />
            {!looking && error && <p role="alert" className="error">{error}</p>}
            {replies === null && !error && <p className="muted">Loading replies…</p>}
            {(only && (looking ?? latest) ? answering((looking ?? latest) as string) : replies ?? []).map(each => (
                <div key={each.publication.did} style={{ marginLeft: `${Math.min(each.depth, 6)}rem` }}>
                    {/* An answer is to the version it names, which may not be the one shown. */}
                    {each.depth === 1 && typeof each.publication.memeplex?.targetVersion === 'string' && each.publication.memeplex.targetVersion !== (looking ?? latest) && (
                        <p className="muted note">
                            This answered {looking ? 'another' : 'an earlier'} version.{' '}
                            <button className="quiet" onClick={() => see(each.publication.memeplex?.targetVersion === latest ? null : String(each.publication.memeplex?.targetVersion))}>See that version</button>
                        </p>
                    )}
                    <Post
                        publication={answers[each.publication.did ?? ''] ? { ...each.publication, memeplex: answers[each.publication.did ?? ''] } : each.publication}
                        waiting={Boolean(answers[each.publication.did ?? ''])}
                        onOpen={open && each.publication.did ? () => open(each.publication) : undefined}
                    />
                </div>
            ))}
            <div hidden={Boolean(looking)}>
                {waiting.filter(each => each.target === root.did && !shown.has(each.did)).map(each => (
                    <Awaited key={each.did} entry={each} author={me.did} onDismiss={onDismiss} />
                ))}
                {may(me, 'memeplex:reply') && <Composer label="Reply" onPublish={reply} reviewing={root.memeplex?.kind === 'paper'} />}
            </div>
        </section>
    );
}

// Everything a signed-in reader sees and does. It is mounted for one session
// and unmounted at sign-out, so whatever a request of that session answers
// afterwards has nothing to change: the next reader starts with nothing of the
// last one's.
// What each list of an author's is called.
const HEADINGS: Record<Listing, string> = { posts: 'Posts', articles: 'Articles', papers: 'Papers', replies: 'Replies' };

// Someone who has not signed in, who reads what an address names and does
// nothing else: they are nobody, with no grant.
const VISITOR: Me = { did: '' };

function Reader({ api, me, onCheck, onSignedOut, onSignedIn, pollMs }: {
    api: Api; me: Me; onCheck: () => void; onSignedOut: () => void;
    // How a visitor signs in, from wherever they are.
    onSignedIn?: (did: string) => void; pollMs?: number;
}) {
    const visitor = me === VISITOR;
    // Whether a visitor has asked to sign in, from something they are reading.
    const [signing, setSigning] = useState(false);
    // A sign-in that has been started is kept wherever the visitor goes.
    const started = useCallback(() => setSigning(true), []);
    // Whether a publication an address names is being read, with nothing to show yet.
    const [arriving, setArriving] = useState(() => {
        const route = routeOf(window.location);

        return route !== null && 'publication' in route;
    });
    const [follows, setFollows] = useState<string[]>(readFollows);
    const [timeline, setTimeline] = useState<Publication[] | null>(null);
    // How many publications the indexer has given, which is where its next page
    // starts, and how many it has in all. Neither is the number shown: a
    // publication that arrives between two reads is given twice and shown once.
    const [fetched, setFetched] = useState(0);
    const [total, setTotal] = useState(0);
    const reads = useRef(0);
    const [waiting, setWaiting] = useState<Waiting[]>(() => readWaiting(me.did));
    const dismiss = useCallback((did: string) => setWaiting(current => current.filter(each => each.did !== did)), []);
    // Whether the reader is writing an article, which has a form of its own.
    const [writing, setWriting] = useState<false | 'article' | 'paper'>(false);
    const [open, setOpen] = useState<Publication | null>(null);
    // The author whose posts alone are shown, where the reader went to one,
    // and whether it is the author's replies that are shown in their place. A
    // reply is part of a conversation: the reader's timeline has none, and an
    // author's are listed apart from the author's posts.
    const [author, setAuthor] = useState<string | null>(null);
    const [listing, setListing] = useState<Listing>('posts');
    // How many times the timeline has been read from its start.
    const [refreshes, setRefreshes] = useState(0);
    const [following, setFollowing] = useState('');
    const [error, setError] = useState('');

    // Reads the timeline from its start, or the page after what has been given.
    // A read that another has followed, or that the reader's follows have
    // changed under, is dropped: its answer is to a question no longer asked.
    const loadTimeline = useCallback(async (older?: { shown: Publication[]; from: number }) => {
        const mine = reads.current += 1;

        // A visitor has no timeline: they follow nobody the service knows of.
        if (visitor && !author) {
            setTimeline([]);
            return;
        }

        try {
            const page = await api.timeline(
                author ? [author] : [me.did, ...follows.filter(did => did !== me.did)],
                older?.from ?? 0,
                // An author's posts, articles, papers and replies are each
                // listed apart. A reader's timeline is all but the replies.
                author ? [listing === 'replies' ? 'reply' : listing === 'papers' ? 'paper' : 'post'] : ['post', 'paper'],
                ...(author && (listing === 'posts' || listing === 'articles') ? [listing === 'articles'] : []),
            );

            if (mine !== reads.current) {
                return;
            }

            const known = new Set(older?.shown.map(each => each.did));
            const read = [...older?.shown ?? [], ...page.publications.filter(each => !known.has(each.did))];
            const shown = new Set(read.map(each => each.did));

            setTimeline(read);
            if (!older) {
                setRefreshes(count => count + 1);
            }
            setFetched((older?.from ?? 0) + (page.read ?? page.publications.length));
            setTotal(page.total);
            // Once the indexer shows an object, it is a publication.
            setWaiting(current => current.filter(each => !shown.has(each.did)));
            setError('');
        }
        catch (failure) {
            if (mine === reads.current) {
                setError(message(failure));
            }
        }
    }, [api, me.did, visitor, follows, author, listing]);

    useEffect(() => {
        loadTimeline();

        return () => { reads.current += 1; };
    }, [loadTimeline]);

    // What is shown has an address, which is kept as the reader goes from one
    // thing to another, so that the address bar always holds a link to what is
    // on the page and the browser's back button goes to what was shown before.
    const address = pathOf(open?.did ? { publication: open.did } : author ? { author, list: listing } : null);
    const addressed = useRef(address);
    // Counts the times the reader has gone somewhere, by an address or within
    // the pages, so that a publication an earlier address named is not shown
    // once the reader has gone elsewhere.
    const arrivals = useRef(0);
    // Why an address the reader followed shows nothing. It is apart from a
    // failure to read the list, which a later read of the list clears.
    const [lost, setLost] = useState('');
    const gone = useCallback(() => arrivals.current, []);
    // What the reader has withdrawn while signed in, whichever post it was of.
    const [taken, setTaken] = useState<ReadonlySet<string>>(new Set());
    const withdrawals = useMemo(() => ({ dids: taken, add: (did: string) => setTaken(had => new Set([...had, did])) }), [taken]);

    // Before anything else can happen: were it left for later, the reader
    // going back in between would have the address of what was shown put
    // over the one they went back to.
    useLayoutEffect(() => {
        if (address === addressed.current) {
            return;
        }
        addressed.current = address;
        arrivals.current += 1;
        setLost('');
        setArriving(false);
        if (address !== window.location.pathname) {
            window.history.pushState(null, '', address);
        }
    }, [address]);

    // What is shown as it is at this moment, for what follows an address: it
    // is asked when the reader goes somewhere, which may be before the pages
    // have taken note of the last place they went.
    const shown = useRef({ open, author, listing, loadTimeline });

    shown.current = { open, author, listing, loadTimeline };

    // Shows what the address names: at the start, which is how a link given by
    // someone else is followed, and whenever the reader goes back or forward
    // or follows a link within the pages. A publication is read from the
    // indexer first, and what is shown stays until it has answered.
    const arrive = useCallback(async () => {
        const mine = arrivals.current += 1;
        const route = routeOf(window.location);
        // Shows a list: an author's, or the reader's timeline.
        const list = (to: string | null, listed: Listing) => {
            const now = shown.current;

            if (to !== now.author || listed !== now.listing) {
                setTimeline(null);
                setFetched(0);
                setTotal(0);
                setWriting(false);
                setAuthor(to);
                setListing(listed);
            }
            else if (now.open) {
                now.loadTimeline();
            }
            setOpen(null);
        };

        setLost('');
        if (!route || !('publication' in route)) {
            setArriving(false);
            list(route ? route.author : null, route ? route.list ?? 'posts' : 'posts');
            return;
        }
        if (shown.current.open?.did === route.publication) {
            setArriving(false);
            return;
        }
        setArriving(true);

        let found: Publication | undefined;
        let said = 'Nothing is published at that link, or not yet.';

        try {
            found = await api.publication(route.publication);
        }
        catch (failure) {
            said = message(failure);
        }
        if (mine !== arrivals.current) {
            return;
        }
        setArriving(false);
        // What its author withdrew is published no longer.
        if (found?.state === 'published' && found.memeplex) {
            setOpen(found);
            return;
        }
        // The address stays the one followed, over the reader's timeline, so
        // that what it says is of that address.
        addressed.current = pathOf(null);
        list(null, 'posts');
        setLost(said);
    }, [api]);

    const arrived = useRef(false);

    useEffect(() => {
        if (!arrived.current) {
            arrived.current = true;
            arrive();
        }
        window.addEventListener('popstate', arrive);

        return () => {
            window.removeEventListener('popstate', arrive);
        };
    }, [arrive]);

    const follow = (did: string) => {
        if (!did.startsWith('did:') || follows.includes(did)) {
            return;
        }

        const next = [...follows, did];

        localStorage.setItem(FOLLOWS, JSON.stringify(next));
        setFollows(next);
        setFollowing('');
    };

    // Goes to one author's posts, or back to the reader's timeline. What was
    // shown is another's list, so it is put away until the new one is read.
    const visit = (did: string | null) => {
        // The list shown is already this one's: an open post is closed on it,
        // and it is read anew as it is when a post is closed any other way.
        if (did === author) {
            if (open) {
                setOpen(null);
                loadTimeline();
            }
            return;
        }
        setOpen(null);
        setWriting(false);
        setTimeline(null);
        setFetched(0);
        setTotal(0);
        setListing('posts');
        setAuthor(did);
    };

    // Shows an author's posts, or the author's replies. What was shown is the
    // other list, so it is put away until this one is read.
    const list = (which: Listing) => {
        if (which === listing) {
            return;
        }
        setTimeline(null);
        setFetched(0);
        setTotal(0);
        setListing(which);
    };

    const unfollow = (did: string) => {
        const next = follows.filter(each => each !== did);

        localStorage.setItem(FOLLOWS, JSON.stringify(next));
        setFollows(next);
    };

    // The grants the service can change an object under. An object published
    // under another, by another client or under a grant since revoked, is the
    // reader's and is not this service's to withdraw.
    const grants = new Set([...(me.grant ? [me.grant] : []), ...me.others ?? []]);

    // One the reader has withdrawn is theirs to change no more, though the
    // indexer shows it until that is anchored.
    const changeable = (each: Publication) =>
        each.memeplex?.author === me.did && each.state === 'published' && grants.has(String(each.memeplex.grant)) && !taken.has(each.did ?? '');

    // What the reader has published that waits to be anchored, where the list
    // shown is one it belongs in: the reader's posts in the reader's timeline
    // and among the reader's posts, and the reader's replies among those.
    //
    // Where the reader's own things are listed apart, each waits in its own
    // list: a paper among the papers, an article, which has a title, among the
    // articles, and a post among the posts.
    const belongs = (each: Waiting): Listing => (each.target ? 'replies' : each.paper ? 'papers' : each.title !== undefined ? 'articles' : 'posts');
    const pending = author
        ? (author !== me.did ? [] : waiting.filter(each => belongs(each) === listing))
        : waiting.filter(each => !each.target);

    // What each of the reader's own posts in the list says in an edit that
    // waits, as the node has it: the reader is shown their post as they left
    // it, marked as waiting, wherever it is listed.
    const [edits, setEdits] = useState<Record<string, NonNullable<Publication['memeplex']>>>({});
    const looks = useRef(0);
    // What the node said of each post at the version listed, since the list
    // was last read from its start: an older page adds posts to the list, and
    // the ones already asked about are not asked about once more.
    const looked = useRef({ read: -1, found: new Map<string, NonNullable<Publication['memeplex']> | null>() });

    useEffect(() => {
        const look = looks.current += 1;

        if (looked.current.read !== refreshes) {
            looked.current = { read: refreshes, found: new Map() };
        }

        const { found } = looked.current;
        const own = (timeline ?? []).filter(post => post.did && post.memeplex?.author === me.did && post.state === 'published');
        const show = () => {
            if (look === looks.current) {
                setEdits(Object.fromEntries(own.flatMap(post => {
                    const edit = found.get(`${post.did} ${versionKey(post)}`);

                    return edit ? [[post.did!, edit]] : [];
                })));
            }
        };

        show();
        inTurn(own.filter(post => !found.has(`${post.did} ${versionKey(post)}`)), async post => {
            found.set(`${post.did} ${versionKey(post)}`, awaited(post, await api.unanchored(post.did!).catch(() => undefined)) ?? null);
            // Each as it is read: one the node is slow to give keeps no other from showing.
            show();
        });
    }, [api, me.did, timeline, refreshes]);

    // How an embed in a text is shown: an object at its version from the
    // indexer, as a card, and an image from the service.
    //
    // What an embed shows is read apart from the list or thread it is in, and
    // is read anew when that is: the indexer may not have had it, and a replay
    // may have put its version out of the history.
    //
    // A thread that has been read shows its replies, the withdrawn among them:
    // one of the reader's that it shows waits no more.
    const read = useCallback((shown: string[]) => {
        setRefreshes(count => count + 1);
        setWaiting(current => (current.some(each => shown.includes(each.did)) ? current.filter(each => !shown.includes(each.did)) : current));
    }, []);
    // What is kept is every page's of this reader in this browser, and another
    // page may have added to it. So this page writes what it changed, the
    // entries it holds and the removal of those it has put away, onto what is
    // there, and leaves the rest.
    const kept = useRef(waiting);

    useEffect(() => {
        const mine = new Map(waiting.map(each => [each.did, each]));
        const gone = new Set(kept.current.filter(each => !mine.has(each.did)).map(each => each.did));

        kept.current = waiting;
        try {
            const others = readWaiting(me.did).filter(each => !mine.has(each.did) && !gone.has(each.did));

            localStorage.setItem(WAITING + me.did, JSON.stringify([...others, ...waiting]));
        }
        catch {
            // A browser that keeps nothing still shows what waits, until the page is left.
        }
    }, [me.did, waiting]);

    // What another page of this reader writes is what is so: it added what it
    // published and removed what it put away. This page takes it up, so that it
    // shows the same and does not write back what the other removed.
    useEffect(() => {
        const taken = (event: StorageEvent) => {
            if (event.key === WAITING + me.did) {
                const stored = readWaiting(me.did);

                kept.current = stored;
                setWaiting(stored);
            }
        };

        window.addEventListener('storage', taken);

        return () => window.removeEventListener('storage', taken);
    }, [me.did]);

    // Asks the service where each thing that waits stands, when the list or a
    // thread is read and when there is something new to ask about. The indexer
    // shows only what is published, so it cannot say that something never will be.
    const held = waiting.map(each => each.did).join(' ');

    useEffect(() => {
        let current = true;
        const dids = held ? held.split(' ') : [];

        Promise.all(dids.map(async did => [did, await api.state(did).catch(() => undefined)] as const)).then(answers => {
            const said = new Map(answers);

            if (!current) {
                return;
            }
            setWaiting(now => {
                const next = now.flatMap(each => {
                    const answer = said.get(each.did);

                    if (!answer) {
                        return [each];
                    }
                    // What is published is the indexer's to show.
                    if (answer.state === 'published' || answer.state === 'withdrawn') {
                        return [];
                    }

                    const failed = answer.state === 'none' || answer.state === 'unsupported';
                    const registry = answer.registry ?? each.registry;

                    // Whatever else the entry holds is kept: what it says, and a review's verdict.
                    const { failed: _failed, ...held } = each;

                    void _failed;

                    return Boolean(each.failed) === failed && each.registry === registry
                        ? [each]
                        : [{ ...held, registry, ...(failed ? { failed } : {}) }];
                });

                return next.length === now.length && next.every((each, index) => each === now[index]) ? now : next;
            });
        });

        return () => { current = false; };
    }, [api, held, refreshes]);

    const embedding = useMemo<Embedding>(() => ({
        object: api.revision,
        image: api.image,
        card: object => <Quoted publication={object as Publication} />,
        read: refreshes,
    }), [api, refreshes]);

    // Signed out only when the service says so: the session is a cookie the
    // page cannot remove, and a reader who is told they are signed out must be.
    const signOut = async () => {
        try {
            await api.logout();
        }
        catch (failure) {
            setError(`You are still signed in: ${message(failure)}`);
            return;
        }
        onSignedOut();
    };

    // A visitor whose address names nothing has nothing to read, and signs in.
    // The sign-in is at one place in the page wherever the visitor goes, so
    // that one under way is not put away by going somewhere else.
    const nowhere = visitor && !open && !author;

    return (
        <Ways visit={visit} open={setOpen} gone={gone} withdrawals={withdrawals} embedding={embedding} upload={me.grant ? api.upload : undefined}>
            {/* A link to something the pages show is followed within them, and
                not by asking the service for the page anew. */}
            <main
                onClick={event => {
                    const link = (event.target as Element).closest?.('a.when');
                    const path = link?.getAttribute('href');

                    if (path && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
                        event.preventDefault();
                        window.history.pushState(null, '', path);
                        arrive();
                    }
                }}
            >
                <header className="top">
                    <h1>Memepool</h1>
                    {!visitor && <Identity did={me.did} />}
                    {!visitor && <button className="quiet" onClick={signOut}>Sign out</button>}
                    {visitor && !nowhere && !signing && <button className="quiet" onClick={() => setSigning(true)}>Sign in</button>}
                </header>

                {visitor && onSignedIn && (signing || (nowhere && !arriving)) && <SignIn api={api} onSignedIn={onSignedIn} onStarted={started} pollMs={pollMs ?? 3000} />}
                {nowhere && arriving && <p className="muted">Loading…</p>}
                {!visitor && !me.grant && <GrantPrompt me={me} onChecked={onCheck} />}
                {error && <p role="alert" className="error">{error}</p>}
                {lost && <p role="alert" className="error">{lost}</p>}

                {nowhere ? null : open ? (
                    <Thread
                        key={open.did}
                        api={api}
                        me={me}
                        grants={grants}
                        root={open}
                        mine={changeable(open)}
                        waiting={waiting}
                        onPublished={published => setWaiting(current => [...current, published])}
                        onDismiss={dismiss}
                        onBack={() => { setOpen(null); loadTimeline(); }}
                        onWithdrawn={() => {
                            // The reader may have gone elsewhere while it was withdrawn: only the post withdrawn is put away.
                            withdrawals.add(open.did!);
                            if (shown.current.open?.did === open.did) {
                                setOpen(null);
                            }
                            shown.current.loadTimeline();
                        }}
                        onRead={read}
                    />
                ) : (
                    <>
                        {author && (
                            <section className="card author">
                                {!visitor && <p><button className="quiet" onClick={() => visit(null)}>Back to your timeline</button></p>}
                                <Identity did={author} />
                                <p>
                                    {!visitor && author !== me.did && (follows.includes(author)
                                        ? <button className="quiet" onClick={() => unfollow(author)}>Unfollow</button>
                                        : <button className="quiet" onClick={() => follow(author)}>Follow</button>)}
                                    <Copy text={linkTo({ author, list: listing })} label="Copy link" unable={`Could not copy. The link is ${linkTo({ author, list: listing })}`} />
                                    <Copy text={author} label="Copy DID" unable={`Could not copy. The DID is ${author}`} />
                                </p>
                                <Tabs
                                    label="What of this author's is listed"
                                    tabs={[['posts', 'Posts'], ['articles', 'Articles'], ['papers', 'Papers'], ['replies', 'Replies']]}
                                    selected={listing}
                                    onSelect={list}
                                    panel="author-list"
                                />
                            </section>
                        )}
                        {!author && may(me, 'memeplex:post') && !writing && (
                            <>
                                <Composer
                                    label="Post"
                                    onPublish={async text => {
                                        const did = await api.publish({ kind: 'post', text });

                                        setWaiting(current => [...current, { did, text }]);
                                    }}
                                />
                                <p>
                                    <button className="quiet" onClick={() => setWriting('article')}>Write an article</button>{' '}
                                    <button className="quiet" onClick={() => setWriting('paper')}>Write a paper</button>
                                </p>
                            </>
                        )}
                        {!author && may(me, 'memeplex:post') && writing && (
                            <ArticleComposer
                                key={writing}
                                paper={writing === 'paper'}
                                store={api.file}
                                onCancel={() => setWriting(false)}
                                onPublish={async ({ coauthors, ...article }) => {
                                    // A paper lists its authors, its publisher first.
                                    const did = await api.publish(writing === 'paper'
                                        ? { kind: 'paper', ...article, authors: [me.did, ...(coauthors ?? []).filter(each => each !== me.did)] }
                                        : { kind: 'post', ...article });

                                    setWaiting(current => [...current, { did, title: article.title, ...(article.subtitle ? { subtitle: article.subtitle } : {}), ...(writing === 'paper' ? { paper: true } : {}) }]);
                                    setWriting(false);
                                }}
                            />
                        )}

                        <section id={author ? 'author-list' : undefined} role={author ? 'tabpanel' : undefined} aria-label={author ? HEADINGS[listing] : undefined}>
                            <h2>{author ? HEADINGS[listing] : 'Timeline'} <button className="quiet" onClick={() => loadTimeline()}>Refresh</button></h2>
                            {pending.map(each => <Awaited key={each.did} entry={each} author={me.did} onDismiss={dismiss} />)}
                            {timeline === null && <p className="muted">Loading…</p>}
                            {timeline?.length === 0 && pending.length === 0 && <p className="muted">Nothing here yet.</p>}
                            <Reads.Provider value={refreshes}>{timeline?.map(each => (
                                <Post
                                    key={each.did}
                                    publication={each.did && edits[each.did] ? { ...each, memeplex: edits[each.did] } : each}
                                    waiting={Boolean(each.did && edits[each.did])}
                                    answers
                                    onOpen={opened => setOpen(opened.did === each.did ? each : opened)}
                                    undo={changeable(each) && each.memeplex && boosted(each.memeplex)
                                        ? async () => {
                                            try {
                                                await api.withdraw(each.did!);
                                                withdrawals.add(each.did!);
                                                await loadTimeline();
                                            }
                                            catch (failure) {
                                                setError(message(failure));
                                            }
                                        }
                                        : undefined}
                                />
                            ))}</Reads.Provider>
                            {timeline && fetched < total && (
                                <button className="quiet" onClick={() => loadTimeline({ shown: timeline, from: fetched })}>Older</button>
                            )}
                        </section>

                        {!author && <section className="card">
                            <h2>Following</h2>
                            <p className="muted">
                            Kept in this browser and published nowhere. The node that serves your timeline
                            does see which authors you ask it for.
                            </p>
                            {follows.map(did => (
                                <p key={did}>
                                    <Identity did={did} />{' '}
                                    <button className="quiet" onClick={() => unfollow(did)}>Unfollow</button>
                                </p>
                            ))}
                            <label>
                            Follow an author
                                <input value={following} onChange={event => setFollowing(event.target.value)} placeholder="did:cid:…" />
                            </label>
                            <button disabled={!following.trim().startsWith('did:')} onClick={() => follow(following.trim())}>Follow</button>
                        </section>}
                    </>
                )}
            </main>
        </Ways>
    );
}

export default function App({ api, pollMs = 3000 }: { api: Api; pollMs?: number }) {
    const reading = useMemo(() => ({ at: api.revision, now: api.publication }), [api]);
    // Each identity is asked about once, however many of its posts are shown.
    const people = useMemo(() => {
        const asked = new Map<string, Promise<Person>>();

        return (did: string) => {
            let answer = asked.get(did);

            if (!answer) {
                answer = api.identity(did).catch(() => ({}));
                asked.set(did, answer);
            }

            return answer;
        };
    }, [api]);
    const [me, setMe] = useState<Me | null | undefined>(undefined);
    const [error, setError] = useState('');
    // Counts sign-outs, so that an answer about who was signed in before one is
    // not taken for who is signed in after it.
    const sessions = useRef(0);
    const [session, setSession] = useState(0);

    // Counts the reads of who is signed in, so that of two under way the later
    // one's answer stands.
    const checks = useRef(0);

    const loadMe = useCallback(async () => {
        const mine = sessions.current;
        const check = checks.current += 1;
        const current = () => mine === sessions.current && check === checks.current;

        try {
            const read = await api.me() ?? null;

            if (current()) {
                setMe(read);
                setError('');
            }
        }
        catch (failure) {
            // The service did not say the reader is signed out, so someone who
            // was signed in still is, and keeps the way to sign out.
            if (current()) {
                setMe(known => known ?? null);
                setError(message(failure));
            }
        }
    }, [api]);

    useEffect(() => { loadMe(); }, [loadMe]);

    if (me === undefined) {
        return <main><h1>Memepool</h1><p className="muted">Loading…</p></main>;
    }

    return (
        <Avatars.Provider value={api.avatar}>
            <People.Provider value={people}>
                <Publications.Provider value={reading}>
                    {error && <p role="alert" className="error">{error}</p>}
                    {/* Someone who has not signed in reads what an address names.
                        Once the service has signed this browser in, whatever a
                        read of the grant says next, they are shown as signed in. */}
                    <Reader
                        key={`${session} ${me?.did ?? ''}`}
                        api={api}
                        me={me ?? VISITOR}
                        pollMs={pollMs}
                        onSignedIn={did => { setMe({ did }); loadMe(); }}
                        onCheck={loadMe}
                        onSignedOut={() => {
                            sessions.current += 1;
                            setSession(sessions.current);
                            setMe(null);
                            setError('');
                        }}
                    />
                </Publications.Provider>
            </People.Provider>
        </Avatars.Provider>
    );
}
