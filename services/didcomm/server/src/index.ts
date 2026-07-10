import GatekeeperClient from '@didcid/clients/gatekeeper';
import CipherNode from '@didcid/cipher/node';
import { createApp } from './didcomm-api.js';
import { MailboxStore, MemoryMailboxStore, RedisMailboxStore } from './store.js';
import config from './config.js';

async function createStore(): Promise<MailboxStore> {
    if (config.db === 'redis') {
        return RedisMailboxStore.create(config.redisURL);
    }
    return new MemoryMailboxStore(config.messageTtlMs);
}

async function main() {
    const resolver = await GatekeeperClient.create({ url: config.gatekeeperURL });
    const cipher = new CipherNode();
    const store = await createStore();
    const app = createApp({
        store,
        resolver,
        cipher,
        uploadLimit: config.uploadLimit,
        torProxy: config.torProxy,
        allowPrivateEgress: config.allowPrivateEgress,
    });

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
