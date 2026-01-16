import Gatekeeper from '@didcid/gatekeeper';
import Keymaster from '@didcid/keymaster';
import CipherNode from '@didcid/cipher/node';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import WalletJsonMemory from '@didcid/keymaster/wallet/json-memory';
import HeliaClient from '@didcid/ipfs/helia';

const PASSPHRASE = 'passphrase';

let ipfs: HeliaClient;

beforeAll(async () => {
    ipfs = new HeliaClient();
    await ipfs.start();
});

afterAll(async () => {
    if (ipfs) {
        await ipfs.stop();
    }
});

// Run with: PBKDF2_ITERATIONS=1 npm test -- --testPathPattern="generate-mocks"
describe('generate mocks', () => {
    it.skip('should generate mock wallet data for tests', async () => {
        const db = new DbJsonMemory('test');
        const gatekeeper = new Gatekeeper({ db, ipfs, registries: ['local'] });
        const wallet = new WalletJsonMemory();
        const cipher = new CipherNode();
        const keymaster = new Keymaster({ gatekeeper, wallet, cipher, passphrase: PASSPHRASE });

        // Create a new wallet
        await keymaster.loadWallet();

        // Get the unencrypted wallet
        const unencrypted = await keymaster.loadWallet();
        console.log('\n\nMOCK_WALLET_V1:');
        console.log(JSON.stringify(unencrypted, null, 4));

        // Get the encrypted wallet
        const encrypted = await keymaster.exportEncryptedWallet();
        console.log('\n\nMOCK_WALLET_V1_ENCRYPTED:');
        console.log(JSON.stringify(encrypted, null, 4));
    });
});
