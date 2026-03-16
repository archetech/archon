import express, {
    Request,
    Response,
    NextFunction
} from 'express';
import session from 'express-session';
import morgan from 'morgan';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import cors from 'cors';

import CipherNode from '@didcid/cipher/node';
import GatekeeperClient from '@didcid/gatekeeper/client';
import Keymaster from '@didcid/keymaster';
import KeymasterClient from '@didcid/keymaster/client';
import WalletJson from '@didcid/keymaster/wallet/json';
import { DatabaseInterface, User } from './db/interfaces.js';
import { DbJson } from './db/json.js';
import { DbSqlite } from './db/sqlite.js';
import { createOAuthRoutes } from './oauth/index.js';

let keymaster: Keymaster | KeymasterClient;
let db: DatabaseInterface;

dotenv.config();

const HOST_PORT = Number(process.env.NS_HOST_PORT) || 3300;
const HOST_URL = process.env.NS_HOST_URL || 'http://localhost:3300';
const GATEKEEPER_URL = process.env.NS_GATEKEEPER_URL || 'http://localhost:4224';
const WALLET_URL = process.env.NS_WALLET_URL || 'http://localhost:4224';
const NS_DATABASE_TYPE = process.env.NS_DATABASE || 'json';
const IPFS_API_URL = process.env.NS_IPFS_API_URL || 'http://localhost:5001/api/v0';
const SERVICE_NAME = process.env.NS_SERVICE_NAME || 'name-service';
const PUBLIC_URL = process.env.NS_PUBLIC_URL || HOST_URL;
const SESSION_SECRET = process.env.NS_SESSION_SECRET || SERVICE_NAME;
const IPNS_KEY_NAME = process.env.NS_IPNS_KEY_NAME || SERVICE_NAME;

const app = express();
const logins: Record<string, {
    response: string;
    challenge: string;
    did: string;
    verify: any;
}> = {};

app.use(morgan('dev'));
app.use(express.json());

// Session setup
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } // Set to true if using HTTPS
}));

let ownerDID = '';

async function initOwnerIdentity(): Promise<void> {
    const currentId = await keymaster.getCurrentId();

    try {
        const docs = await keymaster.resolveDID(SERVICE_NAME);
        if (!docs.didDocument?.id) {
            throw new Error('No DID found');
        }
        ownerDID = docs.didDocument.id;
        console.log(`${SERVICE_NAME}: ${ownerDID}`);
    }
    catch (error) {
        console.log(`Creating ID ${SERVICE_NAME}`);
        ownerDID = await keymaster.createId(SERVICE_NAME);
    }

    await keymaster.setCurrentId(SERVICE_NAME);

    if (currentId) {
        await keymaster.setCurrentId(currentId);
    }
}

function isAuthenticated(req: Request, res: Response, next: NextFunction): void {
    if (req.session.user) {
        return next();
    }
    res.status(401).send('You need to log in first');
}

function isOwner(req: Request, res: Response, next: NextFunction): void {
    isAuthenticated(req, res, () => {
        const userDid = req.session.user?.did;
        if (userDid === ownerDID) {
            return next();
        }
        res.status(403).send('Owner access required');
    });
}

async function loginUser(response: string): Promise<any> {
    const verify = await keymaster.verifyResponse(response, { retries: 10 });

    if (verify.match) {
        const challenge = verify.challenge;
        const did = verify.responder!;
        const currentDb = db.loadDb();

        if (!currentDb.users) {
            currentDb.users = {};
        }

        const now = new Date().toISOString();

        if (currentDb.users[did]) {
            currentDb.users[did].lastLogin = now;
            currentDb.users[did].logins = (currentDb.users[did].logins || 0) + 1;
        }
        else {
            currentDb.users[did] = {
                firstLogin: now,
                lastLogin: now,
                logins: 1,
            }
        }

        db.writeDb(currentDb);

        logins[challenge] = {
            response,
            challenge,
            did,
            verify,
        };
    }

    return verify;
}

const corsOptions = {
    origin: process.env.NS_CORS_SITE_ORIGIN || 'http://localhost:3001', // Origin needs to be specified with credentials true
    methods: ['GET', 'POST'],  // Specify which methods are allowed (e.g., GET, POST)
    credentials: true,         // Enable if you need to send cookies or authorization headers
    optionsSuccessStatus: 200  // Some legacy browsers choke on 204
};

app.use(cors(corsOptions));

app.options('/api/{*path}', cors(corsOptions));

// Helper function for OAuth
async function getMemberByDID(did: string): Promise<any> {
    const currentDb = db.loadDb();
    if (currentDb.users && currentDb.users[did]) {
        return {
            ...currentDb.users[did],
            did,
            handle: currentDb.users[did].name
        };
    }
    return null;
}

// Mount OAuth routes (keymaster accessed lazily)
const oauthRouter = createOAuthRoutes(() => keymaster, getMemberByDID);
app.use('/oauth', oauthRouter);
console.log('OAuth routes mounted at /oauth');

app.get('/api/version', async (_: Request, res: Response) => {
    try {
        res.json(1);
    } catch (error) {
        console.log(error);
        res.status(500).send(String(error));
    }
});

app.get('/api/config', (_: Request, res: Response) => {
    res.json({
        serviceName: SERVICE_NAME,
        publicUrl: PUBLIC_URL,
    });
});

app.get('/api/challenge', async (req: Request, res: Response) => {
    try {
        const challenge = await keymaster.createChallenge({
            // @ts-ignore
            callback: `${HOST_URL}/api/login`
        });
        req.session.challenge = challenge;
        const challengeURL = `${WALLET_URL}?challenge=${challenge}`;

        const doc = await keymaster.resolveDID(challenge);
        console.log(JSON.stringify(doc, null, 4));
        res.json({ challenge, challengeURL });
    } catch (error) {
        console.log(error);
        res.status(500).send(String(error));
    }
});

app.get('/api/login', cors(corsOptions), async (req: Request, res: Response) => {
    try {
        const { response } = req.query;
        if (typeof response !== 'string') {
            res.status(400).json({ error: 'Missing or invalid response param' });
            return;
        }
        const verify = await loginUser(response);
        if (!verify.challenge) {
            res.json({ authenticated: false });
            return;
        }
        req.session.user = {
            did: verify.responder
        };
        res.json({ authenticated: verify.match });
    } catch (error) {
        console.log(error);
        res.status(500).send(String(error));
    }
});

app.post('/api/login', cors(corsOptions), async (req: Request, res: Response) => {
    try {
        const { response } = req.body;
        const verify = await loginUser(response);
        if (!verify.challenge) {
            res.json({ authenticated: false });
            return;
        }
        req.session.user = {
            did: verify.responder
        };
        res.json({ authenticated: verify.match });
    } catch (error) {
        console.log(error);
        res.status(500).send(String(error));
    }
});

app.post('/api/logout', async (req: Request, res: Response) => {
    try {
        req.session.destroy(err => {
            if (err) {
                console.log(err);
            }
        });
        res.json({ ok: true });
    }
    catch (error) {
        console.log(error);
        res.status(500).send(String(error));
    }
});

app.get('/api/check-auth', async (req: Request, res: Response) => {
    try {
        if (!req.session.user && req.session.challenge) {
            const challengeData = logins[req.session.challenge];
            if (challengeData) {
                req.session.user = { did: challengeData.did };
            }
        }

        const isAuthenticated = !!req.session.user;
        const userDID = isAuthenticated ? req.session.user?.did : null;
        const currentDb = db.loadDb();

        let profile: any = null;

        if (isAuthenticated && userDID && currentDb.users) {
            profile = currentDb.users[userDID] || null;
        }

        const auth = {
            isAuthenticated,
            userDID,
            isOwner: isAuthenticated && userDID === ownerDID,
            profile,
        };

        res.json(auth);
    }
    catch (error) {
        console.log(error);
        res.status(500).send(String(error));
    }
});

app.get('/api/users', isAuthenticated, async (_: Request, res: Response) => {
    try {
        const currentDb = db.loadDb();
        const users = currentDb.users ? Object.keys(currentDb.users) : [];
        res.json(users);
    }
    catch (error) {
        console.log(error);
        res.status(500).send(String(error));
    }
});

app.get('/api/admin', isOwner, async (_: Request, res: Response) => {
    try {
        res.json(db.loadDb());
    }
    catch (error) {
        console.log(error);
        res.status(500).send(String(error));
    }
});

// Publish registry to IPFS and update IPNS
app.post('/api/admin/publish', isOwner, async (_: Request, res: Response) => {
    try {
        // Build registry from DB
        const currentDb = db.loadDb();
        const names: Record<string, string> = {};

        if (currentDb.users) {
            for (const [did, user] of Object.entries(currentDb.users)) {
                if (user.name) {
                    names[user.name] = did;
                }
            }
        }

        const registry = {
            version: 1,
            updated: new Date().toISOString(),
            names
        };

        const registryJson = JSON.stringify(registry, null, 2);

        // Add to IPFS
        const formData = new FormData();
        formData.append('file', new Blob([registryJson], { type: 'application/json' }), 'registry.json');

        const addResponse = await fetch(`${IPFS_API_URL}/add?pin=true`, {
            method: 'POST',
            body: formData
        });

        if (!addResponse.ok) {
            throw new Error(`IPFS add failed: ${addResponse.statusText}`);
        }

        const addResult = await addResponse.json();
        const cid = addResult.Hash;

        console.log(`Registry added to IPFS: ${cid}`);

        // Publish to IPNS
        const publishResponse = await fetch(
            `${IPFS_API_URL}/name/publish?arg=/ipfs/${cid}&key=${IPNS_KEY_NAME}`,
            { method: 'POST' }
        );

        if (!publishResponse.ok) {
            throw new Error(`IPNS publish failed: ${publishResponse.statusText}`);
        }

        const publishResult = await publishResponse.json();

        console.log(`Registry published to IPNS: ${publishResult.Name}`);

        res.json({
            ok: true,
            cid,
            ipns: publishResult.Name,
            registry
        });
    }
    catch (error: any) {
        console.log(error);
        res.status(500).json({ ok: false, error: error.message || String(error) });
    }
});

app.get('/api/profile/:did', isAuthenticated, async (req: Request, res: Response) => {
    try {
        const did = req.params.did as string;
        const currentDb = db.loadDb();

        if (!currentDb.users || !currentDb.users[did]) {
            res.status(404).send('Not found');
            return;
        }

        const profile: User = { ...currentDb.users[did] };

        profile.did = did;
        profile.isUser = (req.session?.user?.did === did);

        res.json(profile);
    }
    catch (error) {
        console.log(error);
        res.status(500).send(String(error));
    }
});

app.get('/api/profile/:did/name', isAuthenticated, async (req: Request, res: Response) => {
    try {
        const did = req.params.did as string;
        const currentDb = db.loadDb();

        if (!currentDb.users || !currentDb.users[did]) {
            res.status(404).send('Not found');
            return;
        }

        const profile = currentDb.users[did];
        res.json({ name: profile.name });
    }
    catch (error) {
        console.log(error);
        res.status(500).send(String(error));
    }
});

app.put('/api/profile/:did/name', isAuthenticated, async (req: Request, res: Response) => {
    try {
        const did = req.params.did as string;
        const { name } = req.body;

        if (!req.session.user || req.session.user.did !== did) {
            res.status(403).json({ message: 'Forbidden' });
            return;
        }

        // Validate name format
        if (!name || typeof name !== 'string') {
            res.status(400).json({ ok: false, message: 'Name is required' });
            return;
        }

        const trimmedName = name.trim().toLowerCase();

        // Check length (3-32 characters)
        if (trimmedName.length < 3 || trimmedName.length > 32) {
            res.status(400).json({ ok: false, message: 'Name must be 3-32 characters' });
            return;
        }

        // Check format (alphanumeric, hyphens, underscores only)
        if (!/^[a-z0-9_-]+$/.test(trimmedName)) {
            res.status(400).json({ ok: false, message: 'Name can only contain letters, numbers, hyphens, and underscores' });
            return;
        }

        const currentDb = db.loadDb();
        if (!currentDb.users || !currentDb.users[did]) {
            res.status(404).send('Not found');
            return;
        }

        // Check for duplicate names (case-insensitive)
        for (const [existingDid, user] of Object.entries(currentDb.users)) {
            if (existingDid !== did && user.name?.toLowerCase() === trimmedName) {
                res.status(409).json({ ok: false, message: 'Name already taken' });
                return;
            }
        }

        currentDb.users[did].name = trimmedName;
        db.writeDb(currentDb);

        res.json({ ok: true, message: `name set to ${trimmedName}` });
    }
    catch (error) {
        console.log(error);
        res.status(500).send(String(error));
    }
});

// Export name registry for IPNS publication
app.get('/api/registry', async (_: Request, res: Response) => {
    try {
        const currentDb = db.loadDb();
        const names: Record<string, string> = {};

        if (currentDb.users) {
            for (const [did, user] of Object.entries(currentDb.users)) {
                if (user.name) {
                    names[user.name] = did;
                }
            }
        }

        const registry = {
            version: 1,
            updated: new Date().toISOString(),
            names
        };

        res.json(registry);
    }
    catch (error) {
        console.log(error);
        res.status(500).send(String(error));
    }
});

// Check if a name is available
app.get('/api/name/:name/available', async (req: Request, res: Response) => {
    try {
        const name = (req.params.name as string).trim().toLowerCase();
        const currentDb = db.loadDb();

        let available = true;
        if (currentDb.users) {
            for (const user of Object.values(currentDb.users)) {
                if (user.name?.toLowerCase() === name) {
                    available = false;
                    break;
                }
            }
        }

        res.json({ name, available });
    }
    catch (error) {
        console.log(error);
        res.status(500).send(String(error));
    }
});

// Resolve a name to a DID
app.get('/api/name/:name', async (req: Request, res: Response) => {
    try {
        const name = (req.params.name as string).trim().toLowerCase();
        const currentDb = db.loadDb();

        if (currentDb.users) {
            for (const [did, user] of Object.entries(currentDb.users)) {
                if (user.name?.toLowerCase() === name) {
                    res.json({ name, did });
                    return;
                }
            }
        }

        res.status(404).json({ error: 'Name not found' });
    }
    catch (error) {
        console.log(error);
        res.status(500).send(String(error));
    }
});

// Public directory.json - same as /api/registry for IPNS compatibility
app.get('/directory.json', async (_: Request, res: Response) => {
    try {
        const currentDb = db.loadDb();
        const names: Record<string, string> = {};

        if (currentDb.users) {
            for (const [did, user] of Object.entries(currentDb.users)) {
                if (user.name) {
                    names[user.name] = did;
                }
            }
        }

        const registry = {
            version: 1,
            updated: new Date().toISOString(),
            names
        };

        res.json(registry);
    }
    catch (error) {
        console.log(error);
        res.status(500).send(String(error));
    }
});

// Resolve a member name to their DID document
// Public API endpoint for member lookup
app.get('/api/member/:name', async (req: Request, res: Response) => {
    try {
        const name = (req.params.name as string).trim().toLowerCase();
        const currentDb = db.loadDb();

        let memberDid: string | null = null;

        if (currentDb.users) {
            for (const [did, user] of Object.entries(currentDb.users)) {
                if (user.name?.toLowerCase() === name) {
                    memberDid = did;
                    break;
                }
            }
        }

        if (!memberDid) {
            res.status(404).json({ error: 'Name not found', name });
            return;
        }

        // Fetch DID document from gatekeeper
        const didDoc = await keymaster.resolveDID(memberDid);

        res.json({
            name,
            did: memberDid,
            didDocument: didDoc
        });
    }
    catch (error: any) {
        console.log(error);
        res.status(500).json({ error: error.message || String(error) });
    }
});

// Legacy route (kept for backward compatibility)
app.get('/member/:name', async (req: Request, res: Response) => {
    try {
        const name = (req.params.name as string).trim().toLowerCase();
        const currentDb = db.loadDb();

        let memberDid: string | null = null;

        if (currentDb.users) {
            for (const [did, user] of Object.entries(currentDb.users)) {
                if (user.name?.toLowerCase() === name) {
                    memberDid = did;
                    break;
                }
            }
        }

        if (!memberDid) {
            res.status(404).json({ error: 'Name not found', name });
            return;
        }

        // Fetch DID document from gatekeeper
        const didDoc = await keymaster.resolveDID(memberDid);

        res.json({
            name,
            did: memberDid,
            didDocument: didDoc
        });
    }
    catch (error: any) {
        console.log(error);
        res.status(500).json({ error: error.message || String(error) });
    }
});


// Admin: Delete a user
app.delete('/api/admin/user/:did', isOwner, async (req: Request, res: Response) => {
    try {
        const did = decodeURIComponent(req.params.did as string);
        const currentDb = db.loadDb();

        if (!currentDb.users || !currentDb.users[did]) {
            res.status(404).json({ error: 'User not found' });
            return;
        }

        // Don't allow deleting the owner
        if (did === ownerDID) {
            res.status(403).json({ error: 'Cannot delete the owner account' });
            return;
        }

        const userName = currentDb.users[did].name || did;
        delete currentDb.users[did];
        db.writeDb(currentDb);

        console.log(`Deleted user ${userName} (${did})`);
        res.json({ ok: true, message: `User ${userName} deleted` });
    }
    catch (error: any) {
        console.log(error);
        res.status(500).json({ error: error.message || String(error) });
    }
});

// Get member's credential
app.get('/api/credential', isAuthenticated, async (req: Request, res: Response) => {
    try {
        const userDid = req.session.user?.did;
        if (!userDid) {
            res.status(401).json({ error: 'Not authenticated' });
            return;
        }

        const currentDb = db.loadDb();
        const user = currentDb.users?.[userDid];

        if (!user) {
            res.status(404).json({ error: 'User not found' });
            return;
        }

        if (!user.credentialDid) {
            res.json({ 
                hasCredential: false,
                name: user.name || null,
                message: 'No credential issued yet'
            });
            return;
        }

        // Fetch the credential
        const credential = await keymaster.getCredential(user.credentialDid);

        res.json({
            hasCredential: true,
            credentialDid: user.credentialDid,
            credentialName: user.credentialName,
            credentialIssuedAt: user.credentialIssuedAt,
            currentName: user.name,
            needsUpdate: user.name !== user.credentialName,
            credential
        });
    }
    catch (error: any) {
        console.log(error);
        const errorMsg = error?.message || error?.error || (typeof error === 'string' ? error : JSON.stringify(error));
        res.status(500).json({ error: errorMsg });
    }
});

// Request/update credential
app.post('/api/credential/request', isAuthenticated, async (req: Request, res: Response) => {
    try {
        const userDid = req.session.user?.did;
        if (!userDid) {
            res.status(401).json({ error: 'Not authenticated' });
            return;
        }

        const currentDb = db.loadDb();
        const user = currentDb.users?.[userDid];

        if (!user) {
            res.status(404).json({ error: 'User not found' });
            return;
        }

        if (!user.name) {
            res.status(400).json({ error: 'You must set a name before requesting a credential' });
            return;
        }

        // Switch to owner identity to issue credential
        await keymaster.setCurrentId(SERVICE_NAME);
        console.log(`Issuing credential as ${SERVICE_NAME} (${ownerDID})`);
        console.log(`User has existing credential: ${!!user.credentialDid}`);

        let credentialDid: string;

        // Schema DID for membership credentials
        const MEMBERSHIP_SCHEMA_DID = process.env.NS_MEMBERSHIP_SCHEMA_DID || 'did:cid:bagaaieraj6e2ygpm7laaapxuz5efo2bxi436vi6ubw42b75elsscelte6kza';
        
        if (user.credentialDid) {
            // Update existing credential with schema-based format
            const vc: any = {
                "@context": [
                    "https://www.w3.org/ns/credentials/v2",
                    `${PUBLIC_URL}/credentials/membership/v1`
                ],
                type: ['VerifiableCredential', 'DTGMembershipCredential'],
                issuer: ownerDID,
                validFrom: new Date().toISOString(),
                credentialSchema: {
                    id: MEMBERSHIP_SCHEMA_DID,
                    type: "JsonSchema"
                },
                credentialSubject: {
                    id: userDid,
                    memberName: `@${user.name}`
                }
            };
            console.log(`Updating credential ${user.credentialDid}...`);
            const updated = await keymaster.updateCredential(user.credentialDid, vc);
            if (!updated) {
                throw new Error('Failed to update credential');
            }
            credentialDid = user.credentialDid;
            console.log(`Updated credential ${credentialDid} for ${user.name}`);
        } else {
            // Issue new credential using schema + bindCredential + issueCredential
            console.log(`Binding new credential for ${userDid} using schema ${MEMBERSHIP_SCHEMA_DID}...`);
            const boundCredential = await keymaster.bindCredential(userDid, {
                schema: MEMBERSHIP_SCHEMA_DID,
                validFrom: new Date().toISOString(),
                claims: {
                    memberName: `@${user.name}`
                }
            });
            console.log(`Bound credential, now issuing...`);
            
            // Issue the bound credential to get a DID
            credentialDid = await keymaster.issueCredential(boundCredential);
            console.log(`Issued new credential ${credentialDid} for ${user.name}`);
        }

        // Update user record
        currentDb.users![userDid].credentialDid = credentialDid;
        currentDb.users![userDid].credentialName = user.name;
        currentDb.users![userDid].credentialIssuedAt = new Date().toISOString();
        db.writeDb(currentDb);

        // Fetch the issued credential to return
        const credential = await keymaster.getCredential(credentialDid);

        res.json({
            ok: true,
            credentialDid,
            credential,
            credentialName: user.name,
            credentialIssuedAt: currentDb.users![userDid].credentialIssuedAt,
            message: user.credentialDid ? 'Credential updated' : 'Credential issued'
        });
    }
    catch (error: any) {
        console.log(error);
        const errorMsg = error?.message || error?.error || (typeof error === 'string' ? error : JSON.stringify(error));
        res.status(500).json({ error: errorMsg });
    }
});

if (process.env.NS_SERVE_CLIENT !== 'false') {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const clientBuildPath = path.join(__dirname, '../../client/build');
    app.use('/app', express.static(clientBuildPath));

    app.use((req, res) => {
        if (!req.path.startsWith('/api')) {
            res.sendFile(path.join(clientBuildPath, 'index.html'));
        } else {
            console.warn(`Warning: Unhandled API endpoint - ${req.method} ${req.originalUrl}`);
            res.status(404).json({ message: 'Endpoint not found' });
        }
    });
}

process.on('uncaughtException', (error) => {
    console.error('Unhandled exception caught', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled rejection at:', promise, 'reason:', reason);
});

app.listen(HOST_PORT, '0.0.0.0', async () => {
    if (NS_DATABASE_TYPE === 'sqlite') {
        db = new DbSqlite();
    } else {
        db = new DbJson();
    }

    if (db.init) {
        try {
            db.init();
        } catch (e: any) {
            console.error(`Error initialising database: ${e.message}`);
            process.exit(1);
        }
    }

    if (process.env.NS_KEYMASTER_URL) {
        keymaster = new KeymasterClient();
        await keymaster.connect({
            url: process.env.NS_KEYMASTER_URL,
            waitUntilReady: true,
            intervalSeconds: 5,
            chatty: true,
        });
        console.log(`${SERVICE_NAME} using keymaster at ${process.env.NS_KEYMASTER_URL}`);
    }
    else {
        const passphrase = process.env.NS_WALLET_PASSPHRASE;

        if (!passphrase) {
            console.error('Error: NS_WALLET_PASSPHRASE environment variable not set');
            process.exit(1);
        }

        const gatekeeper = new GatekeeperClient();
        await gatekeeper.connect({
            url: GATEKEEPER_URL,
            waitUntilReady: true,
            intervalSeconds: 5,
            chatty: true,
        });
        const wallet = new WalletJson('wallet.json', 'data');
        const cipher = new CipherNode();
        keymaster = new Keymaster({
            gatekeeper,
            wallet,
            cipher,
            passphrase,
        });
        
        // Load existing wallet (decrypt and restore IDs/aliases)
        await keymaster.loadWallet();
        console.log(`${SERVICE_NAME} using gatekeeper at ${GATEKEEPER_URL}`);
    }

    await initOwnerIdentity();
    console.log(`${SERVICE_NAME} using wallet at ${WALLET_URL}`);
    console.log(`${SERVICE_NAME} listening at ${HOST_URL}`);
});
