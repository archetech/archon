import { randomBytes } from 'node:crypto';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { MemeplexClientError, liveGrants } from '@didcid/memeplex/client';
import type { MemeplexClient, UsableGrant } from '@didcid/memeplex/client';

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
    resolveDID(did: string, options?: { versionSequence?: number }): Promise<{ didDocument?: { controller?: string } }>;
}

export interface MemepoolOptions {
    client: MemeplexClient;
    keymaster: LoginKeymaster;
    // The name the service gives itself in a grant request.
    name: string;
    version: { version: string; commit: string };
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
    const { client, keymaster, name, version } = options;
    const now = options.now ?? Date.now;
    const challenges = new Expiring<string>(options.challengeLifetime ?? 10 * 60_000, now);
    const perMinute = options.challengesPerMinute ?? 60;
    let issued: number[] = [];
    const sessions = new Expiring<string>(options.sessionLifetime ?? 24 * 60 * 60_000, now);
    const router = express.Router();

    router.use(express.json({ limit: '256kb' }));

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

        const challenge = await keymaster.createChallenge();
        const asked = randomBytes(32).toString('base64url');

        challenges.set(challenge, asked);
        res.cookie(ASKED, asked, { httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/' });
        res.json({ challenge, link: `archon://auth?challenge=${encodeURIComponent(challenge)}` });
    });

    // The answer to a challenge this service issued, which it takes once.
    router.post('/login', async (req, res) => {
        const { response } = req.body ?? {};

        if (typeof response !== 'string' || !response) {
            res.status(400).json({ error: 'expected a response' });
            return;
        }

        const verified = await keymaster.verifyResponse(response, { retries: 10 });

        const asked = cookieOf(req, ASKED);

        if (!verified.match || !verified.responder || !asked || challenges.get(verified.challenge) !== asked) {
            res.status(401).json({ error: 'the response does not answer a challenge this browser asked for' });
            return;
        }
        challenges.take(verified.challenge);

        // Who answered is whoever created the response. An asset's controller
        // can be changed by its owner to anyone, with no consent of theirs, so
        // the response's present controller is not evidence of who that is.
        const created = await keymaster.resolveDID(response, { versionSequence: 1 });

        if (created.didDocument?.controller !== verified.responder) {
            res.status(401).json({ error: 'the response is not controlled by the identity that created it' });
            return;
        }

        res.clearCookie(ASKED, { path: '/' });

        const token = randomBytes(32).toString('base64url');

        sessions.set(token, verified.responder);
        res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/' });
        res.json({ did: verified.responder });
    });

    router.post('/logout', (req, res) => {
        const token = cookieOf(req);

        if (token) {
            sessions.take(token);
        }
        res.clearCookie(COOKIE, { path: '/' });
        res.json(true);
    });

    router.use((req: Request, res: Response, next: NextFunction) => {
        const token = cookieOf(req);
        const user = token ? sessions.get(token) : undefined;

        if (!user) {
            res.status(401).json({ error: 'not signed in' });
            return;
        }
        (req as Signed).user = user;
        next();
    });

    // Who is signed in, and their grant or the link that asks for one. A user is
    // known by signing in, so their grants are found by who made them. With
    // more than one in force, new objects go under the earliest.
    router.get('/me', async (req, res) => {
        const { user } = req as Signed;
        const found = await client.grantsFrom(user);
        const [grant, ...others] = liveGrants(found, new Date(now()));

        if (grant) {
            res.json({ did: user, grant: grant.did, registry: grant.registry, ...(others.length ? { others: others.map(each => each.did) } : {}) });
            return;
        }

        const pending = found.filter(each => each.grant.status === 'pending').map(each => each.did);
        const { link } = await client.requestGrant({ name });

        res.json({ did: user, pending, link });
    });

    // `of` names the object a request changes. A change goes under the grant
    // the object was published under, which is the only one it counts under.
    const publishing = (act: (req: Signed, grant: UsableGrant) => Promise<unknown>, of?: (req: Request) => string) =>
        async (req: Request, res: Response) => {
            const live = liveGrants(await client.grantsFrom((req as Signed).user), new Date(now()));

            if (live.length === 0) {
                res.status(403).json({ error: 'no grant to publish under' });
                return;
            }

            try {
                const under = of ? await client.grantOf(of(req)) : live[0].did;
                const grant = live.find(each => each.did === under);

                if (!grant) {
                    res.status(400).json({ error: 'the grant this object was published under is not one of yours in force' });
                    return;
                }

                res.json(await act(req as Signed, grant));
            }
            catch (error) {
                if (!(error instanceof MemeplexClientError)) {
                    throw error;
                }
                res.status(error.reason === 'invalid' ? 400 : 502).json({ error: error.message });
            }
        };

    const fields = (req: Request) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

    router.post('/objects', publishing(async (req, grant) => ({ did: await client.publish(grant, fields(req)) })));

    router.put('/objects/:did', publishing(async (req, grant) => {
        await client.edit(String(req.params.did), grant, fields(req));
        return true;
    }, req => String(req.params.did)));

    router.delete('/objects/:did', publishing(async (req, grant) => {
        await client.withdraw(String(req.params.did), grant);
        return true;
    }, req => String(req.params.did)));

    return router;
}

export function createMemepoolApp(options: MemepoolOptions): express.Express {
    const app = express();

    app.use('/api/v1', createMemepoolRouter(options));
    app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
        void _next;
        console.error(error);
        res.status(500).json({ error: 'the service could not answer' });
    });

    return app;
}
