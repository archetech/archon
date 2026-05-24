import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { jest } from '@jest/globals';
import CipherNode from '@didcid/cipher/node';
import { Operation } from '@didcid/gatekeeper/types';
import { JsonPinStore } from '../../services/mediators/filecoin/src/state.ts';
import { processFilecoinQueue } from '../../services/mediators/filecoin/src/sync.ts';

const cipher = new CipherNode();

function operation(id: string): Operation {
    return {
        type: 'create',
        created: new Date('2026-05-23T00:00:00.000Z').toISOString(),
        operation: { id },
        registration: {
            version: 1,
            registry: 'BTC:signet',
        },
    } as unknown as Operation;
}

async function withStore<T>(fn: (store: JsonPinStore) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'archon-filecoin-test-'));
    try {
        return await fn(new JsonPinStore(join(dir, 'pins.json')));
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

describe('filecoin mediator queue processing', () => {

    it('clears successfully pinned operations', async () => {
        await withStore(async (store) => {
            const op = operation('ok');
            const cleared: Operation[][] = [];
            const gatekeeper = {
                getQueue: jest.fn().mockResolvedValue([op]),
                clearQueue: jest.fn(async (_registry: string, ops: Operation[]) => {
                    cleared.push(ops);
                    return true;
                }),
                addJSON: jest.fn().mockResolvedValue('bagaaieraok'),
            };
            const walletPin = jest.fn().mockResolvedValue({ status: 'pinned' });

            const result = await processFilecoinQueue('pin', gatekeeper, store, cipher, walletPin);

            expect(result).toMatchObject({ queued: 1, pinned: 1, failed: 0 });
            expect(cleared).toStrictEqual([[op]]);
            expect(walletPin).toHaveBeenCalledWith('bagaaieraok', expect.any(String), 'BTC:signet');
        });
    });

    it('leaves failed operations queued for the next import cycle', async () => {
        await withStore(async (store) => {
            const op = operation('fail');
            const gatekeeper = {
                getQueue: jest.fn().mockResolvedValue([op]),
                clearQueue: jest.fn(),
                addJSON: jest.fn().mockResolvedValue('bagaaierafail'),
            };
            const walletPin = jest.fn().mockRejectedValue(new Error('too many requests'));

            const result = await processFilecoinQueue('pin', gatekeeper, store, cipher, walletPin);

            expect(result).toMatchObject({
                queued: 1,
                pinned: 0,
                failed: 1,
                lastError: 'too many requests',
                lastFailedFingerprint: expect.any(String),
            });
            expect(gatekeeper.clearQueue).not.toHaveBeenCalled();
            expect(store.count('failed')).toBe(1);
        });
    });
});
