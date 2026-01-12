// Subpath import example
// import Keymaster from '@didcid/keymaster';
// import KeymasterClient from '@didcid/keymaster/client';
// import GatekeeperClient from '@didcid/gatekeeper/client';
// import WalletJsonMemory from '@didcid/keymaster/wallet/json-memory';
// import CipherNode from '@didcid/cipher/node';

// If your build does not support subpaths import use the following example
import Keymaster, { KeymasterClient, WalletJsonMemory } from '@didcid/keymaster';
import { GatekeeperClient } from '@didcid/gatekeeper';
import CipherNode from '@didcid/cipher';

import dotenv from 'dotenv';

dotenv.config();

async function main() {
    let keymaster: any;

    if (process.env.KEYMASTER_SERVICE_URL) {
        keymaster = new KeymasterClient();
        await keymaster.connect({
            url: process.env.KEYMASTER_SERVICE_URL,
            waitUntilReady: true,
            intervalSeconds: 5,
            chatty: true,
        });
    } else {
        const GATEKEEPER_SERVICE_URL = process.env.GATEKEEPER_SERVICE_URL || 'http://localhost:4224';
        const gatekeeperClient = new GatekeeperClient();
        await gatekeeperClient.connect({
            url: GATEKEEPER_SERVICE_URL,
            waitUntilReady: true,
            intervalSeconds: 5,
            chatty: true
        });

        const wallet = new WalletJsonMemory();
        const cipher = new CipherNode();

        keymaster = new Keymaster({
            gatekeeper: gatekeeperClient,
            wallet,
            cipher,
            passphrase: process.env.ARCHON_ENCRYPTED_PASSPHRASE || "passphrase",
        });
    }

    try {
        const uniqueIdName = `user_${Date.now()}`;

        const userDID = await keymaster.createId(uniqueIdName, { registry: 'local' });
        console.log('Created User DID:', userDID);

        const didDocument = await keymaster.resolveDID(userDID);
        console.log('User DID Document:');
        console.log(JSON.stringify(didDocument, null, 2));

    } catch (error) {
        console.error(`An error occurred during the demo: ${error}`);
    }
}

main().catch(error => {
    console.error("Unhandled error in main:", error);
    process.exit(1);
});
