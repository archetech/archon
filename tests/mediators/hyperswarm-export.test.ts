import { jest } from '@jest/globals';
import {
    ExportDeps,
    exportParts,
    flushQueue,
    MAX_PART_BYTES,
    MAX_PART_OPERATIONS,
} from '../../services/mediators/hyperswarm/src/export.ts';

// The mediator cleared and sent its Gatekeeper's queue whole. Under a steady
// stream of new operations one pass ran long, the queue outgrew what a Gatekeeper
// accepts in one request, and from then on every pass failed to clear it, held
// and logged all of it, and sent nothing, until the mediator ran out of memory
// (#1644).

interface Op { id: number; data: string }

const op = (id: number, bytes = 10): Op => ({ id, data: 'x'.repeat(bytes) });
const ids = (operations: Op[]) => operations.map(operation => operation.id);

function setup(queue: Op[], overrides: Partial<ExportDeps<Op>> = {}) {
    const log: string[] = [];
    const deps: ExportDeps<Op> = {
        getQueue: jest.fn(async () => queue),
        clearQueue: jest.fn(async (operations: Op[]) => { log.push(`clear ${ids(operations)}`); return true; }),
        relay: jest.fn(async (operations: Op[]) => { log.push(`relay ${ids(operations)}`); }),
        merge: jest.fn(async (operations: Op[]) => { log.push(`merge ${ids(operations)}`); }),
        ...overrides,
    };
    return { deps, log };
}

describe('exportParts', () => {
    it('keeps a short queue in one part and gives an empty queue none', () => {
        expect(exportParts([op(1), op(2)])).toEqual([[op(1), op(2)]]);
        expect(exportParts([])).toEqual([]);
    });

    it('splits by count, in order, without losing or repeating an operation', () => {
        const queue = Array.from({ length: 2500 }, (_, id) => op(id));
        const parts = exportParts(queue);
        expect(parts.map(part => part.length)).toEqual([1000, 1000, 500]);
        expect(parts.flat()).toEqual(queue);
    });

    it('splits by size, so that no part outgrows one request', () => {
        const queue = Array.from({ length: 40 }, (_, id) => op(id, 100_000));
        const parts = exportParts(queue);
        expect(parts.length).toBeGreaterThan(1);
        for (const part of parts) {
            expect(Buffer.byteLength(JSON.stringify(part))).toBeLessThan(MAX_PART_BYTES + 1000);
            expect(part.length).toBeLessThanOrEqual(MAX_PART_OPERATIONS);
        }
        expect(parts.flat()).toEqual(queue);
    });

    it('sends an operation larger than the limit alone', () => {
        const parts = exportParts([op(1), op(2, MAX_PART_BYTES * 2), op(3)]);
        expect(parts.map(ids)).toEqual([[1], [2], [3]]);
    });

    it('counts the bytes an operation is sent as, not its characters', () => {
        const wide: Op = { id: 1, data: '€'.repeat(100) };
        expect(exportParts([wide, wide, wide], 1000, 500).map(part => part.length)).toEqual([1, 1, 1]);
    });
});

describe('flushQueue', () => {
    it('does nothing with an empty queue', async () => {
        const { deps, log } = setup([]);
        expect(await flushQueue(deps)).toBe(0);
        expect(log).toEqual([]);
    });

    it('clears each part before sending it, and merges everything once', async () => {
        const queue = Array.from({ length: 2100 }, (_, id) => op(id));
        const { deps, log } = setup(queue);

        expect(await flushQueue(deps)).toBe(2100);

        expect(log.map(line => line.split(' ')[0])).toEqual(['clear', 'relay', 'clear', 'relay', 'clear', 'relay', 'merge']);
        expect((deps.clearQueue as jest.Mock).mock.calls.map(([part]) => (part as Op[]).length)).toEqual([1000, 1000, 100]);
        expect(deps.merge).toHaveBeenCalledWith(queue);
    });

    it('never asks a Gatekeeper to clear more than one request holds, however long the queue', async () => {
        // 300,000 operations of about a kilobyte: what a mediator met after one
        // slow pass under load, and could not clear in one request of 10 MB.
        const queue = Array.from({ length: 300_000 }, (_, id) => op(id, 950));
        const sizes: number[] = [];
        const { deps } = setup(queue, {
            clearQueue: jest.fn(async (operations: Op[]) => { sizes.push(Buffer.byteLength(JSON.stringify(operations))); }),
            relay: jest.fn(async () => {}),
            merge: jest.fn(async () => {}),
        });

        expect(await flushQueue(deps)).toBe(300_000);
        expect(Math.max(...sizes)).toBeLessThan(2 * MAX_PART_BYTES);
        expect(sizes.length).toBeGreaterThan(250);
    });

    it('leaves a part it cannot clear, and those after it, for the next pass', async () => {
        const queue = Array.from({ length: 2500 }, (_, id) => op(id));
        let calls = 0;
        const { deps, log } = setup(queue, {
            clearQueue: jest.fn(async () => { if (++calls === 2) throw new Error('length limit exceeded'); }),
        });

        await expect(flushQueue(deps)).rejects.toThrow('length limit exceeded');

        // The first part was cleared, so it was sent and is merged. The second
        // was not cleared and is not sent; the third is never reached.
        expect(deps.relay).toHaveBeenCalledTimes(1);
        expect(ids((deps.relay as jest.Mock).mock.calls[0][0] as Op[])).toEqual(ids(queue.slice(0, 1000)));
        expect(deps.merge).toHaveBeenCalledWith(queue.slice(0, 1000));
        expect(log.filter(line => line.startsWith('merge'))).toHaveLength(1);
    });

    // A Gatekeeper reports a store that could not clear with false, not an error.
    it('treats a false answer as a part it could not clear', async () => {
        const queue = Array.from({ length: 2500 }, (_, id) => op(id));
        let calls = 0;
        const { deps } = setup(queue, { clearQueue: jest.fn(async () => ++calls !== 2) });

        await expect(flushQueue(deps)).rejects.toThrow('could not clear');

        expect(deps.clearQueue).toHaveBeenCalledTimes(2);
        expect(deps.relay).toHaveBeenCalledTimes(1);
        expect(deps.merge).toHaveBeenCalledWith(queue.slice(0, 1000));
    });

    it('merges nothing when the first part cannot be cleared', async () => {
        const { deps } = setup([op(1)], { clearQueue: jest.fn(async () => { throw new Error('refused'); }) });
        await expect(flushQueue(deps)).rejects.toThrow('refused');
        expect(deps.relay).not.toHaveBeenCalled();
        expect(deps.merge).not.toHaveBeenCalled();
    });
});
