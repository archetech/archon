import { decideWalletStartup } from '@didcid/common/wallet-startup';
import { KeymasterError, WalletNotFoundError } from '@didcid/common/errors';

// An empty store and a lost one read the same from every backend, so the
// operator's setting decides between them. The three conditions that reach
// this — store not reachable, wallet unusable, store empty — have three
// different remedies, and a startup path that conflates any two of them gives
// advice that replaces the identity it exists to protect (#1051).

const OPTIONS = {
    store: 'redis',
    requireExisting: false,
    requireSetting: 'ARCHON_KEYMASTER_REQUIRE_WALLET',
    attempts: 4,
    delayMs: 1_000,
};

function reader(...outcomes: (unknown | 'ok')[]) {
    const calls: number[] = [];

    return {
        calls,
        load: async () => {
            const outcome = outcomes[calls.length] ?? outcomes[outcomes.length - 1];
            calls.push(1);

            if (outcome !== 'ok') {
                throw outcome;
            }

            return {};
        },
    };
}

const slept: number[] = [];
const sleep = async (ms: number) => { slept.push(ms); };

beforeEach(() => {
    slept.length = 0;
});

describe('decideWalletStartup', () => {
    it('carries on when the store holds a wallet', async () => {
        const { load, calls } = reader('ok');

        expect(await decideWalletStartup(load, { ...OPTIONS, sleep })).toStrictEqual({ action: 'use' });
        expect(calls).toHaveLength(1);
    });

    it('provisions an empty store when the operator has not said otherwise', async () => {
        const { load } = reader(new WalletNotFoundError());

        const decision = await decideWalletStartup(load, { ...OPTIONS, sleep });

        expect(decision).toMatchObject({ action: 'provision' });
        expect(decision).toHaveProperty('warning', expect.stringContaining('redis'));
    });

    it('refuses an empty store when the operator says the node has an identity', async () => {
        const { load, calls } = reader(new WalletNotFoundError());

        const decision = await decideWalletStartup(load, { ...OPTIONS, requireExisting: true, sleep });

        expect(decision).toMatchObject({ action: 'refuse' });
        expect(decision).toHaveProperty('fatal', expect.stringContaining('ARCHON_KEYMASTER_REQUIRE_WALLET'));
        // Nothing to wait for: the store answered.
        expect(calls).toHaveLength(1);
        expect(slept).toStrictEqual([]);
    });

    it('stops at once on a wallet that was read and cannot be used', async () => {
        // A wrong passphrase does not become right by asking again.
        const { load, calls } = reader(new KeymasterError('Incorrect passphrase.'));

        const decision = await decideWalletStartup(load, { ...OPTIONS, sleep });

        expect(decision).toMatchObject({ action: 'refuse' });
        expect(decision).toHaveProperty('fatal', expect.stringContaining('Incorrect passphrase.'));
        expect(calls).toHaveLength(1);
    });

    it('waits for a store that is still starting', async () => {
        const { load, calls } = reader(new Error('ECONNREFUSED'), new Error('ECONNREFUSED'), 'ok');

        expect(await decideWalletStartup(load, { ...OPTIONS, sleep })).toStrictEqual({ action: 'use' });
        expect(calls).toHaveLength(3);
        expect(slept).toStrictEqual([1_000, 1_000]);
    });

    // Each attempt re-reads rather than reusing an earlier answer, so a wallet
    // that appears or disappears while the store is coming up is seen.
    it('reads again rather than deciding from the first answer', async () => {
        const { load } = reader(new Error('ECONNREFUSED'), new WalletNotFoundError());

        expect(await decideWalletStartup(load, { ...OPTIONS, sleep })).toMatchObject({ action: 'provision' });
    });

    it('gives up on a store that never answers, without calling it empty', async () => {
        const { load, calls } = reader(new Error('ECONNREFUSED'));

        const decision = await decideWalletStartup(load, { ...OPTIONS, sleep });

        expect(decision).toMatchObject({ action: 'refuse' });
        expect(calls).toHaveLength(4);
        expect(slept).toStrictEqual([1_000, 1_000, 1_000]);

        // Acting on either would replace the identity this path protects.
        const { fatal } = decision as { fatal: string };
        expect(fatal).toContain('Could not read the wallet store');
        expect(fatal).not.toMatch(/empty/i);
        expect(fatal).not.toMatch(/unset/i);
    });
});
