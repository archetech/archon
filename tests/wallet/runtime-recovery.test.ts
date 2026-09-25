import { jest } from '@jest/globals';
import { WalletRecovery } from '../../services/mediators/satoshi-wallet/src/wallet-recovery.ts';
import { assertDescriptorsMatch } from '../../services/mediators/satoshi-wallet/src/descriptor-check.ts';
import { buildDescriptors } from '../../services/mediators/satoshi-wallet/src/derivation.ts';

const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const otherMnemonic = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const unloaded = Object.assign(new Error('Requested wallet does not exist or is not loaded'), { code: -18 });
let recovery: WalletRecovery<string>;
let setup: jest.Mock<() => Promise<string>>;
let changed: jest.Mock<(ready: boolean) => void>;
let retryFailed: jest.Mock<(error: unknown) => void>;

beforeEach(() => {
    jest.useFakeTimers();
    setup = jest.fn<() => Promise<string>>().mockResolvedValue('loaded');
    changed = jest.fn();
    retryFailed = jest.fn();
    recovery = new WalletRecovery({ setup, changed, retryFailed, retryIntervalMs: 30_000 });
});
afterEach(() => {
    recovery.stop();
    jest.useRealTimers();
});

test('successful startup can recover repeatedly from runtime wallet unloads', async () => {
    await recovery.setup();
    expect(recovery.ready).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
    for (let i = 0; i < 2; i++) {
        expect(recovery.walletUnloaded(unloaded)).toBe(true);
        expect(recovery.ready).toBe(false);
        expect(changed).toHaveBeenLastCalledWith(false);
        await jest.advanceTimersByTimeAsync(30_000);
        expect(recovery.ready).toBe(true);
        expect(changed).toHaveBeenLastCalledWith(true);
        expect(jest.getTimerCount()).toBe(0);
    }
    expect(setup).toHaveBeenCalledTimes(3);
});

test('concurrent failures and manual setup share one in-flight recovery attempt', async () => {
    await recovery.setup();
    let finish!: (result: string) => void;
    setup.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    for (let i = 0; i < 10; i++) recovery.walletUnloaded(unloaded);
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(90_000);
    expect(setup).toHaveBeenCalledTimes(2);
    const manual = recovery.setup();
    finish('reloaded');
    await expect(manual).resolves.toBe('reloaded');
    expect(recovery.ready).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
});

test('transient setup failure keeps retrying until the upstream returns', async () => {
    await recovery.setup();
    setup.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    recovery.walletUnloaded(unloaded);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(recovery.ready).toBe(false);
    expect(retryFailed).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(recovery.ready).toBe(true);
});

test('startup failure uses the same retry loop', async () => {
    setup.mockRejectedValueOnce(new Error('Keymaster unavailable'));
    await expect(recovery.setup()).rejects.toThrow('Keymaster unavailable');
    recovery.start();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(recovery.ready).toBe(true);
});

test('descriptor mismatch during recovery stays refused until explicit setup succeeds', async () => {
    await recovery.setup();
    const descriptors = buildDescriptors(otherMnemonic, 'mainnet');
    setup.mockImplementationOnce(async () => {
        assertDescriptorsMatch([descriptors.external, descriptors.internal], mnemonic, 'mainnet', 'watch');
        return 'unreachable';
    });
    recovery.walletUnloaded(unloaded);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(recovery.descriptorMismatch).toContain('different seed');
    expect(recovery.fatal).toBe(true);
    expect(recovery.ready).toBe(false);
    recovery.walletUnloaded(unloaded);
    recovery.start();
    await jest.advanceTimersByTimeAsync(90_000);
    expect(setup).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
    setup.mockRejectedValueOnce(new Error('Keymaster unavailable'));
    await expect(recovery.setup()).rejects.toThrow('Keymaster unavailable');
    recovery.walletUnloaded(unloaded);
    expect(recovery.fatal).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
    await recovery.setup();
    expect(recovery.descriptorMismatch).toBeUndefined();
    expect(recovery.ready).toBe(true);
});

test('a node without SQLite support does not retry automatically', async () => {
    setup.mockRejectedValue(new Error('compiled without sqlite support'));
    await expect(recovery.setup()).rejects.toThrow('sqlite');
    recovery.start();
    expect(jest.getTimerCount()).toBe(0);
});

test.each([
    Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }),
    Object.assign(new Error('insufficient funds'), { code: -6 }),
    Object.assign(new Error('wallet not specified'), { code: -19 }),
    new Error('Requested wallet does not exist or is not loaded'),
])('unrelated errors do not trigger wallet setup: %s', async error => {
    await recovery.setup();
    expect(recovery.walletUnloaded(error)).toBe(false);
    expect(recovery.ready).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
    expect(setup).toHaveBeenCalledTimes(1);
});
