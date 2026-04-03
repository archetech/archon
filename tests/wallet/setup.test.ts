import { jest } from '@jest/globals';
import { buildDescriptors } from '../../services/mediators/satoshi-wallet/src/derivation';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// Mock the setupWatchOnlyWallet logic without importing btc-wallet.ts.
// We test that the correct RPC calls are made with the right arguments.

type MockBtcClient = {
    command: jest.Mock;
    listDescriptors: jest.Mock;
    getDescriptorInfo: jest.Mock;
    importDescriptors: jest.Mock;
};

function createMockClient(): MockBtcClient {
    return {
        command: jest.fn(),
        listDescriptors: jest.fn(),
        getDescriptorInfo: jest.fn(),
        importDescriptors: jest.fn(),
    };
}

// Replicate the setup logic from btc-wallet.ts
async function setupWatchOnlyWallet(
    btcClient: MockBtcClient,
    mnemonic: string,
    network: 'mainnet' | 'signet' | 'testnet4',
    walletName: string,
    gapLimit: number,
): Promise<{ walletName: string; descriptors: string[] }> {
    try {
        await btcClient.command('createwallet', walletName, true, true, '', false, true);
    } catch (err: any) {
        if (err.message?.includes('already exists')) {
            try {
                await btcClient.command('loadwallet', walletName);
            } catch (loadErr: any) {
                if (!loadErr.message?.includes('already loaded')) {
                    throw loadErr;
                }
            }
        } else {
            throw err;
        }
    }

    const existing = await btcClient.listDescriptors(false);
    const existingDescs = existing.descriptors.map((d: any) => d.desc);
    const hasExternal = existingDescs.some((d: string) => d.includes('/0/*'));
    const hasInternal = existingDescs.some((d: string) => d.includes('/1/*'));

    if (hasExternal && hasInternal) {
        return { walletName, descriptors: existingDescs };
    }

    const descs = buildDescriptors(mnemonic, network);

    const extInfo = await btcClient.getDescriptorInfo(descs.external);
    const intInfo = await btcClient.getDescriptorInfo(descs.internal);

    const requests: any[] = [];

    if (!hasExternal) {
        requests.push({
            desc: extInfo.descriptor,
            timestamp: 'now',
            active: true,
            range: [0, gapLimit],
            internal: false,
        });
    }

    if (!hasInternal) {
        requests.push({
            desc: intInfo.descriptor,
            timestamp: 'now',
            active: true,
            range: [0, gapLimit],
            internal: true,
        });
    }

    const results = await btcClient.importDescriptors(requests);

    for (const result of results) {
        if (!result.success) {
            throw new Error(`Failed to import descriptor: ${result.error?.message}`);
        }
    }

    return {
        walletName,
        descriptors: [extInfo.descriptor, intInfo.descriptor],
    };
}

describe('setupWatchOnlyWallet', () => {
    let btcClient: MockBtcClient;

    beforeEach(() => {
        btcClient = createMockClient();
    });

    it('creates wallet with correct params (disable_private_keys, blank, descriptors)', async () => {
        btcClient.listDescriptors.mockResolvedValue({ descriptors: [] });
        btcClient.getDescriptorInfo.mockResolvedValue({ descriptor: 'wpkh(...)#checksum' });
        btcClient.importDescriptors.mockResolvedValue([{ success: true }, { success: true }]);

        await setupWatchOnlyWallet(btcClient, TEST_MNEMONIC, 'signet', 'test-wallet', 20);

        expect(btcClient.command).toHaveBeenCalledWith(
            'createwallet', 'test-wallet', true, true, '', false, true,
        );
    });

    it('loads existing wallet if createwallet says "already exists"', async () => {
        btcClient.command
            .mockRejectedValueOnce(new Error('Database already exists'))
            .mockResolvedValueOnce({}); // loadwallet succeeds
        btcClient.listDescriptors.mockResolvedValue({ descriptors: [] });
        btcClient.getDescriptorInfo.mockResolvedValue({ descriptor: 'wpkh(...)#checksum' });
        btcClient.importDescriptors.mockResolvedValue([{ success: true }, { success: true }]);

        await setupWatchOnlyWallet(btcClient, TEST_MNEMONIC, 'signet', 'test-wallet', 20);

        expect(btcClient.command).toHaveBeenCalledWith('loadwallet', 'test-wallet');
    });

    it('tolerates "already loaded" error on loadwallet', async () => {
        btcClient.command
            .mockRejectedValueOnce(new Error('Database already exists'))
            .mockRejectedValueOnce(new Error('Wallet file verification failed. already loaded'));
        btcClient.listDescriptors.mockResolvedValue({ descriptors: [] });
        btcClient.getDescriptorInfo.mockResolvedValue({ descriptor: 'wpkh(...)#checksum' });
        btcClient.importDescriptors.mockResolvedValue([{ success: true }, { success: true }]);

        // Should not throw
        await setupWatchOnlyWallet(btcClient, TEST_MNEMONIC, 'signet', 'test-wallet', 20);
    });

    it('returns early with existing descriptors if both external and internal found', async () => {
        btcClient.listDescriptors.mockResolvedValue({
            descriptors: [
                { desc: 'wpkh([abc]/0/*)#ext' },
                { desc: 'wpkh([abc]/1/*)#int' },
            ],
        });

        const result = await setupWatchOnlyWallet(btcClient, TEST_MNEMONIC, 'signet', 'test-wallet', 20);

        expect(result.descriptors).toEqual(['wpkh([abc]/0/*)#ext', 'wpkh([abc]/1/*)#int']);
        expect(btcClient.getDescriptorInfo).not.toHaveBeenCalled();
        expect(btcClient.importDescriptors).not.toHaveBeenCalled();
    });

    it('imports both external and internal descriptors on fresh wallet', async () => {
        btcClient.listDescriptors.mockResolvedValue({ descriptors: [] });
        btcClient.getDescriptorInfo
            .mockResolvedValueOnce({ descriptor: 'wpkh(ext)#abc' })
            .mockResolvedValueOnce({ descriptor: 'wpkh(int)#def' });
        btcClient.importDescriptors.mockResolvedValue([{ success: true }, { success: true }]);

        await setupWatchOnlyWallet(btcClient, TEST_MNEMONIC, 'signet', 'test-wallet', 20);

        const importCall = btcClient.importDescriptors.mock.calls[0][0];
        expect(importCall).toHaveLength(2);
        expect(importCall[0].internal).toBe(false);
        expect(importCall[1].internal).toBe(true);
        expect(importCall[0].range).toEqual([0, 20]);
    });

    it('passes descriptors with correct key origin to getDescriptorInfo', async () => {
        btcClient.listDescriptors.mockResolvedValue({ descriptors: [] });
        btcClient.getDescriptorInfo.mockResolvedValue({ descriptor: 'wpkh(...)#checksum' });
        btcClient.importDescriptors.mockResolvedValue([{ success: true }, { success: true }]);

        await setupWatchOnlyWallet(btcClient, TEST_MNEMONIC, 'mainnet', 'test-wallet', 20);

        const descs = buildDescriptors(TEST_MNEMONIC, 'mainnet');
        expect(btcClient.getDescriptorInfo).toHaveBeenCalledWith(descs.external);
        expect(btcClient.getDescriptorInfo).toHaveBeenCalledWith(descs.internal);
    });

    it('throws if importDescriptors reports failure', async () => {
        btcClient.listDescriptors.mockResolvedValue({ descriptors: [] });
        btcClient.getDescriptorInfo.mockResolvedValue({ descriptor: 'wpkh(...)#checksum' });
        btcClient.importDescriptors.mockResolvedValue([
            { success: false, error: { message: 'Invalid descriptor' } },
        ]);

        await expect(
            setupWatchOnlyWallet(btcClient, TEST_MNEMONIC, 'signet', 'test-wallet', 20),
        ).rejects.toThrow('Failed to import descriptor: Invalid descriptor');
    });

    it('throws on unexpected createwallet error', async () => {
        btcClient.command.mockRejectedValue(new Error('Compiled without sqlite support'));

        await expect(
            setupWatchOnlyWallet(btcClient, TEST_MNEMONIC, 'signet', 'test-wallet', 20),
        ).rejects.toThrow('Compiled without sqlite support');
    });
});
