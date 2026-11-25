import { existsSync } from 'fs';
import type { Server } from 'http';

import CipherNode from '@didcid/cipher/node';
import GatekeeperClient from '@didcid/clients/gatekeeper';
import { WalletNotFoundError } from '@didcid/common/errors';
import { fetchPublicHttps } from '@didcid/common/net';
import Keymaster from '@didcid/keymaster';
import WalletJson from '@didcid/keymaster/wallet/json';
import { PERMITTED_REGISTRIES } from '@didcid/memeplex';
import { IndexerClient, MemeplexClient } from '@didcid/memeplex/client';
import { createMemepoolApp } from './api.js';

export interface MemepoolSettings {
    gatekeeperURL: string;
    port: number;
    bindAddress: string;
    name: string;
    publicURL: string;
    indexerURL?: string;
    pagesDir: string;
    dataDir: string;
    passphrase: string;
    registry: string;
    challengesPerMinute: number;
    sessionHours: number;
    trustedProxies: number;
    gatekeeperTimeout: number;
}

// Starts the service: reaches the Gatekeeper, opens the wallet that holds the
// service's key (making the wallet and the identity on a first start), and
// listens. Resolves once it is listening.
// The most the service reads of a domain's answer about a name, in bytes. The
// answer is a DID and little else.
const NAME_ANSWER_LIMIT = 16_384;

// The DID an address's domain says the address belongs to, or nothing when it
// says none. A domain gives out its names at `/.well-known/names/<name>`, which
// is where Keymaster asks as well.
//
// The domain is one a stranger chose. The request reaches no address inside
// this network, ends when `signal` says to, and its answer is read no further
// than the limit, so a domain that never finishes answering is not waited on
// or held in memory.
export async function addressOwner(address: string, signal: AbortSignal, fetcher: typeof fetchPublicHttps = fetchPublicHttps): Promise<string | null> {
    const [name, domain, ...more] = address.split('@');

    if (!name || !domain || more.length > 0) {
        return null;
    }

    try {
        const response = await fetcher(`https://${domain}/.well-known/names/${encodeURIComponent(name)}`, { signal });

        if (!response.ok || !response.body) {
            await response.body?.cancel();
            return null;
        }

        const parts: Uint8Array[] = [];
        let read = 0;
        const reader = response.body.getReader();
        const stop = () => { void reader.cancel().catch(() => undefined); };

        signal.addEventListener('abort', stop, { once: true });
        try {
            for (;;) {
                const { done, value } = await reader.read();

                if (done) {
                    break;
                }
                read += value.length;
                if (read > NAME_ANSWER_LIMIT || signal.aborted) {
                    await reader.cancel();
                    return null;
                }
                parts.push(value);
            }
        }
        finally {
            signal.removeEventListener('abort', stop);
        }

        if (signal.aborted) {
            return null;
        }

        const answer = JSON.parse(Buffer.concat(parts).toString('utf8')) as { did?: unknown } | null;

        return typeof answer?.did === 'string' ? answer.did : null;
    }
    catch {
        return null;
    }
}

export async function startMemepool(
    settings: MemepoolSettings,
    version: { version: string; commit: string },
    log: Pick<Console, 'log' | 'warn'> = console,
): Promise<{ server: Server; did: string }> {
    if (!settings.passphrase) {
        throw new Error('ARCHON_MEMEPOOL_WALLET_PASSPHRASE is not set');
    }

    // Nothing made on `local` leaves the node, and Keymaster makes everything
    // a local identity creates there: such a service could publish on no
    // grant's registry. It is refused before a wallet or an identity is made.
    if (settings.registry === 'local') {
        throw new Error('ARCHON_MEMEPOOL_REGISTRY cannot be local: Memepool publishes on the registries of its users\' grants, and a local identity can publish only on local');
    }

    const gatekeeper = new GatekeeperClient();

    await gatekeeper.connect({
        url: settings.gatekeeperURL,
        waitUntilReady: true,
        intervalSeconds: 5,
        chatty: log === console,
        timeoutMs: settings.gatekeeperTimeout * 1000,
    });

    // The service's key is in a wallet of its own. Every grant a user has made
    // names the DID in it, so a wallet made afresh is a client nobody has
    // granted: that is said aloud, since on any start but the first it means
    // the data directory was lost.
    const keymaster = new Keymaster({
        gatekeeper,
        wallet: new WalletJson('wallet.json', settings.dataDir),
        cipher: new CipherNode(),
        passphrase: settings.passphrase,
    });

    try {
        await keymaster.loadWallet();
    }
    catch (error) {
        if (!(error instanceof WalletNotFoundError)) {
            throw error;
        }
        log.warn(`Memepool: no wallet at ${settings.dataDir}/wallet.json, creating one. If this service has run before, its data directory is missing and users will have to grant it again.`);
        await keymaster.newWallet();
    }

    if (!(await keymaster.listIds()).includes(settings.name)) {
        log.log(`Creating the identity ${settings.name} on ${settings.registry}`);
        await keymaster.createId(settings.name, { registry: settings.registry });
    }
    // Challenges are made, and their answers read, as the current identity.
    await keymaster.setCurrentId(settings.name);

    const client = new MemeplexClient({ keymaster, gatekeeper, identity: settings.name });
    // What the service can publish on: the permitted registries its node has,
    // which the service asks the node for whenever it needs to know.
    const supported = await gatekeeper.listRegistries();

    log.log(`Memepool can publish on ${PERMITTED_REGISTRIES.filter(registry => supported.includes(registry)).join(', ') || 'no permitted registry'}`);
    const did = await client.did();

    log.log(`Memepool is ${did}`);

    // The identity may be one the wallet already held.
    const own = await keymaster.resolveDID(did);

    if (own.didDocumentRegistration?.registry === 'local') {
        throw new Error(`Memepool's identity ${settings.name} is registered on local, so nothing it publishes can be on a grant's registry. Give the service a wallet whose identity is on another registry.`);
    }

    const indexer = settings.indexerURL ? new IndexerClient(settings.indexerURL) : undefined;
    const app = createMemepoolApp({
        client,
        keymaster,
        name: settings.name,
        publicURL: settings.publicURL || undefined,
        pagesDir: settings.pagesDir && existsSync(settings.pagesDir) ? settings.pagesDir : undefined,
        registries: () => gatekeeper.listRegistries(),
        // The node's IPFS pins what is added to it.
        content: { add: text => gatekeeper.addText(text) },
        // The node reads no more than the limit it is asked for, and refuses
        // what is larger. The CID is one a stranger wrote, so it is asked for
        // only where it has the shape of one.
        images: { get: (cid, limit) => (/^[A-Za-z0-9]{1,128}$/.test(cid) ? gatekeeper.getData(cid, limit).catch(() => null) : Promise.resolve(null)) },
        addresses: { owner: (address, signal) => addressOwner(address, signal) },
        previews: indexer && {
            publication: did => indexer.publication(did),
            // No more of a body than a line about it and its first image need.
            body: cid => gatekeeper.getText(cid, 1_000_000),
            name: async did => {
                const name = ((await keymaster.resolveDID(did)).didDocumentData as { name?: unknown } | undefined)?.name;

                return typeof name === 'string' ? name : undefined;
            },
        },
        version,
        challengesPerMinute: settings.challengesPerMinute,
        sessionLifetime: settings.sessionHours * 60 * 60_000,
    });

    app.set('trust proxy', settings.trustedProxies);

    const server = await new Promise<Server>((resolve, reject) => {
        const listening = app.listen(settings.port, settings.bindAddress, () => resolve(listening));

        listening.once('error', reject);
    });

    log.log(`Memepool listening on ${settings.bindAddress}:${settings.port}`);

    return { server, did };
}
