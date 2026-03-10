import { jest } from '@jest/globals';

type BtcClientMock = {
    command: jest.Mock;
    getNewAddress: jest.Mock;
};

function createMockClient(): BtcClientMock {
    return {
        command: jest.fn(),
        getNewAddress: jest.fn(),
    };
}

// Replicate the caching logic from btc-wallet.ts
let cachedReceiveAddress: string | null = null;

async function getReceiveAddress(btcClient: BtcClientMock): Promise<string> {
    if (cachedReceiveAddress) {
        const received = await btcClient.command('getreceivedbyaddress', cachedReceiveAddress, 0);
        if (received === 0) {
            return cachedReceiveAddress;
        }
    }

    cachedReceiveAddress = await btcClient.getNewAddress('receive', 'bech32');
    return cachedReceiveAddress;
}

describe('Address caching', () => {
    let btcClient: BtcClientMock;

    beforeEach(() => {
        cachedReceiveAddress = null;
        btcClient = createMockClient();
    });

    it('generates a new address on first call', async () => {
        btcClient.getNewAddress.mockResolvedValue('bc1qtest1');

        const addr = await getReceiveAddress(btcClient);

        expect(addr).toBe('bc1qtest1');
        expect(btcClient.getNewAddress).toHaveBeenCalledWith('receive', 'bech32');
        expect(btcClient.command).not.toHaveBeenCalled();
    });

    it('returns cached address when unfunded', async () => {
        btcClient.getNewAddress.mockResolvedValue('bc1qtest1');
        btcClient.command.mockResolvedValue(0);

        // First call — generates new address
        await getReceiveAddress(btcClient);
        // Second call — should return cached
        const addr = await getReceiveAddress(btcClient);

        expect(addr).toBe('bc1qtest1');
        expect(btcClient.getNewAddress).toHaveBeenCalledTimes(1);
        expect(btcClient.command).toHaveBeenCalledWith('getreceivedbyaddress', 'bc1qtest1', 0);
    });

    it('generates new address when cached one has received funds', async () => {
        btcClient.getNewAddress
            .mockResolvedValueOnce('bc1qtest1')
            .mockResolvedValueOnce('bc1qtest2');
        btcClient.command.mockResolvedValue(0.001); // non-zero = funded

        // First call
        const addr1 = await getReceiveAddress(btcClient);
        expect(addr1).toBe('bc1qtest1');

        // Second call — cached is funded, should generate new
        const addr2 = await getReceiveAddress(btcClient);
        expect(addr2).toBe('bc1qtest2');
        expect(btcClient.getNewAddress).toHaveBeenCalledTimes(2);
    });

    it('does not call getNewAddress repeatedly when address stays unfunded', async () => {
        btcClient.getNewAddress.mockResolvedValue('bc1qstable');
        btcClient.command.mockResolvedValue(0);

        await getReceiveAddress(btcClient);
        await getReceiveAddress(btcClient);
        await getReceiveAddress(btcClient);
        await getReceiveAddress(btcClient);
        await getReceiveAddress(btcClient);

        expect(btcClient.getNewAddress).toHaveBeenCalledTimes(1);
        expect(btcClient.command).toHaveBeenCalledTimes(4); // not called on first
    });

    it('advances through multiple addresses as each gets funded', async () => {
        btcClient.getNewAddress
            .mockResolvedValueOnce('bc1qaddr1')
            .mockResolvedValueOnce('bc1qaddr2')
            .mockResolvedValueOnce('bc1qaddr3');

        // First: generate addr1
        btcClient.command.mockResolvedValue(0);
        const a1 = await getReceiveAddress(btcClient);
        expect(a1).toBe('bc1qaddr1');

        // Fund addr1, should advance to addr2
        btcClient.command.mockResolvedValue(0.5);
        const a2 = await getReceiveAddress(btcClient);
        expect(a2).toBe('bc1qaddr2');

        // Fund addr2, should advance to addr3
        btcClient.command.mockResolvedValue(1.0);
        const a3 = await getReceiveAddress(btcClient);
        expect(a3).toBe('bc1qaddr3');
    });
});
