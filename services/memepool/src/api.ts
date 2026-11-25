import { randomBytes } from 'node:crypto';
import express from 'express';
import { imageSize } from 'image-size';
import type { Request, Response, NextFunction } from 'express';
import { PERMITTED_REGISTRIES, actionFor } from '@didcid/memeplex';
import { MemeplexClientError, allows, liveGrants } from '@didcid/memeplex/client';
import type { MemeplexClient, ObjectFields, UsableGrant } from '@didcid/memeplex/client';

// The Memepool service over HTTP. Memepool is a Memeplex client: an agent DID
// whose key this service holds. A user signs in by answering a challenge from
// their wallet, grants the service's DID from that wallet, and the service then
// publishes what the user writes, under the user's grant.
//
// Reading is not here. A reader's timelines and threads come from the indexer.

// The part of a Keymaster that signs a user in.
export interface LoginKeymaster {
    createChallenge(challenge?: Record<string, unknown>): Promise<string>;
    verifyResponse(response: string, options?: { retries?: number }): Promise<{ challenge: string; match: boolean; responder?: string }>;
    resolveDID(did: string, options?: { versionSequence?: number; versionId?: string }): Promise<{
        didDocument?: { controller?: string };
        didDocumentData?: unknown;
        didDocumentRegistration?: { registry?: string };
        didDocumentMetadata?: { versionSequence?: string | number; deactivated?: boolean; versionId?: string };
    }>;
    // Makes an image asset of the bytes, which the node's IPFS pins. Needed
    // only by a service that takes images.
    createImage?(buffer: Buffer, options?: { registry?: string; filename?: string }): Promise<string>;
}

// Where the service keeps the content of what it publishes: its node's IPFS,
// which pins what is added to it. `add` gives the CID of a text. Reading one
// back is the node's to do, for whoever asks it.
export interface ContentStore {
    add(text: string): Promise<string>;
}

// Where the service reads an image from: its node's IPFS. `get` gives the bytes
// of a CID, or nothing when the node has none or they are more than `limit`.
export interface ImageStore {
    get(cid: string, limit: number): Promise<Buffer | null>;
}

// How the service learns whose an address is: it asks the address's domain,
// which is what gives out its names. `owner` gives the DID the domain says the
// address belongs to, or nothing when it says none or cannot be asked. The
// asking ends when `signal` says to: the service waits only so long.
export interface AddressBook {
    owner(address: string, signal: AbortSignal): Promise<string | null>;
}

export interface MemepoolOptions {
    client: MemeplexClient;
    keymaster: LoginKeymaster;
    // The name the service gives itself in a grant request.
    name: string;
    // The address users reach the service at, such as `https://node/memepool`.
    // With it, a challenge names the service's callback, and a wallet sends
    // its answer there. Without it, a user carries the answer back by hand.
    publicURL?: string;
    version: { version: string; commit: string };
    // The registries the service's node supports, as a list or as a way to ask
    // the node. The permitted ones among them are where the service can
    // publish: a grant request lists them, and a grant on another is not one the
    // service can use. With none, the service can ask for no grant.
    //
    // A node drops a registry while that registry's queue is full and takes it
    // back afterwards, so the service asks each time it needs to know and
    // counts a registry it has seen as one it can publish on.
    registries: string[] | (() => Promise<string[]>);
    // Where the body of an article is stored. The client that publishes an
    // object pins the content the object references, so the service stores a
    // body itself and takes no reference to bytes it has not stored. Without a
    // store it publishes no body.
    content?: ContentStore;
    // Where an author's avatar is read from. Without it the service serves no
    // avatar, and the pages show every author without one.
    images?: ImageStore;
    // Who is asked whose an address is. Without it the service confirms no
    // address, and names no author by one.
    addresses?: AddressBook;
    // How many images one user may have the service store in an hour, and the
    // registry their assets are made on. An image is an Archon asset and not a
    // Memeplex object, so it is on no grant's registry: it is made where it
    // costs nothing and can be embedded at once.
    imagesPerHour?: number;
    imageRegistry?: string;
    // A directory of static files to serve beside the API: the built pages.
    // Without it the service is its API alone.
    pagesDir?: string;
    // Milliseconds a challenge may wait for its answer, and a session lasts.
    challengeLifetime?: number;
    sessionLifetime?: number;
    // How many challenges the service issues in a minute. Each is an asset the
    // node stores and gossips, and anyone can ask for one.
    challengesPerMinute?: number;
    now?: () => number;
}

const COOKIE = 'memepool_session';
// Set with a challenge, on the browser that asked for it.
const ASKED = 'memepool_challenge';
// How many challenges and sessions are kept at once. Anyone can ask for a
// challenge, so the oldest are dropped past this.
const MAX_HELD = 10_000;
// How long a session is shown one grant request, which is valid for an hour.
const REQUEST_REUSE = 50 * 60_000;
// The largest body the service stores, in bytes of UTF-8.
export const BODY_LIMIT = 200_000;
// The largest avatar the service serves, in bytes, and how long a browser may
// keep one before asking again, in seconds.
export const AVATAR_LIMIT = 1_000_000;
const AVATAR_KEPT = 300;
// The kinds of image served as an avatar. SVG is not one: it is a document that
// can hold a script, and this is served from the pages' own origin.
const AVATAR_TYPES = new Set(['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp']);
// An image embedded in text, as Text formatting bounds one: its kinds, its
// bytes, and the pixels its asset says it has.
const IMAGE_TYPES = new Set(['image/gif', 'image/jpeg', 'image/png', 'image/webp']);
export const IMAGE_LIMIT = 10_000_000;
const IMAGE_PIXELS = 40_000_000;
// The longest name the service passes on, in characters, and the longest
// address it asks a domain about.
const NAME_LIMIT = 64;
const ADDRESS_LIMIT = 254;
// How long what the service found out about an identity is kept, and how long
// an address's domain is given to answer, in milliseconds.
const IDENTITY_KEPT = 10 * 60_000;
const ADDRESS_TIMEOUT = 5_000;
// An address the service asks about and shows: a name at a host name, in the
// letters, digits and marks both are written in. One with anything else in it
// is not asked about, since what is confirmed has to be what is read: a
// character that changes the direction of text makes an address at one domain
// read as an address at another.
const ADDRESS = /^[a-z0-9._+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
// The largest request that publishes or changes an object. A body arrives as a
// JSON string, in which one byte can be written as six (`\u000a`), beside the
// object's other fields.
const OBJECT_REQUEST_LIMIT = BODY_LIMIT * 6 + 256 * 1024;
// What stands for the reference to a body while the object is checked, before
// the body is stored.
const UNSTORED = 'bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
// The kinds that have a body, and the members of an object that refer to
// content by its CID.
const BODY_KINDS = ['post', 'paper'];
const REFERENCES = ['content', 'pdf', 'source'];
// How many answers sent to the callback are verified at once.
const MAX_VERIFYING = 8;

// A map whose entries end at a time, and that holds no more than a limit.
class Expiring<V> {
    private readonly held = new Map<string, { value: V; ends: number }>();

    constructor(private readonly lifetime: number, private readonly now: () => number) { }

    set(key: string, value: V): void {
        if (this.held.size >= MAX_HELD) {
            for (const [each, { ends }] of this.held) {
                if (ends <= this.now()) this.held.delete(each);
            }
        }
        if (this.held.size >= MAX_HELD) {
            this.held.delete(this.held.keys().next().value as string);
        }
        this.held.set(key, { value, ends: this.now() + this.lifetime });
    }

    get(key: string): V | undefined {
        const entry = this.held.get(key);

        if (entry && entry.ends <= this.now()) {
            this.held.delete(key);
            return undefined;
        }

        return entry?.value;
    }

    // Removes an entry, and says whether it was there and had not ended.
    take(key: string): boolean {
        const live = this.get(key) !== undefined;

        this.held.delete(key);

        return live;
    }
}

function cookieOf(req: Request, wanted = COOKIE): string | undefined {
    for (const part of (req.headers.cookie ?? '').split(';')) {
        const [name, ...value] = part.trim().split('=');

        if (name === wanted) {
            return value.join('=');
        }
    }

    return undefined;
}

type Signed = Request & { user: string };

export function createMemepoolRouter(options: MemepoolOptions): express.Router {
    const { client, keymaster, name, version, content, images, addresses } = options;
    const seen = new Set<string>();
    const registriesNow = async (): Promise<string[]> => {
        try {
            const supported = typeof options.registries === 'function' ? await options.registries() : options.registries;

            supported.forEach(registry => seen.add(registry));
        }
        catch {
            // The node did not say. What it has said before stands.
        }

        return PERMITTED_REGISTRIES.filter(registry => seen.has(registry));
    };
    // Whether a grant is on a registry the service's node supports. One that
    // is not is in force and of no use here.
    const reachable = (registries: string[]) => (grant: { registry: string }) => registries.includes(grant.registry);
    const callback = options.publicURL ? `${options.publicURL.replace(/\/+$/, '')}/api/v1/callback` : undefined;
    const now = options.now ?? Date.now;
    // A challenge's browser mark, and the challenge a mark was set with.
    const challenges = new Expiring<string>(options.challengeLifetime ?? 10 * 60_000, now);
    const marks = new Expiring<string>(options.challengeLifetime ?? 10 * 60_000, now);
    // The identities that answered a challenge through the callback. A
    // challenge is an asset anyone on the network can see, so anyone can
    // answer one: more than one answer is no answer.
    const answered = new Expiring<Set<string>>(options.challengeLifetime ?? 10 * 60_000, now);
    let verifying = 0;
    const perMinute = options.challengesPerMinute ?? 60;
    let issued: number[] = [];
    const sessions = new Expiring<string>(options.sessionLifetime ?? 24 * 60 * 60_000, now);
    const router = express.Router();

    // An object may carry an article's body. Nothing else the service is sent
    // is large.
    const small = express.json({ limit: '256kb' });
    const large = express.json({ limit: OBJECT_REQUEST_LIMIT });

    router.use((req, res, next) => (req.path === '/objects' || req.path.startsWith('/objects/') ? large : small)(req, res, next));

    router.get('/ready', (_req, res) => {
        res.json(true);
    });

    router.get('/version', (_req, res) => {
        res.json(version);
    });

    router.get('/config', async (_req, res) => {
        res.json({ name, did: await client.did() });
    });

    // A challenge for a wallet to answer, and the link that hands it to one.
    //
    // The challenge is bound to the browser that asked: a wallet publishes its
    // answer as an asset anyone can see the DID of, and without this whoever
    // submitted that DID first would be signed in.
    router.get('/challenge', async (req, res) => {
        issued = issued.filter(at => at > now() - 60_000);

        if (issued.length >= perMinute) {
            res.status(429).json({ error: 'too many challenges; try again in a minute' });
            return;
        }
        issued.push(now());

        const challenge = await keymaster.createChallenge(callback ? { callback } : undefined);

        // A challenge's DID comes from its contents and the moment it was
        // made, so two made in one moment are one challenge. It stays bound to
        // the browser it was first given to.
        if (challenges.get(challenge) !== undefined) {
            res.status(503).json({ error: 'try again' });
            return;
        }

        const asked = randomBytes(32).toString('base64url');

        challenges.set(challenge, asked);
        marks.set(asked, challenge);
        res.cookie(ASKED, asked, { httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/' });
        res.json({ challenge, link: `archon://auth?challenge=${encodeURIComponent(challenge)}` });
    });

    // The answer to a challenge this service issued, which it takes once.
    // Who answered a challenge of this service's with a response, or nothing
    // when the response is not such an answer.
    const answerOf = async (response: string): Promise<{ challenge: string; responder: string } | undefined> => {
        let verified: Awaited<ReturnType<LoginKeymaster['verifyResponse']>>;

        try {
            verified = await keymaster.verifyResponse(response, { retries: 10 });
        }
        catch (error) {
            // What Keymaster says of an answer it cannot read, as distinct from
            // a failure to reach the node.
            if (typeof (error as { type?: unknown }).type !== 'string') {
                throw error;
            }
            return undefined;
        }

        if (!verified.match || !verified.responder || challenges.get(verified.challenge) === undefined) {
            return undefined;
        }

        // Who answered is whoever created the response, with what it holds.
        // An asset's owner can hand it to anyone, with no consent of theirs,
        // and can replace its contents first, so only a response still at its
        // first version shows who wrote it. Versions only increase: one that
        // is at its first here was at its first when it was verified.
        const held = await keymaster.resolveDID(response);

        if (Number(held.didDocumentMetadata?.versionSequence) !== 1 || held.didDocument?.controller !== verified.responder) {
            return undefined;
        }

        return { challenge: verified.challenge, responder: verified.responder };
    };

    // A DID and nothing else: a name would be looked up each time it is read,
    // and need not lead to the same asset twice.
    const responseIn = (req: Request): string | undefined => {
        const { response } = req.body ?? {};

        return typeof response === 'string' && response.startsWith('did:') ? response : undefined;
    };

    // Where a wallet sends its answer, when the challenge names this as its
    // callback. The answer is kept for the browser that asked for the
    // challenge, which collects it at /login: nobody is signed in here, since
    // the wallet is not that browser.
    //
    // A wallet in a browser sends from another origin, so this one route
    // answers a preflight and allows any origin. It allows no credentials, and
    // none of the routes that read a session allow another origin at all.
    const fromAnyOrigin = (res: Response) => res.set('Access-Control-Allow-Origin', '*');

    router.options('/callback', (_req, res) => {
        fromAnyOrigin(res)
            .set('Access-Control-Allow-Methods', 'POST')
            .set('Access-Control-Allow-Headers', 'Content-Type')
            .status(204)
            .end();
    });

    router.post('/callback', async (req, res) => {
        fromAnyOrigin(res);

        const response = responseIn(req);

        if (!response) {
            res.status(400).json({ error: 'expected the DID of a response' });
            return;
        }
        // Anyone can call this, and verifying an answer waits for it to arrive.
        if (verifying >= MAX_VERIFYING) {
            res.status(429).json({ error: 'try again shortly' });
            return;
        }

        verifying += 1;
        try {
            const answer = await answerOf(response);

            if (!answer) {
                res.status(401).json({ error: 'the response does not answer a challenge from this service' });
                return;
            }

            const responders = answered.get(answer.challenge) ?? new Set<string>();

            // Two are enough to know the challenge has no one answer.
            if (responders.size < 2) {
                responders.add(answer.responder);
            }
            answered.set(answer.challenge, responders);
            res.json(true);
        }
        finally {
            verifying -= 1;
        }
    });

    // Signs in the browser that asked for a challenge, once the challenge is
    // answered.
    //
    // With `{ response }`, the answer is in the request: the user carried it
    // from the wallet to this browser.
    //
    // With nothing, the browser is asking whether a wallet has sent an answer
    // to the callback. It is told who answered, and is not signed in: anyone
    // who sees the challenge can answer it, so the user confirms the identity
    // is theirs, with `{ confirm }`, before there is a session.
    router.post('/login', async (req, res) => {
        const refused = () => res.status(401).json({ error: 'the response does not answer a challenge this browser asked for' });
        const asked = cookieOf(req, ASKED);
        const challenge = asked ? marks.get(asked) : undefined;

        // Checked before the node is asked anything: verifying an answer waits
        // for it to arrive, and a caller with no challenge of its own has none.
        if (!asked || !challenge || challenges.get(challenge) !== asked) {
            refused();
            return;
        }

        const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
        let responder: string | undefined;

        if ('response' in body) {
            const response = responseIn(req);

            if (!response) {
                res.status(400).json({ error: 'expected the DID of a response' });
                return;
            }

            const answer = await answerOf(response);

            responder = answer?.challenge === challenge ? answer.responder : undefined;
            if (!responder) {
                refused();
                return;
            }
        }
        else {
            const responders = [...answered.get(challenge) ?? []];

            if (responders.length === 0) {
                res.status(202).json({ waiting: true });
                return;
            }
            if (responders.length > 1) {
                challenges.take(challenge);
                marks.take(asked);
                answered.take(challenge);
                res.status(409).json({ error: 'more than one identity answered this challenge; ask for another' });
                return;
            }
            if (body.confirm !== responders[0]) {
                res.json({ answered: responders[0] });
                return;
            }
            responder = responders[0];
        }

        // Taken once: of two requests that reach here together, or one that
        // reaches here after the challenge has lapsed, only one that still
        // finds the challenge bound to this browser is signed in.
        if (challenges.get(challenge) !== asked || !challenges.take(challenge)) {
            refused();
            return;
        }
        marks.take(asked);
        answered.take(challenge);
        res.clearCookie(ASKED, { path: '/' });

        const token = randomBytes(32).toString('base64url');

        sessions.set(token, responder);
        res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/' });
        res.json({ did: responder });
    });

    router.post('/logout', (req, res) => {
        const token = cookieOf(req);

        if (token) {
            sessions.take(token);
            asked.take(token);
        }
        res.clearCookie(COOKIE, { path: '/' });
        res.json(true);
    });

    // What a publication is shown with is read by anyone, as the publication
    // itself is from the indexer: who its author says they are, their avatar,
    // and the images its text embeds. Everything else is for a user who has
    // signed in.
    const open = (req: Request): boolean => req.method === 'GET' && /^\/(identities|avatars|images)\/[^/]+$/.test(req.path);

    router.use((req: Request, res: Response, next: NextFunction) => {
        const token = cookieOf(req);
        const user = token ? sessions.get(token) : undefined;

        if (!user && open(req)) {
            next();
            return;
        }
        if (!user) {
            res.status(401).json({ error: 'not signed in' });
            return;
        }
        (req as Signed).user = user;
        next();
    });

    // A grant request is an asset the service creates, so a session is shown
    // one and the same request until it nears the end of its hour or the
    // registries the service can publish on change.
    const asked = new Expiring<{ link: Promise<string>; registries: string }>(REQUEST_REUSE, now);
    const asking = (session: string, registries: string[]): Promise<string> => {
        const listed = registries.join(' ');
        const held = asked.get(session);

        if (held?.registries === listed) {
            return held.link;
        }

        // Kept while it is being made, so that two reads at once share one
        // request, and dropped if it could not be made.
        const link = client.requestGrant({ name, registries }).then(made => made.link);

        asked.set(session, { link, registries: listed });
        link.catch(() => {
            if (asked.get(session)?.link === link) {
                asked.take(session);
            }
        });

        return link;
    };

    // Who is signed in, and their grant or the link that asks for one. A user is
    // known by signing in, so their grants are found by who made them. With
    // more than one in force, new objects go under the earliest.
    router.get('/me', async (req, res) => {
        const { user } = req as Signed;
        const found = await client.grantsFrom(user);
        const registries = await registriesNow();
        const [grant, ...others] = liveGrants(found, new Date(now())).filter(reachable(registries));

        if (grant) {
            const live = [grant, ...others];
            // What the reader's grants let the service publish between them:
            // listed only when every one of them is narrowed.
            const actions = live.every(each => each.actions) ? [...new Set(live.flatMap(each => each.actions ?? []))] : undefined;

            res.json({
                did: user,
                grant: grant.did,
                registry: grant.registry,
                ...(others.length ? { others: others.map(each => each.did) } : {}),
                ...(actions ? { actions } : {}),
            });
            return;
        }

        // A grant waiting to be anchored is worth waiting for only when it is
        // on a registry the service can publish on.
        const pending = found
            .filter(each => each.grant.status === 'pending' && reachable(registries)(each.grant))
            .map(each => each.did);

        // A request names where the service can publish. On a node with no
        // registry a grant may be on, there is nothing to ask for.
        if (registries.length === 0) {
            res.json({ did: user, pending, unavailable: 'this node supports no registry a grant may be made on' });
            return;
        }

        res.json({ did: user, pending, link: await asking(cookieOf(req) ?? user, registries) });
    });

    // `of` names the object a request changes. A change goes under the grant
    // the object was published under, which is the only one it counts under.
    const publishing = (act: (req: Signed, grant: UsableGrant) => Promise<unknown>, of?: (req: Request) => string) =>
        async (req: Request, res: Response) => {
            const live = liveGrants(await client.grantsFrom((req as Signed).user), new Date(now())).filter(reachable(await registriesNow()));

            if (live.length === 0) {
                res.status(403).json({ error: 'no grant to publish under' });
                return;
            }

            try {
                let grant: UsableGrant | undefined;

                if (of) {
                    const under = await client.grantOf(of(req));

                    grant = live.find(each => each.did === under);
                    if (!grant) {
                        res.status(400).json({ error: 'the grant this object was published under is not one of yours in force' });
                        return;
                    }
                }
                else {
                    // A new object goes under the earliest grant whose scope
                    // allows its kind. Under another it would be created and
                    // never attributed.
                    const { kind } = fields(req);

                    // What is not a kind the rules know, or not a string at
                    // all, is refused as not valid, below.
                    const known = typeof kind === 'string' && actionFor(kind) !== undefined;

                    grant = known ? live.find(each => allows(each, kind)) : live[0];
                    if (!grant) {
                        res.status(403).json({ error: `your grant does not allow a ${kind}` });
                        return;
                    }
                }

                res.json(await act(req as Signed, grant));
            }
            catch (error) {
                if (error instanceof MemeplexClientError) {
                    res.status(error.reason === 'invalid' ? 400 : 502).json({ error: error.message });
                    return;
                }
                // The node's own refusal of an operation, such as one too large.
                if (typeof (error as { type?: unknown }).type === 'string') {
                    res.status(502).json({ error: 'the node did not accept the operation' });
                    return;
                }
                throw error;
            }
        };

    const fields = (req: Request) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

    // Whether two references are the same: the same members with the same
    // values, in whatever order they are written.
    const sameReference = (one: unknown, other: unknown): boolean => {
        const members = (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value)
            ? Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))
            : undefined);
        const [first, second] = [members(one), members(other)];

        return first !== undefined && second !== undefined && JSON.stringify(first) === JSON.stringify(second);
    };

    const memeplexOf = (doc: Awaited<ReturnType<LoginKeymaster['resolveDID']>>): Record<string, any> | undefined => {
        const data = doc.didDocumentData;
        const memeplex = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>).memeplex : undefined;

        return memeplex && typeof memeplex === 'object' && !Array.isArray(memeplex) && !doc.didDocumentMetadata?.deactivated
            ? memeplex as Record<string, any>
            : undefined;
    };

    // An object the service published, as a version of it states it: the
    // latest, or the one named. Nothing for a DID that is no such object.
    //
    // The service published an object it created and still controls. An asset
    // can be transferred to any identity, which signs nothing, so one the
    // service controls and did not create is someone else's: what it refers to
    // was never stored here, and can be anything. Only its controller can
    // change an asset, so every version of one the service created and still
    // has is the service's own.
    const publishedHere = async (did: string, versionId?: string): Promise<Record<string, any> | undefined> => {
        const own = await client.did();
        const [first, latest] = await Promise.all([keymaster.resolveDID(did, { versionSequence: 1 }), keymaster.resolveDID(did)]);

        if (first.didDocument?.controller !== own || latest.didDocument?.controller !== own) {
            return undefined;
        }

        return memeplexOf(versionId ? await keymaster.resolveDID(did, { versionId }) : latest);
    };

    // What is published for a request: its fields, with a `body` stored and
    // replaced by the reference to it.
    //
    // The service pins the content of what it publishes, so it takes no
    // reference to bytes it did not store. An edit may keep a reference the
    // object already has, which is to content the service stored before.
    //
    // A body is stored only for an object that would be published: what is
    // stored is pinned, and nothing unpins it.
    const stating = async (req: Request, grant: UsableGrant, did?: string): Promise<ObjectFields> => {
        const { body, ...stated } = fields(req) as ObjectFields & { body?: unknown };
        const held = did ? await publishedHere(did).catch(() => undefined) : undefined;

        for (const reference of REFERENCES) {
            if (reference in stated && !sameReference(stated[reference], held?.[reference])) {
                throw new MemeplexClientError('invalid', `the service publishes content it has stored, and has not stored what \`${reference}\` refers to: send the text of an article as \`body\``);
            }
        }
        if (body === undefined) {
            return stated;
        }
        if (!content) {
            throw new MemeplexClientError('invalid', 'this service stores no content, so it publishes no body');
        }
        if (typeof body !== 'string' || body.length === 0) {
            throw new MemeplexClientError('invalid', '`body` is the text of the article');
        }
        if (!BODY_KINDS.includes(stated.kind)) {
            throw new MemeplexClientError('invalid', `a ${String(stated.kind)} has no body`);
        }

        const bytes = Buffer.byteLength(body, 'utf8');

        if (bytes > BODY_LIMIT) {
            throw new MemeplexClientError('invalid', `a body may be ${BODY_LIMIT} bytes, and this is ${bytes}`);
        }

        await client.check(grant, { ...stated, content: { cid: UNSTORED, type: 'text/markdown', bytes } }, did);

        return { ...stated, content: { cid: await content.add(body), type: 'text/markdown', bytes } };
    };

    router.post('/objects', publishing(async (req, grant) => ({ did: await client.publish(grant, await stating(req, grant)) })));

    router.put('/objects/:did', publishing(async (req, grant) => {
        const did = String(req.params.did);

        await client.edit(did, grant, await stating(req, grant, did));
        return true;
    }, req => String(req.params.did)));

    // The body of an article the service published, which is content it
    // stored. It reads no other: a reference in an object someone else made
    // can be to anything, of any size. `versionId` names the version whose body
    // is wanted, which is how a reader gets the body of the version it shows.
    // Where an object the user published through this service stands: whether
    // it is anchored and attributed, still waits, or never will be. The pages
    // hold what a user published until the indexer shows it, and ask this to
    // know which of those is so.
    //
    // It is for the object's author, and of an object the service created: the
    // author is the one its creation names, since nothing later can change it.
    router.get('/objects/:did/state', async (req: Request, res: Response) => {
        const { user } = req as Signed;
        const none = () => { res.status(404).json({ error: 'no object of yours that this service published' }); };
        const did = String(req.params.did);

        if (!isDid(did)) {
            none();
            return;
        }

        try {
            const first = await keymaster.resolveDID(did, { versionSequence: 1 });
            const claimed = memeplexOf(first);

            if (first.didDocument?.controller !== await client.did() || claimed?.author !== user || typeof claimed.grant !== 'string') {
                none();
                return;
            }

            const { state } = await client.publication(did, claimed.grant);
            // The chain it waits on is the one it was created on, which is its grant's.
            const registry = first.didDocumentRegistration?.registry;

            res.json({ state, ...(typeof registry === 'string' ? { registry } : {}) });
        }
        catch {
            none();
        }
    });

    // What an identity says of itself in its document, which is where a wallet
    // puts a name and an address.
    //
    // A name is whatever the identity's owner wrote, and any identity can write
    // any name: it is passed on as a claim, shortened and with nothing in it but
    // what can be printed. An address is a claim on a domain's name, so it is
    // passed on only when that domain says the address is this identity's.
    //
    // Asking a domain is a request to somewhere a stranger chose, so what is
    // found out is kept a while.
    const identities = new Expiring<Promise<{ name?: string; address?: string }>>(IDENTITY_KEPT, now);
    const identityOf = async (did: string): Promise<{ name?: string; address?: string }> => {
        const doc = await keymaster.resolveDID(did);
        const data = doc.didDocumentData as { name?: unknown; address?: unknown } | undefined;

        if (doc.didDocumentMetadata?.deactivated || !data || typeof data !== 'object') {
            return {};
        }

        const found: { name?: string; address?: string } = {};
        const named = typeof data.name === 'string'
            ? data.name.replace(/[\p{C}\p{Z}]+/gu, ' ').trim().slice(0, NAME_LIMIT).trim()
            : '';

        if (named) {
            found.name = named;
        }

        const claimed = typeof data.address === 'string' ? data.address.trim().toLowerCase() : '';

        if (addresses && claimed.length <= ADDRESS_LIMIT && ADDRESS.test(claimed)) {
            // The asking is ended at the deadline, and not only left behind.
            const asking = new AbortController();
            let giveUp: ReturnType<typeof setTimeout> | undefined;
            const owner = await Promise.race([
                addresses.owner(claimed, asking.signal).catch(() => null),
                new Promise<null>(resolve => { giveUp = setTimeout(() => resolve(null), ADDRESS_TIMEOUT); }),
            ]);

            clearTimeout(giveUp);
            asking.abort();
            if (owner === did) {
                found.address = claimed;
            }
        }

        return found;
    };

    router.get('/identities/:did', async (req, res) => {
        const did = String(req.params.did);

        if (!isDid(did)) {
            res.status(404).json({ error: 'no such identity' });
            return;
        }

        let asked = identities.get(did);

        if (!asked) {
            asked = identityOf(did).catch(() => ({}));
            identities.set(did, asked);
        }

        res.setHeader('Cache-Control', 'private, max-age=60');
        res.json({ did, ...await asked });
    });

    // The bytes of an image asset, where it is an image the service serves: of
    // one of the kinds given, no larger than the limit, and no more pixels than
    // it may have. The asset is whatever its owner made it, and the service did
    // not store it. What it says of its own size is its owner's claim, used to
    // refuse early, and no more than the limit is read whatever it says.
    const imageOf = async (did: string, serves: { types: Set<string>; limit: number; pixels?: number; versionId?: string }): Promise<{ type: string; data: Buffer } | null> => {
        if (!images || !isDid(did)) {
            return null;
        }

        const asset = await keymaster.resolveDID(did, serves.versionId === undefined ? undefined : { versionId: serves.versionId });
        const held = asset.didDocumentData as {
            file?: { cid?: unknown; type?: unknown; bytes?: unknown }; image?: { width?: unknown; height?: unknown };
        } | undefined;
        const file = held?.file;
        const type = typeof file?.type === 'string' ? file.type.trim().toLowerCase().replace(/^image\/jpg$/, 'image/jpeg') : '';
        const { width, height } = held?.image && typeof held.image === 'object' ? held.image : {} as { width?: unknown; height?: unknown };

        if (asset.didDocumentMetadata?.deactivated || !held?.image || typeof file?.cid !== 'string' || !serves.types.has(type)
            || (typeof file.bytes === 'number' && file.bytes > serves.limit)
            || (serves.pixels !== undefined && typeof width === 'number' && typeof height === 'number' && width * height > serves.pixels)) {
            return null;
        }

        const data = await images.get(file.cid, serves.limit);

        return data && data.length > 0 && data.length <= serves.limit ? { type, data } : null;
    };

    // An identity's avatar: the image asset its document names as `avatar`,
    // which is where a wallet puts one. It is whatever the identity's owner
    // chose, so it is served only as an image of a kind and size the service
    // accepts, and a browser is told not to take it for anything else.
    router.get('/avatars/:did', async (req, res) => {
        const none = () => { res.status(404).json({ error: 'no avatar' }); };

        // Only a DID is resolved: a name would have the wallet look it up, and
        // an address would have it ask the address's domain.
        if (!images || !isDid(String(req.params.did))) {
            none();
            return;
        }

        try {
            const identity = await keymaster.resolveDID(String(req.params.did));
            const named = (identity.didDocumentData as { avatar?: unknown } | undefined)?.avatar;
            const image = identity.didDocumentMetadata?.deactivated || typeof named !== 'string'
                ? null
                : await imageOf(named.trim(), { types: AVATAR_TYPES, limit: AVATAR_LIMIT });

            if (!image) {
                none();
                return;
            }

            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('Cache-Control', `private, max-age=${AVATAR_KEPT}`);
            res.type(image.type).send(image.data);
        }
        catch {
            none();
        }
    });

    // Takes an image a user means to embed, and makes an image asset of it.
    //
    // The client that publishes an object pins what the object embeds, so the
    // service stores the image itself, on its node's IPFS, as it stores an
    // article's body. The asset is the service's own: it is not a Memeplex
    // object, and what a post says of it is the embed.
    //
    // It is pinned for good, so it is for a user who has granted the service,
    // only so many in an hour, and only an image of a kind and size that text
    // may embed, by what the bytes themselves say.
    const stored = new Map<string, number[]>();
    const hourly = options.imagesPerHour ?? 30;

    router.post('/images', express.raw({ type: 'application/octet-stream', limit: IMAGE_LIMIT }), async (req: Request, res: Response) => {
        const { user } = req as Signed;
        const refuse = (status: number, error: string) => { res.status(status).json({ error }); };

        if (!images || !keymaster.createImage) {
            refuse(501, 'this service stores no images');
            return;
        }
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
            refuse(400, 'expected the bytes of an image, as application/octet-stream');
            return;
        }

        let kind: { type?: string; width?: number; height?: number };

        try {
            kind = imageSize(req.body);
        }
        catch {
            refuse(400, 'not an image');
            return;
        }

        const type = `image/${kind.type === 'jpg' ? 'jpeg' : kind.type}`;

        if (!IMAGE_TYPES.has(type)) {
            refuse(400, 'an image is PNG, JPEG, WebP or GIF');
            return;
        }
        if (!kind.width || !kind.height || kind.width * kind.height > IMAGE_PIXELS) {
            refuse(400, 'the image has more pixels than text may embed');
            return;
        }

        try {
            if (liveGrants(await client.grantsFrom(user), new Date(now())).length === 0) {
                refuse(403, 'no grant to publish under');
                return;
            }

            const since = now() - 60 * 60_000;
            const recent = (stored.get(user) ?? []).filter(at => at > since);

            if (recent.length >= hourly) {
                refuse(429, 'too many images; try again within the hour');
                return;
            }
            stored.set(user, [...recent, now()]);
            // Whoever has stored nothing lately is forgotten, so the list does not grow with every user there has been.
            if (stored.size > MAX_HELD) {
                for (const [each, times] of stored) {
                    if (times.every(at => at <= since)) stored.delete(each);
                }
            }

            const did = await keymaster.createImage(req.body, { registry: options.imageRegistry ?? 'hyperswarm' });
            const versionId = (await keymaster.resolveDID(did)).didDocumentMetadata?.versionId;

            if (typeof versionId !== 'string') {
                throw new Error('the image has no version');
            }
            res.json({ did, versionId, type, bytes: req.body.length, width: kind.width, height: kind.height });
        }
        catch {
            refuse(502, 'the node did not store the image');
        }
    });

    // An image embedded in text: an image asset at one version, which is what
    // an embed names. Text formatting says which kinds and how large. A
    // version does not change, so a browser may keep what it is given.
    router.get('/images/:did', async (req, res) => {
        const none = () => { res.status(404).json({ error: 'no image the service serves' }); };
        const versionId = typeof req.query.versionId === 'string' ? req.query.versionId : undefined;

        try {
            const image = versionId && isDid(String(req.params.did))
                ? await imageOf(String(req.params.did), { types: IMAGE_TYPES, limit: IMAGE_LIMIT, pixels: IMAGE_PIXELS, versionId })
                : null;

            if (!image) {
                none();
                return;
            }

            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
            res.type(image.type).send(image.data);
        }
        catch {
            none();
        }
    });

    router.delete('/objects/:did', publishing(async (req, grant) => {
        await client.withdraw(String(req.params.did), grant);
        return true;
    }, req => String(req.params.did)));

    return router;
}

// Whether a string has the shape of a DID. One from a request or from a
// stranger's document is asked of the node only where it has: the node's
// client puts it in the path of its request, where anything else would name
// something other than a DID.
const isDid = (did: string): boolean => /^did:[a-z0-9]+:[A-Za-z0-9._%-]{1,200}$/.test(did);

export function createMemepoolApp(options: MemepoolOptions): express.Express {
    const app = express();

    app.use('/api/v1', createMemepoolRouter(options));
    // A path under the API that is no route of it is not a page.
    app.use('/api', (_req, res) => {
        res.status(404).json({ error: 'no such route' });
    });
    if (options.pagesDir) {
        // The pages are files a browser may keep; the page that names them is
        // asked for each time, so that a new build is picked up.
        app.use(express.static(options.pagesDir, {
            setHeaders: (res, file) => {
                res.setHeader('Cache-Control', file.endsWith('.html') ? 'no-cache' : 'public, max-age=31536000, immutable');
            },
        }));
    }
    app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
        void _next;
        const { status } = error as { status?: unknown };

        // A body that is not JSON, or is too large, is the caller's to correct.
        if (typeof status === 'number' && status >= 400 && status < 500) {
            res.status(status).json({ error: 'the request could not be read' });
            return;
        }
        console.error(error);
        res.status(500).json({ error: 'the service could not answer' });
    });

    return app;
}
