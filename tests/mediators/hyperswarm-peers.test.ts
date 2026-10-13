import { jest } from '@jest/globals';
import {
    describeError,
    NodeInfo,
    PeerDeps,
    PeerTracker,
    RETRY_BASE_MS,
    RETRY_MAX_MS,
} from '../../services/mediators/hyperswarm/src/peers.ts';

// A node used to stop trying a peer after its first failed attempt, so a
// Gatekeeper stall during startup sync left it with no IPFS peers until restart,
// and an unreachable peer was reported as added without being peered (#1378).

const SELF_DID = 'did:cid:bagaaieraself';
const SELF: NodeInfo = { name: 'self', ipfs: { id: 'self-ipfs', addresses: ['/ip4/10.0.0.1/tcp/4001'] } };
const PEER_DID = 'did:cid:bagaaierapeer';
const PEER: NodeInfo = { name: 'peer', ipfs: { id: 'peer-ipfs', addresses: ['/ip4/1.2.3.4/tcp/4001'] } };

function setup(overrides: Partial<PeerDeps> = {}) {
    let now = 1_000_000;
    const failures: string[] = [];
    const resolveNode = jest.fn<PeerDeps['resolveNode']>().mockResolvedValue(PEER);
    const addPeeringPeer = jest.fn<PeerDeps['addPeeringPeer']>().mockResolvedValue(true);
    const tracker = new PeerTracker({
        resolveNode,
        addPeeringPeer,
        now: () => now,
        onFailure: (_did, reason) => failures.push(reason),
        ...overrides,
    }, SELF_DID, SELF);
    return {
        tracker,
        resolveNode,
        addPeeringPeer,
        failures,
        advance: (ms: number) => { now += ms; },
    };
}

describe('PeerTracker', () => {
    it('retries a peer whose DID resolution timed out', async () => {
        const { tracker, resolveNode, failures, advance } = setup();
        resolveNode.mockRejectedValueOnce({ error: '' });

        tracker.offer([PEER_DID]);
        await tracker.reconcile();
        expect(failures).toEqual(['DID resolution failed: {"error":""}']);
        expect(tracker.nodes()).not.toHaveProperty(PEER_DID);

        await tracker.reconcile();
        expect(resolveNode).toHaveBeenCalledTimes(1);

        advance(RETRY_BASE_MS);
        await tracker.reconcile();
        expect(resolveNode).toHaveBeenCalledTimes(2);
        expect(tracker.nodes()[PEER_DID]).toEqual(PEER);
        expect(tracker.peerName(PEER.ipfs.id)).toBe('peer');
        expect(tracker.counts()).toEqual({ pending: 0, peered: 1, retry: 0, ignored: 0 });
    });

    it('retries a peer whose DID was not yet imported', async () => {
        const { tracker, resolveNode, failures, advance } = setup();
        resolveNode.mockRejectedValueOnce(new Error('DID not found'));

        tracker.offer([PEER_DID]);
        await tracker.reconcile();
        advance(RETRY_BASE_MS);
        await tracker.reconcile();

        expect(failures).toEqual(['DID resolution failed: DID not found']);
        expect(tracker.nodes()[PEER_DID]).toEqual(PEER);
    });

    it('retries a peer whose DID document has no node info yet', async () => {
        const { tracker, resolveNode, addPeeringPeer, failures, advance } = setup();
        resolveNode.mockResolvedValueOnce(undefined);

        tracker.offer([PEER_DID]);
        await tracker.reconcile();
        expect(failures).toEqual(['no IPFS node info in DID document']);
        expect(addPeeringPeer).not.toHaveBeenCalled();

        advance(RETRY_BASE_MS);
        await tracker.reconcile();
        expect(tracker.nodes()[PEER_DID]).toEqual(PEER);
    });

    it('does not report an unreachable peer as peered, and retries it', async () => {
        const peered: string[] = [];
        const { tracker, addPeeringPeer, failures, advance } = setup({
            onPeered: did => peered.push(did),
        });
        addPeeringPeer.mockResolvedValueOnce(false);

        tracker.offer([PEER_DID]);
        await tracker.reconcile();
        expect(failures).toEqual(['no advertised IPFS address was reachable']);
        expect(peered).toEqual([]);
        expect(tracker.peerName(PEER.ipfs.id)).toBeUndefined();
        expect(tracker.counts()).toEqual({ pending: 0, peered: 0, retry: 1, ignored: 0 });
        // Still announced: other nodes may be able to reach it.
        expect(tracker.nodes()[PEER_DID]).toEqual(PEER);

        advance(RETRY_BASE_MS);
        await tracker.reconcile();
        expect(addPeeringPeer).toHaveBeenCalledTimes(2);
        expect(peered).toEqual([PEER_DID]);
        expect(tracker.counts().peered).toBe(1);
    });

    it('retries an IPFS peering error', async () => {
        const { tracker, addPeeringPeer, failures, advance } = setup();
        addPeeringPeer.mockRejectedValueOnce(new Error('connection refused'));

        tracker.offer([PEER_DID]);
        await tracker.reconcile();
        advance(RETRY_BASE_MS);
        await tracker.reconcile();

        expect(failures).toEqual(['IPFS peering failed: connection refused']);
        expect(tracker.nodes()[PEER_DID]).toEqual(PEER);
    });

    it('doubles the retry delay up to a ceiling', async () => {
        const delays: number[] = [];
        const { tracker, resolveNode, advance } = setup({
            onFailure: (_did, _reason, retryInMs) => delays.push(retryInMs),
        });
        resolveNode.mockRejectedValue(new Error('unavailable'));

        tracker.offer([PEER_DID]);
        for (let attempt = 0; attempt < 8; attempt++) {
            await tracker.reconcile();
            advance(delays[delays.length - 1]);
        }

        expect(delays).toEqual([1, 2, 4, 8, 16, 30, 30, 30].map(minutes => minutes * 60 * 1000));
        expect(RETRY_MAX_MS).toBe(30 * 60 * 1000);
    });

    it('does not retry a peered node', async () => {
        const { tracker, resolveNode, advance } = setup();

        tracker.offer([PEER_DID]);
        await tracker.reconcile();
        advance(RETRY_MAX_MS);
        tracker.offer([PEER_DID]);
        await tracker.reconcile();

        expect(resolveNode).toHaveBeenCalledTimes(1);
    });

    it('shares one pass between pings that arrive while it runs', async () => {
        let finish!: (node: NodeInfo) => void;
        const { tracker, resolveNode } = setup();
        resolveNode.mockReturnValueOnce(new Promise<NodeInfo>(resolve => { finish = resolve; }));

        tracker.offer([PEER_DID]);
        const first = tracker.reconcile();
        tracker.offer([PEER_DID]);
        const second = tracker.reconcile();
        finish(PEER);
        await Promise.all([first, second]);

        expect(resolveNode).toHaveBeenCalledTimes(1);
        expect(tracker.nodes()[PEER_DID]).toEqual(PEER);
    });

    it('treats DID aliases with the same suffix as one peer', async () => {
        const { tracker, resolveNode } = setup();

        tracker.offer([PEER_DID, 'did:test:bagaaierapeer']);
        await tracker.reconcile();

        expect(resolveNode).toHaveBeenCalledTimes(1);
        expect(tracker.counts().peered).toBe(1);
    });

    it('skips its own DID and ignores another DID for its own IPFS node', async () => {
        const peered: string[] = [];
        const { tracker, resolveNode, addPeeringPeer, advance } = setup({
            onPeered: did => peered.push(did),
        });
        const alias = 'did:cid:bagaaieraother';
        resolveNode.mockResolvedValue({ name: 'alias', ipfs: SELF.ipfs });

        tracker.offer([SELF_DID, alias]);
        await tracker.reconcile();
        advance(RETRY_MAX_MS);
        await tracker.reconcile();

        expect(resolveNode).toHaveBeenCalledTimes(1);
        expect(resolveNode).toHaveBeenCalledWith(alias);
        expect(addPeeringPeer).not.toHaveBeenCalled();
        expect(peered).toEqual([]);
        expect(tracker.nodes()).toEqual({ [SELF_DID]: SELF });
        expect(tracker.ipfsPeerCount()).toBe(0);
        expect(tracker.counts()).toEqual({ pending: 0, peered: 0, retry: 0, ignored: 1 });
    });
});

describe('describeError', () => {
    it('keeps the message an empty client error would hide', () => {
        expect(describeError(new Error('timeout'))).toBe('timeout');
        expect(describeError({ error: 'Gatekeeper unavailable' })).toBe('Gatekeeper unavailable');
        expect(describeError({ error: '' })).toBe('{"error":""}');
        expect(describeError('')).toBe('empty error');
    });

    it('describes an error object that cannot be serialized', () => {
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        expect(describeError(circular)).toBe('[object Object]');
        expect(describeError({ size: 1n })).toBe('[object Object]');
    });

    it('still schedules a retry when the failure cannot be serialized', async () => {
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        const { tracker, resolveNode, failures } = setup();
        resolveNode.mockRejectedValueOnce(circular);

        tracker.offer([PEER_DID]);
        await expect(tracker.reconcile()).resolves.toBeUndefined();
        expect(failures).toEqual(['DID resolution failed: [object Object]']);
        expect(tracker.counts().retry).toBe(1);
    });
});
