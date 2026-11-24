import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { Api, Me, Person, Publication, Reply, Responses } from './api';
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

function SignIn({ api, onSignedIn, pollMs }: { api: Api; onSignedIn: (did: string) => void; pollMs: number }) {
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
    }, [api]);

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
                    <QRCodeSVG value={asked.link} size={176} aria-label="Sign-in challenge" />
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
                            <QRCodeSVG value={me.link} size={176} aria-label="Grant request" />
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

// The body of an article, which is kept apart from its entry. The service
// holds the bodies of what it published, and no others. The body read is that
// of the version shown, so that it goes with the title and summary beside it
// and is read again when another version is shown.
function Article({ api, did, version }: { api: Api; did: string; version?: string }) {
    const [body, setBody] = useState<{ text?: string; error?: string } | null>(null);

    useEffect(() => {
        let stale = false;

        setBody(null);
        api.content(did, version).then(
            text => { if (!stale) setBody({ text }); },
            failure => { if (!stale) setBody({ error: message(failure) }); },
        );

        return () => { stale = true; };
    }, [api, did, version]);

    if (!body) {
        return <p className="muted">Reading the full text.</p>;
    }
    if (body.error) {
        return <p role="alert" className="error">The full text could not be read: {body.error}</p>;
    }
    if (body.text === undefined) {
        return <p className="muted">The full text is kept apart from this entry, and this service does not hold it.</p>;
    }

    return <Markdown text={body.text} className="text article" />;
}

// `full` shows the body of an article, where a list shows its summary alone.
function Body({ object, full, embeds = true }: {
    object: NonNullable<Publication['memeplex']>; full?: { api: Api; did: string; version?: string }; embeds?: boolean;
}) {
    const words = object.text ?? (typeof object.summary === 'string' ? object.summary : undefined);
    const article = object.text === undefined && object.content !== undefined;

    return (
        <>
            {/* A post's text is Markdown. An article's summary is a line about it, shown as it is. */}
            {words && (article ? <p className="text summary">{words}</p> : <Markdown text={words} embeds={embeds} />)}
            {article && (full ? <Article api={full.api} did={full.did} version={full.version} /> : <p className="muted">Open it to read the full text.</p>)}
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

// A publication as it is, where it is one that can be opened: read at this
// moment, and published. A version read earlier is not opened in its place,
// since an answer would be to a version the post may have left behind.
const asItIs = async (read: Reading | undefined, did: string): Promise<Publication | undefined> => {
    const now = await read?.now(did).catch(() => undefined);

    return now?.state === 'published' && now.memeplex ? now : undefined;
};

// What a reader's pages are given to go by: the way to an author's posts, the
// way to open a publication, and how an embed is shown.
function Ways({ visit, open, embedding, children }: {
    visit: (did: string) => void; open: (publication: Publication) => void; embedding: Embedding; children: ReactNode;
}) {
    return (
        <Visits.Provider value={visit}>
            <Opens.Provider value={open}>
                <Embeds.Provider value={embedding}>{children}</Embeds.Provider>
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
    const [opening, setOpening] = useState(false);
    const [unopened, setUnopened] = useState(false);
    const object = publication.memeplex!;
    const withdrawn = publication.state === 'withdrawn';

    const open = async () => {
        setOpening(true);
        setUnopened(false);
        try {
            const now = await asItIs(read, publication.did!);

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

    return (
        <>
            <header>
                <Identity did={object.author} />
                <time>{when(publication)}</time>
            </header>
            {object.title && <h3>{object.title}</h3>}
            <Body object={object} embeds={false} />
            {withdrawn && <p className="muted note">Its author has since withdrawn this.</p>}
            {unopened && <p role="alert" className="error">It cannot be opened as it is. Refresh, and try once more.</p>}
            {onOpen && !withdrawn && publication.did && <button className="quiet" disabled={opening} onClick={open}>Open</button>}
        </>
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
            const now = await asItIs(read, shown!.did!);

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

    return (
        <article className="post boost">
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
                        <time>{when(shown)}</time>
                    </header>
                    {shown.memeplex!.title && <h3>{shown.memeplex!.title}</h3>}
                    <Body object={shown.memeplex!} />
                    {withdrawn && <p className="muted note">Its author has since withdrawn this post.</p>}
                </div>
            )}
            {unopened && <p role="alert" className="error">The post cannot be opened as it is. Refresh, and try once more.</p>}
            <footer>
                {onOpen && shown && !withdrawn && <button className="quiet" disabled={opening} onClick={open}>Open</button>}
                {onWithdraw && <button className="quiet" onClick={onWithdraw}>Undo boost</button>}
                <Copy text={address} label="Copy DID" unable={`Could not copy. The DID is ${address}`} />
            </footer>
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
function Post({ publication, onOpen, onWithdraw, full, answers }: {
    publication: Publication; onOpen?: (publication: Publication) => void; onWithdraw?: () => void; full?: Api; answers?: boolean;
}) {
    const object = publication.memeplex;

    if (publication.state === 'withdrawn' || !object) {
        return <article className="post muted">Withdrawn</article>;
    }

    const target = boosted(object);

    if (target) {
        return <Boost publication={publication} target={target} onOpen={onOpen} onWithdraw={onWithdraw} />;
    }

    return (
        <article className="post">
            <header>
                <Identity did={object.author} />
                <time>{when(publication)}</time>
            </header>
            {answers && object.kind === 'reply' && typeof object.target === 'string' && (
                <Answered did={object.target} version={typeof object.targetVersion === 'string' ? object.targetVersion : undefined} />
            )}
            {object.title && <h3>{object.title}</h3>}
            <Body object={object} full={full && publication.did ? { api: full, did: publication.did, version: shownVersion(publication) } : undefined} />
            <footer>
                {onOpen && <button className="quiet" onClick={() => onOpen(publication)}>Open</button>}
                {onWithdraw && <button className="quiet" onClick={onWithdraw}>Withdraw</button>}
                {/* A post's DID is its address: what another wallet or node resolves it by. */}
                {publication.did && <Copy text={publication.did} label="Copy DID" unable={`Could not copy. The DID is ${publication.did}`} />}
                {/* What another text is given to show this version of the post inside it. */}
                {publication.did && shownVersion(publication) && (
                    <Copy text={embedFor(publication)} label="Copy embed" unable={`Could not copy. The embed is ${embedFor(publication)}`} />
                )}
            </footer>
        </article>
    );
}

// What an article shows above its body, as it was written.
function Heading({ title, summary }: { title: string; summary: string }) {
    return (
        <>
            {title.trim() && <h3>{title.trim()}</h3>}
            {summary.trim() && <p className="text summary">{summary.trim()}</p>}
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
function Draft({ label, value, onChange, disabled, rows, before, published = value }: {
    label: string;
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
    rows: number;
    before?: ReactNode;
    published?: string;
}) {
    const [showing, setShowing] = useState<'write' | 'preview'>('write');
    const id = useId();
    const tabs = useRef<Partial<Record<'write' | 'preview', HTMLButtonElement | null>>>({});

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
                        <textarea value={value} disabled={disabled} onChange={event => onChange(event.target.value)} rows={rows} />
                    </label>
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

function Composer({ label, onPublish }: { label: string; onPublish: (text: string) => Promise<void> }) {
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    const publish = async () => {
        setBusy(true);
        setError('');
        try {
            await onPublish(text.trim());
            setText('');
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
            <Draft label={label} value={text} onChange={setText} disabled={busy} rows={3} published={text.trim()} />
            {error && <p role="alert" className="error">{error}</p>}
            <button disabled={busy || !text.trim()} onClick={publish}>Publish</button>
        </div>
    );
}

// An article: a post with a title, whose body the service stores apart from
// the entry. The summary is what a timeline shows of it.
function ArticleComposer({ onPublish, onCancel }: {
    onPublish: (article: { title: string; summary?: string; body: string }) => Promise<void>;
    onCancel: () => void;
}) {
    const [title, setTitle] = useState('');
    const [summary, setSummary] = useState('');
    const [body, setBody] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    const publish = async () => {
        setBusy(true);
        setError('');
        try {
            await onPublish({ title: title.trim(), ...(summary.trim() ? { summary: summary.trim() } : {}), body });
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
                Summary
                <textarea value={summary} disabled={busy} onChange={event => setSummary(event.target.value)} rows={2} />
            </label>
            <Draft
                label="Article"
                value={body}
                onChange={setBody}
                disabled={busy}
                rows={14}
                before={<Heading title={title} summary={summary} />}
            />
            {error && <p role="alert" className="error">{error}</p>}
            <button disabled={busy || !title.trim() || !body.trim()} onClick={publish}>Publish article</button>{' '}
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
    // An article's title, which is shown as it was written.
    title?: string;
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
                ...(typeof each.title === 'string' ? { title: each.title } : {}),
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
            {entry.title !== undefined && <h3>{entry.title}</h3>}
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
interface Sent {
    what: string;
    shown: (responses: Responses) => boolean;
    // Responses that share one replace each other: the reader's rating is one
    // object, and its last thumb is the one that waits.
    replaces?: string;
}

function Respond({ api, me, grants, target }: { api: Api; me: Me; grants: Set<string>; target: Publication }) {
    const [responses, setResponses] = useState<Responses | null>(null);
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
    const mine = rated ?? responses?.ratings.ratings.find(
        each => each.memeplex?.author === me.did && grants.has(String(each.memeplex.grant)),
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
    const tag = (value: string, what: string) => send(
        what,
        read => read.tags.some(each => each.tag === value && each.authors.includes(me.did)),
        () => api.publish({ kind: 'tag', ...about, tag: value }),
    );
    const boost = () => {
        let did: string | undefined;

        return send('Your boost', read => read.boosts.some(each => each.did === did), async () => {
            did = await api.publish({ kind: 'post', ...about });
        });
    };

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
            {me.grant && (
                <>
                    {may(me, 'memeplex:post') && <button className="quiet" disabled={busy} onClick={boost}>Boost</button>}
                    {/* Not until the ratings have been read: a thumb has to know
                        whether the reader has a rating to change. A rating the
                        reader has can be changed whatever the scope is since:
                        the permission it was made with covers its edits. */}
                    {(may(me, 'memeplex:rate') || mine) && (
                        <>
                            <button className="quiet" disabled={busy || !responses} onClick={() => rate(1)} aria-label="Thumb up">👍</button>
                            <button className="quiet" disabled={busy || !responses} onClick={() => rate(0)} aria-label="Thumb down">👎</button>
                        </>
                    )}
                    {may(me, 'memeplex:tag') && (
                        <>
                            <button className="quiet" disabled={busy} onClick={() => tag(LIKE, 'Your like')} aria-label="Like">{LIKE}</button>
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
                </>
            )}
            {sent.map((each, index) => <p key={index} className="muted">{each.what} is waiting to be anchored.</p>)}
            <button className="quiet" onClick={load}>Refresh counts</button>
        </div>
    );
}

// The reader's own post or reply, being rewritten. Its kind and what it answers
// stay as they are: an edit that changed them would not be the same object.
function Edit({ api, publication, onDone }: { api: Api; publication: Publication; onDone: (saved?: boolean) => void }) {
    const object = publication.memeplex!;
    const article = object.text === undefined && object.content !== undefined;
    const [text, setText] = useState(object.text ?? '');
    const [title, setTitle] = useState(object.title ?? '');
    const [summary, setSummary] = useState(typeof object.summary === 'string' ? object.summary : '');
    // The body as the service holds it, once it has been read.
    const [held, setHeld] = useState<string | undefined>(undefined);
    const [body, setBody] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        if (!article) {
            return undefined;
        }

        let stale = false;

        api.content(publication.did!, shownVersion(publication)).then(
            read => {
                if (stale) {
                    return;
                }
                if (read === undefined) {
                    setError('This service does not hold the full text, so it cannot be changed here.');
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
            const { content, summary: _summary, ...rest } = fields;

            void _summary;
            await api.edit(publication.did!, {
                ...rest,
                title: title.trim(),
                // A paper has a summary, which may be empty. A post has one or none.
                ...(summary.trim() || object.kind === 'paper' ? { summary: summary.trim() } : {}),
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
        const unchanged = title.trim() === object.title && summary.trim() === (typeof object.summary === 'string' ? object.summary : '') && body === held;

        return (
            <div className="composer">
                <label>
                    Title
                    <input value={title} disabled={busy} onChange={event => setTitle(event.target.value)} />
                </label>
                <label>
                    Summary
                    <textarea value={summary} disabled={busy} onChange={event => setSummary(event.target.value)} rows={2} />
                </label>
                <Draft
                    label="Article"
                    value={body}
                    onChange={setBody}
                    disabled={busy || held === undefined}
                    rows={14}
                    before={<Heading title={title} summary={summary} />}
                />
                {error && <p role="alert" className="error">{error}</p>}
                <button disabled={busy || held === undefined || !title.trim() || !body.trim() || unchanged} onClick={save}>Save</button>{' '}
                <button className="quiet" disabled={busy} onClick={() => onDone()}>Cancel</button>
            </div>
        );
    }

    return (
        <div className="composer">
            <Draft label="Edit" value={text} onChange={setText} disabled={busy} rows={3} published={text.trim()} />
            {error && <p role="alert" className="error">{error}</p>}
            <button disabled={busy || !text.trim() || text.trim() === object.text} onClick={save}>Save</button>{' '}
            <button className="quiet" disabled={busy} onClick={() => onDone()}>Cancel</button>
        </div>
    );
}

function Thread({ api, me, grants, root: opened, mine, waiting, onPublished, onDismiss, onBack, onRead }: {
    api: Api; me: Me; grants: Set<string>; root: Publication; mine: boolean; waiting: Waiting[];
    onPublished: (waiting: Waiting) => void; onDismiss: (did: string) => void; onBack: () => void;
    // Told each time the thread has been read, with the replies it shows: what its
    // texts embed is read anew, and a reply of the reader's that is shown waits no more.
    onRead?: (shown: string[]) => void;
}) {
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

    const load = useCallback(async () => {
        const mine = reads.current += 1;

        try {
            const [thread, latest] = await Promise.all([api.thread(opened.did!), api.publication(opened.did!)]);

            if (mine === reads.current) {
                onRead?.(thread.flatMap(each => each.publication.did ?? []));
                setReplies(thread);
                if (latest) {
                    setRoot(latest);
                    setEdited(of => (of !== undefined && versionKey(latest) !== of ? undefined : of));
                }
                setError('');
            }
        }
        catch (failure) {
            if (mine === reads.current) {
                setError(message(failure));
            }
        }
    }, [api, opened.did, onRead]);

    useEffect(() => {
        load();

        return () => { reads.current += 1; };
    }, [load]);

    // A reply the indexer shows is a publication, and no longer waits.
    const shown = new Set(replies?.map(each => each.publication.did));

    const reply = async (text: string) => {
        const targetVersion = root.versions[root.current ?? 0]?.opid;
        const did = await api.publish({ kind: 'reply', target: root.did, targetVersion, text });

        onPublished({ did, text, target: root.did });
    };

    return (
        <section>
            <button className="quiet" onClick={onBack}>Back</button>{' '}
            <button className="quiet" onClick={load}>Refresh</button>
            <Post publication={root} full={api} />
            {/* One edit at a time: the next is of the post as the last one left it. */}
            {mine && root.state === 'published' && (root.memeplex?.text !== undefined || root.memeplex?.content !== undefined) && !editing && edited === undefined && (
                <button className="quiet" onClick={() => setEditing(true)}>Edit</button>
            )}
            {/* An editor is of one version. When another is shown it starts again from that one,
                so that what is saved was written against what the reader saw. */}
            {editing && <Edit key={versionKey(root)} api={api} publication={root} onDone={saved => { setEditing(false); if (saved) setEdited(versionKey(root)); }} />}
            {edited !== undefined && <p className="muted">Your edit is waiting to be anchored.</p>}
            <Respond api={api} me={me} grants={grants} target={root} />
            {error && <p role="alert" className="error">{error}</p>}
            {replies === null && !error && <p className="muted">Loading replies…</p>}
            {replies?.map(each => (
                <div key={each.publication.did} style={{ marginLeft: `${Math.min(each.depth, 6)}rem` }}>
                    <Post publication={each.publication} />
                </div>
            ))}
            {waiting.filter(each => each.target === root.did && !shown.has(each.did)).map(each => (
                <Awaited key={each.did} entry={each} author={me.did} onDismiss={onDismiss} />
            ))}
            {may(me, 'memeplex:reply') && <Composer label="Reply" onPublish={reply} />}
        </section>
    );
}

// Everything a signed-in reader sees and does. It is mounted for one session
// and unmounted at sign-out, so whatever a request of that session answers
// afterwards has nothing to change: the next reader starts with nothing of the
// last one's.
function Reader({ api, me, onCheck, onSignedOut }: { api: Api; me: Me; onCheck: () => void; onSignedOut: () => void }) {
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
    const [writing, setWriting] = useState(false);
    const [open, setOpen] = useState<Publication | null>(null);
    // The author whose posts alone are shown, where the reader went to one,
    // and whether it is the author's replies that are shown in their place. A
    // reply is part of a conversation: the reader's timeline has none, and an
    // author's are listed apart from the author's posts.
    const [author, setAuthor] = useState<string | null>(null);
    const [replies, setReplies] = useState(false);
    // How many times the timeline has been read from its start.
    const [refreshes, setRefreshes] = useState(0);
    const [following, setFollowing] = useState('');
    const [error, setError] = useState('');

    // Reads the timeline from its start, or the page after what has been given.
    // A read that another has followed, or that the reader's follows have
    // changed under, is dropped: its answer is to a question no longer asked.
    const loadTimeline = useCallback(async (older?: { shown: Publication[]; from: number }) => {
        const mine = reads.current += 1;

        try {
            const page = await api.timeline(
                author ? [author] : [me.did, ...follows.filter(did => did !== me.did)],
                older?.from ?? 0,
                author && replies ? ['reply'] : ['post', 'paper'],
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
    }, [api, me.did, follows, author, replies]);

    useEffect(() => {
        loadTimeline();

        return () => { reads.current += 1; };
    }, [loadTimeline]);

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
        setReplies(false);
        setAuthor(did);
    };

    // Shows an author's posts, or the author's replies. What was shown is the
    // other list, so it is put away until this one is read.
    const list = (which: 'posts' | 'replies') => {
        if ((which === 'replies') === replies) {
            return;
        }
        setTimeline(null);
        setFetched(0);
        setTotal(0);
        setReplies(which === 'replies');
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

    const changeable = (each: Publication) =>
        each.memeplex?.author === me.did && each.state === 'published' && grants.has(String(each.memeplex.grant));

    // What the reader has published that waits to be anchored, where the list
    // shown is one it belongs in: the reader's posts in the reader's timeline
    // and among the reader's posts, and the reader's replies among those.
    const pending = author && author !== me.did ? [] : waiting.filter(each => Boolean(each.target) === replies);

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
    useEffect(() => {
        try {
            localStorage.setItem(WAITING + me.did, JSON.stringify(waiting));
        }
        catch {
            // A browser that keeps nothing still shows what waits, until the page is left.
        }
    }, [me.did, waiting]);

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

                    return Boolean(each.failed) === failed && each.registry === registry
                        ? [each]
                        : [{ did: each.did, text: each.text, title: each.title, target: each.target, registry, ...(failed ? { failed } : {}) }];
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

    return (
        <Ways visit={visit} open={setOpen} embedding={embedding}>
            <main>
                <header className="top">
                    <h1>Memepool</h1>
                    <Identity did={me.did} />
                    <button className="quiet" onClick={signOut}>Sign out</button>
                </header>

                {!me.grant && <GrantPrompt me={me} onChecked={onCheck} />}
                {error && <p role="alert" className="error">{error}</p>}

                {open ? (
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
                        onRead={read}
                    />
                ) : (
                    <>
                        {author && (
                            <section className="card author">
                                <p><button className="quiet" onClick={() => visit(null)}>Back to your timeline</button></p>
                                <Identity did={author} />
                                <p>
                                    {author !== me.did && (follows.includes(author)
                                        ? <button className="quiet" onClick={() => unfollow(author)}>Unfollow</button>
                                        : <button className="quiet" onClick={() => follow(author)}>Follow</button>)}
                                    <Copy text={author} label="Copy DID" unable={`Could not copy. The DID is ${author}`} />
                                </p>
                                <Tabs
                                    label="What of this author's is listed"
                                    tabs={[['posts', 'Posts'], ['replies', 'Replies']]}
                                    selected={replies ? 'replies' : 'posts'}
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
                                <p><button className="quiet" onClick={() => setWriting(true)}>Write an article</button></p>
                            </>
                        )}
                        {!author && may(me, 'memeplex:post') && writing && (
                            <ArticleComposer
                                onCancel={() => setWriting(false)}
                                onPublish={async article => {
                                    const did = await api.publish({ kind: 'post', ...article });

                                    setWaiting(current => [...current, { did, title: article.title }]);
                                    setWriting(false);
                                }}
                            />
                        )}

                        <section id={author ? 'author-list' : undefined} role={author ? 'tabpanel' : undefined} aria-label={author ? (replies ? 'Replies' : 'Posts') : undefined}>
                            <h2>{author ? (replies ? 'Replies' : 'Posts') : 'Timeline'} <button className="quiet" onClick={() => loadTimeline()}>Refresh</button></h2>
                            {pending.map(each => <Awaited key={each.did} entry={each} author={me.did} onDismiss={dismiss} />)}
                            {timeline === null && <p className="muted">Loading…</p>}
                            {timeline?.length === 0 && pending.length === 0 && <p className="muted">Nothing here yet.</p>}
                            <Reads.Provider value={refreshes}>{timeline?.map(each => (
                                <Post
                                    key={each.did}
                                    publication={each}
                                    answers
                                    onOpen={setOpen}
                                    onWithdraw={changeable(each)
                                        ? async () => {
                                            try {
                                                await api.withdraw(each.did!);
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

    if (me === null) {
        return (
            <main>
                <h1>Memepool</h1>
                {error && <p role="alert" className="error">{error}</p>}
                {/* The service has signed this browser in, whatever a read of the
                    grant says next: the reader is shown as signed in, with the
                    way to sign out, from here. */}
                <SignIn api={api} onSignedIn={did => { setMe({ did }); loadMe(); }} pollMs={pollMs} />
            </main>
        );
    }

    return (
        <Avatars.Provider value={api.avatar}>
            <People.Provider value={people}>
                <Publications.Provider value={reading}>
                    {error && <p role="alert" className="error">{error}</p>}
                    <Reader
                        key={session}
                        api={api}
                        me={me}
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
