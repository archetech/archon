// DIDComm relay (mailbox) HTTP API. Senders POST encrypted envelopes; a
// self-custody recipient proves control of its DID (signed challenge) and
// fetches them to unpack locally. createApp is exported for tests; index.ts
// wires the production dependencies and listens.
import crypto from 'crypto';
import express, { type Express } from 'express';
import cors from 'cors';
import { socksDispatcher } from 'fetch-socks';
import type { Cipher } from '@didcid/cipher/types';
import { MailboxStore } from './store.js';
import { recipientDidsFromEnvelope, verifyChallengeSignature, type Resolver } from './mailbox.js';

export interface AppDeps {
    store: MailboxStore;
    resolver: Resolver;
    cipher: Cipher;
    uploadLimit?: string;
    // Outbound egress (POST /deliver): SOCKS5 Tor proxy for .onion destinations,
    // and whether to permit private/loopback destinations (dev/test only).
    torProxy?: string;
    allowPrivateEgress?: boolean;
}

// SSRF guard: block loopback/private/link-local hosts for clearnet egress.
function isPrivateHost(hostname: string): boolean {
    return /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.0\.0\.0|\[?::1\]?$)/.test(hostname);
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
    v1.post('/messages', async (req, res) => {
        try {
            let packed: string;
            if (typeof req.body === 'string') {
                packed = req.body;
            }
            else if (req.body && req.body.message) {
                packed = req.body.message;
            }
            else {
                packed = JSON.stringify(req.body);
            }
            const recipients = recipientDidsFromEnvelope(packed);
            const ids: string[] = [];
            for (const recipient of recipients) {
                const id = crypto.randomUUID();
                await deps.store.add(recipient, packed, id);
                ids.push(id);
            }
            res.json({ ids });
        }
        catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    // Single-use challenge for proving DID control on fetch/remove.
    v1.get('/challenge', async (_req, res) => {
        const challenge = crypto.randomBytes(32).toString('base64url');
        await deps.store.issueChallenge(challenge);
        res.json({ challenge });
    });

    const authorize = async (req: express.Request, res: express.Response): Promise<string | null> => {
        const { did, challenge, signature } = req.body || {};
        if (!did || !challenge || !signature) {
            res.status(400).send({ error: 'did, challenge and signature are required' });
            return null;
        }
        if (!(await deps.store.consumeChallenge(challenge))) {
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
            const messages = (await deps.store.list(did)).map(m => ({ id: m.id, message: m.envelope, received: m.received }));
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
            res.json({ removed: await deps.store.remove(did, ids) });
        }
        catch (error: any) {
            res.status(400).send({ error: error.toString() });
        }
    });

    // Outbound egress. An authenticated sender (signed challenge proving control
    // of `did`) hands us a sealed envelope + the recipient's mailbox endpoint;
    // we deliver it, dialing `.onion` over Tor. This is the single egress path —
    // the keymaster never POSTs to recipients directly.
    v1.post('/deliver', async (req, res) => {
        try {
            const did = await authorize(req, res);
            if (!did) {
                return;
            }
            const { endpoint, message } = req.body || {};
            if (typeof endpoint !== 'string' || typeof message !== 'string') {
                return res.status(400).send({ error: 'endpoint and message are required' });
            }

            let url: URL;
            try {
                url = new URL(endpoint);
            }
            catch {
                return res.status(400).send({ error: 'invalid endpoint URL' });
            }
            const onion = url.hostname.endsWith('.onion');

            if (!onion && !deps.allowPrivateEgress) {
                if (url.protocol !== 'https:') {
                    return res.status(400).send({ error: 'clearnet endpoint must use https' });
                }
                if (isPrivateHost(url.hostname)) {
                    return res.status(400).send({ error: 'private/loopback endpoint not allowed' });
                }
            }

            const fetchOptions: any = {
                method: 'POST',
                headers: { 'Content-Type': 'application/didcomm-encrypted+json' },
                body: message,
            };
            if (onion) {
                if (!deps.torProxy) {
                    return res.status(502).send({ error: 'onion endpoint requires a Tor proxy (set ARCHON_DIDCOMM_TOR_PROXY)' });
                }
                const [host, port] = deps.torProxy.split(':');
                fetchOptions.dispatcher = socksDispatcher({ type: 5, host: host || 'localhost', port: parseInt(port || '9050', 10) });
            }

            const target = `${endpoint.replace(/\/+$/, '')}/api/v1/messages`;
            const response = await fetch(target, fetchOptions);
            if (!response.ok) {
                return res.status(502).send({ error: `delivery to ${url.host} failed: ${response.status}` });
            }
            const data: any = await response.json().catch(() => ({}));
            res.json({ ids: data.ids || [] });
        }
        catch (error: any) {
            res.status(502).send({ error: error.toString() });
        }
    });

    app.use('/api/v1', v1);
    return app;
}
