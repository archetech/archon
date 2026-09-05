import express from 'express';
import session from 'express-session';
import morgan from 'morgan';
import path from 'path';
import dotenv from 'dotenv';

import CipherNode from '@didcid/cipher/node';
import GatekeeperClient from '@didcid/clients/gatekeeper';
import Keymaster from '@didcid/keymaster';
import KeymasterClient from '@didcid/clients/keymaster';
import WalletJson from '@didcid/keymaster/wallet/json';
import { DatabaseInterface } from './db/interfaces.js';
import { DbJson } from './db/json.js';
import { DbRedis } from './db/redis.js';
import { DbSqlite } from './db/sqlite.js';
import { EmailBridge } from './email-bridge.js';
import { SendGridEmailService } from './email/sendgrid.js';
import { createHeraldRoutes, type HeraldContext } from './routes.js';
import {
    ADMIN_API_KEY,
    DATA_DIR,
    GATEKEEPER_URL,
    HERALD_DATABASE_TYPE,
    HOST_PORT,
    IPFS_API_URL,
    IPNS_KEY_NAME,
    SENDGRID_API_KEY,
    SENDGRID_FROM_EMAIL,
    SENDGRID_PARSE_DOMAIN,
    SERVICE_DOMAIN,
    OWNER_DID,
    SERVICE_NAME,
    SESSION_SECRET,
    WALLET_URL,
} from './config.js';

// Shared mutable state, populated by the bootstrap below and read lazily by the
// routes (which are registered before any of it exists).
const ctx: HeraldContext = {
    keymaster: undefined as unknown as Keymaster | KeymasterClient,
    db: undefined as unknown as DatabaseInterface,
    emailBridge: null,
    serviceDID: '',
};

dotenv.config();

const SESSION_SECRET_PLACEHOLDERS = new Set(['change-me', 'change-me-to-a-random-string']);

if (!SESSION_SECRET) {
    throw new Error('ARCHON_HERALD_SESSION_SECRET is required');
}

if (SESSION_SECRET_PLACEHOLDERS.has(SESSION_SECRET)) {
    throw new Error('ARCHON_HERALD_SESSION_SECRET must be set to a non-placeholder value');
}

const app = express();

app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));  // OAuth2 token requests use form encoding

// Session setup
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: 'auto',
        sameSite: 'lax',
        httpOnly: true,
    }
}));

const { router: heraldRouter, startDmailPollLoop } = createHeraldRoutes(ctx);
app.use(heraldRouter);


async function initServiceIdentity(): Promise<void> {
    const currentId = await ctx.keymaster.getCurrentId();

    try {
        const docs = await ctx.keymaster.resolveDID(SERVICE_NAME);
        if (!docs.didDocument?.id) {
            throw new Error('No DID found');
        }
        ctx.serviceDID = docs.didDocument.id;
        console.log(`${SERVICE_NAME}: ${ctx.serviceDID}`);
    }
    catch (error) {
        console.log(`Creating ID ${SERVICE_NAME}`);
        ctx.serviceDID = await ctx.keymaster.createId(SERVICE_NAME);
    }

    await ctx.keymaster.setCurrentId(SERVICE_NAME);

    // Publish the service name as a DID property so it's discoverable
    const docs = await ctx.keymaster.resolveDID(SERVICE_NAME);
    const currentName = (docs.didDocumentData as any)?.name;
    if (currentName !== SERVICE_NAME) {
        await ctx.keymaster.mergeData(SERVICE_NAME, { name: SERVICE_NAME });
        console.log(`Published name property: ${SERVICE_NAME}`);
    }

    if (!OWNER_DID) {
        console.warn('Warning: ARCHON_HERALD_OWNER_DID not set — no user will have owner access');
    } else {
        console.log(`Owner: ${OWNER_DID}`);
    }

    if (currentId) {
        await ctx.keymaster.setCurrentId(currentId);
    }
}

async function ensureIpnsKeyExists(): Promise<void> {
    const listResponse = await fetch(`${IPFS_API_URL}/key/list`, {
        method: 'POST',
    });
    if (!listResponse.ok) {
        throw new Error(`IPFS key list failed: ${listResponse.statusText}`);
    }

    const listResult = await listResponse.json() as { Keys?: Array<{ Name?: string }> };
    const hasKey = listResult.Keys?.some(key => key.Name === IPNS_KEY_NAME);

    if (hasKey) {
        return;
    }

    console.log(`Creating missing IPNS key: ${IPNS_KEY_NAME}`);
    const genResponse = await fetch(`${IPFS_API_URL}/key/gen?arg=${encodeURIComponent(IPNS_KEY_NAME)}`, {
        method: 'POST',
    });

    if (!genResponse.ok) {
        throw new Error(`IPFS key gen failed: ${genResponse.statusText}`);
    }

    const genResult = await genResponse.json() as { Name?: string; Id?: string };
    console.log(`Created IPNS key ${genResult.Name}: ${genResult.Id}`);
}

app.listen(HOST_PORT, '0.0.0.0', async () => {
    if (HERALD_DATABASE_TYPE === 'sqlite') {
        ctx.db = new DbSqlite(path.join(DATA_DIR, 'db.sqlite'));
    } else if (HERALD_DATABASE_TYPE === 'redis') {
        ctx.db = new DbRedis(SERVICE_NAME);
    } else {
        ctx.db = new DbJson(path.join(DATA_DIR, 'db.json'));
    }

    if (ctx.db.init) {
        try {
            await ctx.db.init();
        } catch (e: any) {
            console.error(`Error initialising database: ${e.message}`);
            process.exit(1);
        }
    }

    const keymasterUrl = process.env.ARCHON_HERALD_KEYMASTER_URL?.trim();

    if (keymasterUrl) {
        ctx.keymaster = new KeymasterClient();
        await ctx.keymaster.connect({
            url: keymasterUrl,
            waitUntilReady: true,
            intervalSeconds: 5,
            chatty: true,
            // @ts-ignore - apiKey added in @didcid/* 0.4.x
            apiKey: ADMIN_API_KEY || undefined,
        });
        console.log(`${SERVICE_NAME} using keymaster at ${keymasterUrl}`);
    }
    else {
        const passphrase = process.env.ARCHON_HERALD_WALLET_PASSPHRASE;

        if (!passphrase) {
            console.error('Error: ARCHON_HERALD_WALLET_PASSPHRASE environment variable not set');
            process.exit(1);
        }

        const gatekeeper = new GatekeeperClient();
        await gatekeeper.connect({
            url: GATEKEEPER_URL,
            waitUntilReady: true,
            intervalSeconds: 5,
            chatty: true,
        });
        const wallet = new WalletJson('wallet.json', DATA_DIR);
        const cipher = new CipherNode();

        // Herald issues name credentials from this identity, so replacing it
        // invalidates every credential it has issued. Provisioning is fine on a
        // first run; it must not pass unremarked on any other.
        ctx.keymaster = new Keymaster({
            gatekeeper,
            wallet,
            cipher,
            passphrase,
        });

        if (!await wallet.loadWallet()) {
            console.warn(`Herald: no wallet at ${DATA_DIR}/wallet.json — creating one. If this node has run before, its data directory is missing and the identity it issued credentials from has been replaced.`);
            await ctx.keymaster.loadOrCreateWallet();
        }

        // Load existing wallet (decrypt and restore IDs/aliases)
        await ctx.keymaster.loadWallet();
        console.log(`${SERVICE_NAME} using gatekeeper at ${GATEKEEPER_URL}`);
    }

    await initServiceIdentity();
    await ensureIpnsKeyExists();

    // Initialize email bridge if SendGrid is configured
    if (SENDGRID_API_KEY) {
        const emailService = new SendGridEmailService(SENDGRID_API_KEY);
        ctx.emailBridge = new EmailBridge({
            domain: SERVICE_DOMAIN,
            parseDomain: SENDGRID_PARSE_DOMAIN,
            fromEmail: SENDGRID_FROM_EMAIL,
            fromName: SERVICE_NAME,
        }, ctx.db, emailService);
        console.log(`${SERVICE_NAME} email bridge enabled (from: ${SENDGRID_FROM_EMAIL}, parse: ${SENDGRID_PARSE_DOMAIN})`);
        startDmailPollLoop();
    } else {
        console.log(`${SERVICE_NAME} email bridge disabled (ARCHON_HERALD_SENDGRID_API_KEY not set)`);
    }

    console.log(`${SERVICE_NAME} using wallet at ${WALLET_URL}`);
    console.log(`${SERVICE_NAME} listening on port ${HOST_PORT}`);
});
