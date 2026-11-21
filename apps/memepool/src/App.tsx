import { useCallback, useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { Api, Me, Publication, Reply } from './api';

// Memepool's pages. A reader signs in with a wallet, grants the service once,
// and then reads the authors they follow and publishes posts and replies.
//
// Follows are the reader's own: kept in this browser and published nowhere.

const FOLLOWS = 'memepool.follows';

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

function SignIn({ api, onSignedIn, pollMs }: { api: Api; onSignedIn: () => void; pollMs: number }) {
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
                onSignedIn();
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
                        </>
                    )}
                    <button onClick={onChecked}>I have approved it</button>
                </>
            )}
        </section>
    );
}

// What an object says. A short one says it in `text`. A longer one keeps its
// words apart, under `content`, and a paper gives a `summary` of them. A post
// with neither and a `target` is a boost of that object.
function Body({ object }: { object: NonNullable<Publication['memeplex']> }) {
    const words = object.text ?? (typeof object.summary === 'string' ? object.summary : undefined);

    if (words) {
        return (
            <>
                <p className="text">{words}</p>
                {object.text === undefined && object.content !== undefined && (
                    <p className="muted">The full text is kept apart from this entry, and this page does not show it yet.</p>
                )}
            </>
        );
    }
    if (object.content !== undefined) {
        return <p className="muted">The text is kept apart from this entry, and this page does not show it yet.</p>;
    }
    if (object.target) {
        return <p className="muted">A boost of <span className="mono" title={object.target}>{short(object.target)}</span></p>;
    }

    return null;
}

function Post({ publication, onOpen, onWithdraw }: { publication: Publication; onOpen?: () => void; onWithdraw?: () => void }) {
    const object = publication.memeplex;

    if (publication.state === 'withdrawn' || !object) {
        return <article className="post muted">Withdrawn</article>;
    }

    return (
        <article className="post">
            <header>
                <span className="mono" title={object.author}>{short(object.author)}</span>
                <time>{when(publication)}</time>
            </header>
            {object.title && <h3>{object.title}</h3>}
            <Body object={object} />
            <footer>
                {onOpen && <button className="quiet" onClick={onOpen}>Open</button>}
                {onWithdraw && <button className="quiet" onClick={onWithdraw}>Withdraw</button>}
            </footer>
        </article>
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
            <label>
                {label}
                <textarea value={text} disabled={busy} onChange={event => setText(event.target.value)} rows={3} />
            </label>
            {error && <p role="alert" className="error">{error}</p>}
            <button disabled={busy || !text.trim()} onClick={publish}>Publish</button>
        </div>
    );
}

// Something the user has published that its chain has not anchored yet. It is
// not a publication until then, and the indexer does not show it.
interface Waiting {
    did: string;
    text: string;
    target?: string;
}

function Thread({ api, me, root, waiting, onPublished, onBack }: {
    api: Api; me: Me; root: Publication; waiting: Waiting[]; onPublished: (waiting: Waiting) => void; onBack: () => void;
}) {
    const [replies, setReplies] = useState<Reply[] | null>(null);
    const [error, setError] = useState('');
    const reads = useRef(0);

    const load = useCallback(async () => {
        const mine = reads.current += 1;

        try {
            const thread = await api.thread(root.did!);

            if (mine === reads.current) {
                setReplies(thread);
                setError('');
            }
        }
        catch (failure) {
            if (mine === reads.current) {
                setError(message(failure));
            }
        }
    }, [api, root.did]);

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
            <Post publication={root} />
            {error && <p role="alert" className="error">{error}</p>}
            {replies === null && !error && <p className="muted">Loading replies…</p>}
            {replies?.map(each => (
                <div key={each.publication.did} style={{ marginLeft: `${Math.min(each.depth, 6)}rem` }}>
                    <Post publication={each.publication} />
                </div>
            ))}
            {waiting.filter(each => each.target === root.did && !shown.has(each.did)).map(each => (
                <article key={each.did} className="post waiting">
                    <p className="text">{each.text}</p>
                    <footer className="muted">Waiting to be anchored</footer>
                </article>
            ))}
            {me.grant && <Composer label="Reply" onPublish={reply} />}
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
    const [open, setOpen] = useState<Publication | null>(null);
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
                <span className="mono" title={me.did}>{short(me.did)}</span>
                <button className="quiet" onClick={signOut}>Sign out</button>
            </header>

            {!me.grant && <GrantPrompt me={me} onChecked={onCheck} />}
            {error && <p role="alert" className="error">{error}</p>}

            {open ? (
                <Thread
                    api={api}
                    me={me}
                    root={open}
                    waiting={waiting}
                    onPublished={published => setWaiting(current => [...current, published])}
                    onBack={() => { setOpen(null); loadTimeline(); }}
                />
            ) : (
                <>
                    {me.grant && (
                        <Composer
                            label="Post"
                            onPublish={async text => {
                                const did = await api.publish({ kind: 'post', text });

                                setWaiting(current => [...current, { did, text }]);
                            }}
                        />
                    )}

                    <section>
                        <h2>Timeline <button className="quiet" onClick={() => loadTimeline()}>Refresh</button></h2>
                        {waiting.filter(each => !each.target).map(each => (
                            <article key={each.did} className="post waiting">
                                <p className="text">{each.text}</p>
                                <footer className="muted">Waiting to be anchored</footer>
                            </article>
                        ))}
                        {timeline === null && <p className="muted">Loading…</p>}
                        {timeline?.length === 0 && waiting.length === 0 && <p className="muted">Nothing here yet.</p>}
                        {timeline?.map(each => (
                            <Post
                                key={each.did}
                                publication={each}
                                onOpen={() => setOpen(each)}
                                onWithdraw={me.grant && each.memeplex?.author === me.did && each.state === 'published'
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
                        ))}
                        {timeline && fetched < total && (
                            <button className="quiet" onClick={() => loadTimeline({ shown: timeline, from: fetched })}>Older</button>
                        )}
                    </section>

                    <section className="card">
                        <h2>Following</h2>
                        <p className="muted">Kept in this browser. Nobody is told whom you follow.</p>
                        {follows.map(did => (
                            <p key={did}>
                                <span className="mono" title={did}>{short(did)}</span>{' '}
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
    const [me, setMe] = useState<Me | null | undefined>(undefined);
    const [error, setError] = useState('');
    // Counts sign-outs, so that an answer about who was signed in before one is
    // not taken for who is signed in after it.
    const sessions = useRef(0);
    const [session, setSession] = useState(0);

    const loadMe = useCallback(async () => {
        const mine = sessions.current;

        try {
            const read = await api.me() ?? null;

            if (mine === sessions.current) {
                setMe(read);
                setError('');
            }
        }
        catch (failure) {
            // The service did not say the reader is signed out, so someone who
            // was signed in still is, and keeps the way to sign out.
            if (mine === sessions.current) {
                setMe(current => current ?? null);
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
                <SignIn api={api} onSignedIn={loadMe} pollMs={pollMs} />
            </main>
        );
    }

    return (
        <>
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
        </>
    );
}
