import express from 'express';
import type { MemeplexIndex } from '@didcid/memeplex';

// The indexer's views over HTTP. Every answer is read from the index as it
// stands; nothing here reaches a Gatekeeper.

export interface IndexerStatus {
    /** Whether the index has been filled from the whole feed at least once. */
    ready: boolean;
    /** DIDs whose histories the index holds. */
    dids: number;
    /** Objects with an attributed version. */
    publications: number;
    lastPoll?: string;
    lastReconcile?: string;
}

export interface ApiOptions {
    index: MemeplexIndex;
    status(): IndexerStatus;
    version: { version: string; commit: string };
}

const MAX_AUTHORS = 1000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

// A query parameter given once or several times, as a list of strings.
function strings(value: unknown): string[] | undefined {
    const list = value === undefined ? [] : Array.isArray(value) ? value : [value];

    return list.every(item => typeof item === 'string') ? list as string[] : undefined;
}

// A nonnegative integer parameter, its default when absent, or undefined when it
// is anything else.
function count(value: unknown, fallback: number, max: number): number | undefined {
    if (value === undefined) {
        return fallback;
    }

    const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;

    return Number.isSafeInteger(parsed) && parsed <= max ? parsed : undefined;
}

export function createIndexerRouter({ index, status, version }: ApiOptions): express.Router {
    const router = express.Router();

    router.get('/ready', (_req, res) => {
        res.json(status().ready);
    });

    router.get('/version', (_req, res) => {
        res.json(version);
    });

    router.get('/status', (_req, res) => {
        res.json(status());
    });

    // Everything below answers from a full reading of the feed or not at all: a
    // partly filled index would report as unpublished what it has not read yet.
    router.use((_req, res, next) => {
        if (!status().ready) {
            res.status(503).json({ error: 'the index is still being built' });
            return;
        }
        next();
    });

    router.get('/publications/:did', (req, res) => {
        const publication = index.publication(req.params.did);

        if (!publication) {
            res.status(404).json({ error: 'no attributed publication' });
            return;
        }
        res.json(publication);
    });

    router.get('/timeline', (req, res) => {
        const authors = strings(req.query.author);
        const limit = count(req.query.limit, DEFAULT_LIMIT, MAX_LIMIT);
        const offset = count(req.query.offset, 0, Number.MAX_SAFE_INTEGER);

        if (!authors || authors.length === 0 || authors.length > MAX_AUTHORS || !limit || offset === undefined) {
            res.status(400).json({ error: `expected 1 to ${MAX_AUTHORS} author parameters, limit 1 to ${MAX_LIMIT} and offset` });
            return;
        }

        const timeline = index.timeline(authors);

        res.json({ total: timeline.length, publications: timeline.slice(offset, offset + limit) });
    });

    router.get('/threads/:did', (req, res) => {
        res.json(index.thread(req.params.did));
    });

    router.get('/boosts/:did', (req, res) => {
        res.json(index.boosts(req.params.did));
    });

    router.get('/ratings/:did', (req, res) => {
        res.json(index.ratings(req.params.did));
    });

    router.get('/tags/:did', (req, res) => {
        res.json([...index.tags(req.params.did)].map(([tag, authors]) => ({ tag, authors })));
    });

    router.get('/coauthors/:did', (req, res) => {
        res.json(index.coauthors(req.params.did));
    });

    return router;
}

export function createIndexerApp(options: ApiOptions): express.Express {
    const app = express();

    app.use('/api/v1', createIndexerRouter(options));

    return app;
}
