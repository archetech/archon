import { jest } from '@jest/globals';
import { createGatekeeperApp } from '../../services/gatekeeper/server/src/gatekeeper-api.ts';

// A DID status scan holds the history read lock for its whole run. Scans that
// overlap queue user resolves behind every one of them, and on a large node a
// fixed-interval timer stacked them until the process never recovered (#1331).

const emptyStatus = {
    total: 0,
    byType: { agents: 0, assets: 0, confirmed: 0, unconfirmed: 0, ephemeral: 0, invalid: 0 },
    byRegistry: {},
    byVersion: {},
    eventsQueue: [],
};

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function createApp(checkDIDs: jest.Mock<any>, verifyDb = jest.fn<any>().mockResolvedValue({})) {
    return createGatekeeperApp({
        gatekeeper: { checkDIDs, verifyDb } as any,
        config: { statusInterval: 1, gcInterval: 1, db: 'json' } as any,
        httpLogging: false,
    });
}

describe('DID status scans', () => {
    beforeEach(() => {
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'timeEnd').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    it('shares one running scan between concurrent callers', async () => {
        const scan = deferred<typeof emptyStatus>();
        const checkDIDs = jest.fn<any>().mockReturnValue(scan.promise);
        const api = createApp(checkDIDs);

        const first = api.checkDids();
        const second = api.checkDids();
        const report = api.reportStatus();

        expect(checkDIDs).toHaveBeenCalledTimes(1);
        scan.resolve({ ...emptyStatus, total: 7 });
        await Promise.all([first, second, report]);

        expect((await api.getStatus()).dids.total).toBe(7);
    });

    it('starts a new scan once the previous one has finished', async () => {
        const checkDIDs = jest.fn<any>().mockResolvedValue(emptyStatus);
        const api = createApp(checkDIDs);

        await api.checkDids();
        await api.checkDids();

        expect(checkDIDs).toHaveBeenCalledTimes(2);
    });

    it('does not let a failed scan block later ones', async () => {
        const checkDIDs = jest.fn<any>()
            .mockRejectedValueOnce(new Error('redis down'))
            .mockResolvedValueOnce({ ...emptyStatus, total: 3 });
        const api = createApp(checkDIDs);

        await expect(api.checkDids()).rejects.toThrow('redis down');
        await api.checkDids();

        expect(checkDIDs).toHaveBeenCalledTimes(2);
        expect((await api.getStatus()).dids.total).toBe(3);
    });

    it('does not overlap a GC pass with a running status scan', async () => {
        const scan = deferred<typeof emptyStatus>();
        const checkDIDs = jest.fn<any>().mockReturnValue(scan.promise);
        const api = createApp(checkDIDs);
        jest.useFakeTimers();

        const report = api.reportStatus();
        const gc = api.gcLoop();
        await jest.advanceTimersByTimeAsync(0);

        expect(checkDIDs).toHaveBeenCalledTimes(1);
        scan.resolve(emptyStatus);
        await Promise.all([report, gc]);
    });

    it('schedules the next status report only after the current one finishes', async () => {
        const scan = deferred<typeof emptyStatus>();
        const checkDIDs = jest.fn<any>()
            .mockReturnValueOnce(scan.promise)
            .mockResolvedValue(emptyStatus);
        const api = createApp(checkDIDs);
        jest.useFakeTimers();

        const loop = api.statusLoop();
        // The scan outlasts several intervals; a fixed-rate timer would have
        // started three more by now.
        await jest.advanceTimersByTimeAsync(3 * 60 * 1000);
        expect(checkDIDs).toHaveBeenCalledTimes(1);

        scan.resolve(emptyStatus);
        await loop;
        await jest.advanceTimersByTimeAsync(60 * 1000);
        expect(checkDIDs).toHaveBeenCalledTimes(2);
    });

    it('keeps reporting after a failed status scan', async () => {
        const checkDIDs = jest.fn<any>()
            .mockRejectedValueOnce(new Error('redis down'))
            .mockResolvedValue(emptyStatus);
        const api = createApp(checkDIDs);
        jest.useFakeTimers();

        await api.statusLoop();
        await jest.advanceTimersByTimeAsync(60 * 1000);

        expect(checkDIDs).toHaveBeenCalledTimes(2);
        expect(console.error).toHaveBeenCalledWith(expect.stringContaining('redis down'));
    });
});
