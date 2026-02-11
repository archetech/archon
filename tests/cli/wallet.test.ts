import { archon, resetAll, freshWalletWithId } from './helpers';

afterAll(async () => {
    await resetAll();
});

describe('wallet', () => {
    test('new-wallet returns valid wallet JSON', async () => {
        const output = await archon('new-wallet');
        const wallet = JSON.parse(output);

        expect(wallet).toHaveProperty('version', 2);
        expect(wallet).toHaveProperty('seed');
        expect(wallet.seed).toHaveProperty('mnemonicEnc');
        expect(wallet.seed.mnemonicEnc).toHaveProperty('salt');
        expect(wallet.seed.mnemonicEnc).toHaveProperty('iv');
        expect(wallet.seed.mnemonicEnc).toHaveProperty('data');
        expect(wallet).toHaveProperty('counter');
        expect(wallet).toHaveProperty('ids');
    });

    test('show-wallet returns wallet with seed details', async () => {
        await archon('new-wallet');
        const output = await archon('show-wallet');
        const wallet = JSON.parse(output);

        expect(wallet).toHaveProperty('seed');
        expect(wallet.seed).toHaveProperty('mnemonicEnc');
        expect(wallet.seed.mnemonicEnc).toHaveProperty('salt');
        expect(wallet.seed.mnemonicEnc).toHaveProperty('iv');
        expect(wallet.seed.mnemonicEnc).toHaveProperty('data');
        expect(wallet).toHaveProperty('counter');
        expect(wallet).toHaveProperty('ids');
    });

    test('check-wallet reports no problems after creating an ID', async () => {
        await freshWalletWithId('qa-check');
        const output = await archon('check-wallet');

        expect(output).toContain('DIDs checked, no problems found');
    });

    test('show-mnemonic returns 12 words', async () => {
        await archon('new-wallet');
        const output = await archon('show-mnemonic');
        const words = output.trim().split(/\s+/);

        expect(words).toHaveLength(12);
    });
});
