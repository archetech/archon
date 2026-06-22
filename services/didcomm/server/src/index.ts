import GatekeeperClient from '@didcid/gatekeeper/client';
import CipherNode from '@didcid/cipher/node';
import { createApp } from './didcomm-api.js';
import { MemoryMailboxStore } from './store.js';
import config from './config.js';

async function main() {
    const resolver = await GatekeeperClient.create({ url: config.gatekeeperURL });
    const cipher = new CipherNode();
    const store = new MemoryMailboxStore(config.messageTtlMs);
    const app = createApp({ store, resolver, cipher, uploadLimit: config.uploadLimit });

    app.listen(config.didcommPort, config.bindAddress, () => {
        // eslint-disable-next-line no-console
        console.log(`DIDComm relay listening on ${config.bindAddress}:${config.didcommPort}`);
    });
}

main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error('Failed to start DIDComm relay:', error);
    process.exit(1);
});
