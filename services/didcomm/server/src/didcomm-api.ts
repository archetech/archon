// DIDComm relay (mailbox) HTTP API. Senders POST encrypted envelopes; a
// self-custody recipient proves control of its DID (signed challenge) and
// fetches them to unpack locally. createApp is exported for tests; index.ts
// wires the production dependencies and listens.
import crypto from 'crypto';
import express, { type Express } from 'express';
import cors from 'cors';
import type { Cipher } from '@didcid/cipher/types';
import { MailboxStore } from './store.js';
import { recipientDidsFromEnvelope, verifyChallengeSignature, type Resolver } from './mailbox.js';

export interface AppDeps {
    store: MailboxStore;
    resolver: Resolver;
    cipher: Cipher;
    uploadLimit?: string;
}

export function createApp(deps: AppDeps): Express {
    const app = express();
    const limit = deps.uploadLimit || '5mb';

    app.use(cors());
    app.use(express.text({ type: ['application/didcomm-encrypted+json', 'text/*'], limit }));
    app.use(express.json({ limit }));

    app.get('/health', (_req, res) => {
        res.json({ ready: true });
    });

    const v1 = express.Router();

    // Inbound delivery — anyone may deliver an (encrypted) envelope. Routed to
    // the recipient mailbox(es) by the JWE recipient kids.
    v1.post('/messages', (req, res) => {
        try {
            const packed = typeof req.body === 'string' ? req.body
                : (req.body && req.body.message) ? req.body.message
                : JSON.stringify(req.body);
            const recipients = recipientDidsFromEnvelope(packed);
            const ids = recipients.map(recipient => {
                const id = crypto.randomUUID();
                deps.store.add(recipient, packed, id);
                return id;
            });
            res.json({ ids });
        }
        catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    // Single-use challenge for proving DID control on fetch/remove.
    v1.get('/challenge', (_req, res) => {
        const challenge = crypto.randomBytes(32).toString('base64url');
        deps.store.issueChallenge(challenge);
        res.json({ challenge });
    });

    const authorize = async (req: express.Request, res: express.Response): Promise<string | null> => {
        const { did, challenge, signature } = req.body || {};
        if (!did || !challenge || !signature) {
            res.status(400).send({ error: 'did, challenge and signature are required' });
            return null;
        }
        if (!deps.store.consumeChallenge(challenge)) {
            res.status(401).send({ error: 'invalid or expired challenge' });
            return null;
        }
        const ok = await verifyChallengeSignature({ resolver: deps.resolver, cipher: deps.cipher }, { did, challenge, signature });
        if (!ok) {
            res.status(401).send({ error: 'signature verification failed' });
            return null;
        }
        return did;
    };

    v1.post('/messages/fetch', async (req, res) => {
        try {
            const did = await authorize(req, res);
            if (!did) {
                return;
            }
            const messages = deps.store.list(did).map(m => ({ id: m.id, message: m.envelope, received: m.received }));
            res.json({ messages });
        }
        catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    v1.post('/messages/remove', async (req, res) => {
        try {
            const did = await authorize(req, res);
            if (!did) {
                return;
            }
            const ids = req.body?.ids;
            if (!Array.isArray(ids)) {
                return res.status(400).send({ error: 'ids array is required' });
            }
            res.json({ removed: deps.store.remove(did, ids) });
        }
        catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    app.use('/api/v1', v1);
    return app;
}
