import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { Api, Me, Person, Publication, Reply, Responses } from './api';
import Markdown from './Markdown';

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

// An identity as the pages name one: its avatar, the name it gives itself and
// its address, where it has them, and its DID, shortened. A name is a claim
// anyone can make, so the DID is always beside it: the DID is who wrote.
function Identity({ did }: { did: string }) {
    const { name, address } = usePerson(did);

    return (
        <span className="identity">
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
        </span>
    );
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
function Body({ object, full }: { object: NonNullable<Publication['memeplex']>; full?: { api: Api; did: string; version?: string } }) {
    const words = object.text ?? (typeof object.summary === 'string' ? object.summary : undefined);
    const article = object.text === undefined && object.content !== undefined;

    return (
        <>
            {/* A post's text is Markdown. An article's summary is a line about it, shown as it is. */}
            {words && (article ? <p className="text summary">{words}</p> : <Markdown text={words} />)}
            {article && (full ? <Article api={full.api} did={full.did} version={full.version} /> : <p className="muted">Open it to read the full text.</p>)}
            {!words && !article && object.target && (
                <p className="muted">A boost of <span className="mono" title={object.target}>{short(object.target)}</span></p>
            )}
        </>
    );
}

// Who is asked for a publication by its DID: the indexer.
const Publications = createContext<((did: string) => Promise<Publication | undefined>) | undefined>(undefined);

// Counts the reads of the list a publication is shown in. What a boost shows
// is read apart from that list, and is read anew when the list is.
const Reads = createContext(0);

// How what is shown stands to the version a boost cites: it is that version,
// it is a later one of a post whose history still holds the cited one, or the
// cited one is not in the history, which a replay can bring about.
type Cited = 'shown' | 'edited' | 'displaced';

// How many boosts of boosts are followed to the post they pass on.
const BOOST_DEPTH = 5;

// The object a boost is of, or nothing for an object that is not a boost: a
// post with no words of its own that names another.
const boosted = (object: NonNullable<Publication['memeplex']>): string | undefined =>
    (object.kind === 'post' && object.text === undefined && object.content === undefined && typeof object.target === 'string' ? object.target : undefined);

// A boost, shown as what it passes on: the post it is of, as that post is
// shown, under a line saying who boosted it. Opening it opens the post, which
// is what there is to read and answer.
function Boost({ publication, target, onOpen, onWithdraw }: {
    publication: Publication; target: string; onOpen?: (publication: Publication) => void; onWithdraw?: () => void;
}) {
    const read = useContext(Publications);
    const reads = useContext(Reads);
    // The post boosted, with the target it was read for: not read yet, or one
    // the indexer cannot show.
    const [held, setHeld] = useState<{ target: string; original: Publication | null; cited?: Cited } | undefined>(undefined);
    const author = publication.memeplex!.author;
    const version = typeof publication.memeplex!.targetVersion === 'string' ? publication.memeplex!.targetVersion : undefined;

    useEffect(() => {
        let current = true;
        // A boost of a boost passes on what that one does. The post is found by
        // following them, no further than a few and never to one already seen.
        //
        // Each boost names the version of what it passes on, and what is found
        // at each step is held against it: the post itself, and every boost on
        // the way to it.
        const find = async (): Promise<{ original: Publication | null; cited?: Cited }> => {
            const seen = new Set<string>([publication.did ?? '']);
            let next = target;
            let wanted = version;
            let cited = 'shown' as Cited;

            for (let depth = 0; read && depth < BOOST_DEPTH && !seen.has(next); depth += 1) {
                seen.add(next);
                const found = await read(next);
                const further = found?.state === 'published' && found.memeplex ? boosted(found.memeplex) : undefined;

                const want = wanted;

                if (found && want && want !== shownVersion(found)) {
                    // A version that is in the history has been followed by
                    // another. One that is not was put out of it.
                    const kept = found.versions.some(each => each.opid === want);

                    cited = !kept || cited === 'displaced' ? 'displaced' : 'edited';
                }
                if (!further) {
                    return { original: found ?? null, cited };
                }
                next = further;
                wanted = typeof found!.memeplex!.targetVersion === 'string' ? found!.memeplex!.targetVersion : undefined;
            }

            return { original: null };
        };

        find().then(
            found => { if (current) setHeld({ target, ...found }); },
            () => { if (current) setHeld({ target, original: null }); },
        );

        return () => { current = false; };
    }, [read, target, version, reads, publication.did]);

    // What was read for another target is not this one's. What was read for
    // this one stays while it is read anew.
    const original = held?.target === target ? held.original : undefined;
    const address = original?.did ?? target;

    const found = original && original.state !== 'withdrawn' && original.memeplex ? original : undefined;
    // A version put out of a post's history is not stood in for by another.
    const displaced = Boolean(found) && held?.cited === 'displaced';
    const shown = displaced ? undefined : found;

    return (
        <article className="post boost">
            <p className="boosted">
                <Identity did={author} />
                <span>boosted</span>
                <time>{when(publication)}</time>
            </p>
            {original === undefined && <p className="muted">Reading the post.</p>}
            {displaced && (
                <p className="muted">
                    The version boosted is no longer in the history of{' '}
                    <span className="mono" title={address}>{short(address)}</span>
                </p>
            )}
            {original !== undefined && !found && (
                <p className="muted">
                    {original?.state === 'withdrawn' ? 'The post was withdrawn: ' : 'The post cannot be shown: '}
                    <span className="mono" title={address}>{short(address)}</span>
                </p>
            )}
            {/* A boost is of one version of a post. What is shown is the post as it
                is, so a post that has changed since is said to have. */}
            {shown && held?.cited === 'edited' && (
                <p className="muted changed">The post has been edited since it was boosted. This is the post as it is.</p>
            )}
            {shown && (
                <div className="original">
                    <header>
                        <Identity did={shown.memeplex!.author} />
                        <time>{when(shown)}</time>
                    </header>
                    {shown.memeplex!.title && <h3>{shown.memeplex!.title}</h3>}
                    <Body object={shown.memeplex!} />
                </div>
            )}
            <footer>
                {onOpen && shown && <button className="quiet" onClick={() => onOpen(shown)}>Open</button>}
                {onWithdraw && <button className="quiet" onClick={onWithdraw}>Undo boost</button>}
                <Copy text={address} label="Copy DID" unable={`Could not copy. The DID is ${address}`} />
            </footer>
        </article>
    );
}

function Post({ publication, onOpen, onWithdraw, full }: {
    publication: Publication; onOpen?: (publication: Publication) => void; onWithdraw?: () => void; full?: Api;
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
            {object.title && <h3>{object.title}</h3>}
            <Body object={object} full={full && publication.did ? { api: full, did: publication.did, version: shownVersion(publication) } : undefined} />
            <footer>
                {onOpen && <button className="quiet" onClick={() => onOpen(publication)}>Open</button>}
                {onWithdraw && <button className="quiet" onClick={onWithdraw}>Withdraw</button>}
                {/* A post's DID is its address: what another wallet or node resolves it by. */}
                {publication.did && <Copy text={publication.did} label="Copy DID" unable={`Could not copy. The DID is ${publication.did}`} />}
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

function Thread({ api, me, grants, root: opened, mine, waiting, onPublished, onBack }: {
    api: Api; me: Me; grants: Set<string>; root: Publication; mine: boolean; waiting: Waiting[];
    onPublished: (waiting: Waiting) => void; onBack: () => void;
}) {
    // The post as the indexer last showed it, which an edit changes once it is anchored.
    const [root, setRoot] = useState(opened);
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
    }, [api, opened.did]);

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
                <article key={each.did} className="post waiting">
                    {each.text !== undefined && <Markdown text={each.text} />}
                    <footer className="muted">Waiting to be anchored</footer>
                </article>
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
    const [waiting, setWaiting] = useState<Waiting[]>([]);
    // Whether the reader is writing an article, which has a form of its own.
    const [writing, setWriting] = useState(false);
    const [open, setOpen] = useState<Publication | null>(null);
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
            const page = await api.timeline([me.did, ...follows.filter(did => did !== me.did)], older?.from ?? 0);

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
            setFetched((older?.from ?? 0) + page.publications.length);
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
    }, [api, me.did, follows]);

    useEffect(() => {
        loadTimeline();

        return () => { reads.current += 1; };
    }, [loadTimeline]);

    const follow = () => {
        const did = following.trim();

        if (!did.startsWith('did:') || follows.includes(did)) {
            return;
        }

        const next = [...follows, did];

        localStorage.setItem(FOLLOWS, JSON.stringify(next));
        setFollows(next);
        setFollowing('');
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
                    api={api}
                    me={me}
                    grants={grants}
                    root={open}
                    mine={changeable(open)}
                    waiting={waiting}
                    onPublished={published => setWaiting(current => [...current, published])}
                    onBack={() => { setOpen(null); loadTimeline(); }}
                />
            ) : (
                <>
                    {may(me, 'memeplex:post') && !writing && (
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
                    {may(me, 'memeplex:post') && writing && (
                        <ArticleComposer
                            onCancel={() => setWriting(false)}
                            onPublish={async article => {
                                const did = await api.publish({ kind: 'post', ...article });

                                setWaiting(current => [...current, { did, title: article.title }]);
                                setWriting(false);
                            }}
                        />
                    )}

                    <section>
                        <h2>Timeline <button className="quiet" onClick={() => loadTimeline()}>Refresh</button></h2>
                        {waiting.filter(each => !each.target).map(each => (
                            <article key={each.did} className="post waiting">
                                {each.title !== undefined && <h3>{each.title}</h3>}
                                {each.text !== undefined && <Markdown text={each.text} />}
                                <footer className="muted">Waiting to be anchored</footer>
                            </article>
                        ))}
                        {timeline === null && <p className="muted">Loading…</p>}
                        {timeline?.length === 0 && waiting.length === 0 && <p className="muted">Nothing here yet.</p>}
                        <Reads.Provider value={refreshes}>{timeline?.map(each => (
                            <Post
                                key={each.did}
                                publication={each}
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

                    <section className="card">
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
                        <button disabled={!following.trim().startsWith('did:')} onClick={follow}>Follow</button>
                    </section>
                </>
            )}
        </main>
    );
}

export default function App({ api, pollMs = 3000 }: { api: Api; pollMs?: number }) {
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
                <Publications.Provider value={api.publication}>
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
