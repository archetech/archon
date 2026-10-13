export interface NodeInfo {
    name: string;
    ipfs: {
        id: string;
        addresses: string[];
    };
}

export interface PeerDeps {
    // The `node` entry a peer published in its DID document data.
    resolveNode(did: string): Promise<Partial<NodeInfo> | undefined>;
    // Resolves true only when the peer was written to the IPFS peering list.
    addPeeringPeer(id: string, addresses: string[]): Promise<boolean>;
    now?: () => number;
    onFailure?: (did: string, reason: string, retryInMs: number) => void;
    onPeered?: (did: string, node: NodeInfo) => void;
}

// `ignored` is terminal: the DID resolved to this node's own IPFS node.
export type PeerStatus = 'pending' | 'peered' | 'retry' | 'ignored';

interface PeerState {
    did: string;
    status: PeerStatus;
    attempts: number;
    nextAttempt: number;
    reason?: string;
}

export const RETRY_BASE_MS = 60 * 1000;
export const RETRY_MAX_MS = 30 * 60 * 1000;

// DID aliases share a suffix, so peers are tracked by suffix.
function suffixOf(did: string): string {
    return did.split(':').pop() || '';
}

export function describeError(error: unknown): string {
    if (error instanceof Error) {
        return error.message || error.name;
    }
    if (typeof error === 'string') {
        return error || 'empty error';
    }
    if (error && typeof error === 'object') {
        const message = (error as { error?: unknown }).error;
        if (typeof message === 'string' && message) {
            return message;
        }
        try {
            return JSON.stringify(error);
        }
        catch {
            // Circular or BigInt-bearing objects cannot be serialized.
            return Object.prototype.toString.call(error);
        }
    }
    return String(error);
}

// Tracks the IPFS peering state of each node DID announced over Hyperswarm.
// A failed attempt (resolution error, missing node info, nothing dialable) is
// retried with exponential backoff rather than abandoned, because each of
// those can be transient: Gatekeeper may be busy, the DID may not be imported
// yet, or the peer may be briefly unreachable.
export class PeerTracker {
    private readonly peers = new Map<string, PeerState>();
    private readonly resolved = new Map<string, NodeInfo>();
    private readonly peerNames = new Map<string, string>();
    private reconciling?: Promise<void>;
    private readonly now: () => number;
    private readonly selfSuffix: string;

    constructor(
        private readonly deps: PeerDeps,
        private readonly selfDid: string,
        private readonly self: NodeInfo,
    ) {
        this.now = deps.now ?? Date.now;
        this.selfSuffix = suffixOf(selfDid);
    }

    // Registers announced DIDs. Already-known DIDs keep their state.
    offer(dids: string[]): void {
        for (const did of dids) {
            const suffix = suffixOf(did);
            if (!suffix || suffix === this.selfSuffix || this.peers.has(suffix)) {
                continue;
            }
            this.peers.set(suffix, { did, status: 'pending', attempts: 0, nextAttempt: this.now() });
        }
    }

    // Attempts every due peer, one at a time. Callers share a running pass.
    reconcile(): Promise<void> {
        if (!this.reconciling) {
            this.reconciling = this.reconcileDue().finally(() => {
                this.reconciling = undefined;
            });
        }
        return this.reconciling;
    }

    // This node plus every DID that resolved to another node's IPFS info,
    // keyed by DID, as relayed in pings. A node this one cannot dial is still
    // announced: other nodes may be able to reach it.
    nodes(): Record<string, NodeInfo> {
        return { [this.selfDid]: this.self, ...Object.fromEntries(this.resolved) };
    }

    peerName(ipfsId: string): string | undefined {
        return this.peerNames.get(ipfsId);
    }

    // Distinct IPFS peer IDs of peered nodes.
    ipfsPeerCount(): number {
        return this.peerNames.size;
    }

    counts(): Record<PeerStatus, number> {
        const counts: Record<PeerStatus, number> = { pending: 0, peered: 0, retry: 0, ignored: 0 };
        for (const peer of this.peers.values()) {
            counts[peer.status] += 1;
        }
        return counts;
    }

    private async reconcileDue(): Promise<void> {
        let peer: PeerState | undefined;
        while ((peer = this.nextDue())) {
            await this.attempt(peer);
        }
    }

    private nextDue(): PeerState | undefined {
        const now = this.now();
        for (const peer of this.peers.values()) {
            if ((peer.status === 'pending' || peer.status === 'retry') && peer.nextAttempt <= now) {
                return peer;
            }
        }
        return undefined;
    }

    private async attempt(peer: PeerState): Promise<void> {
        peer.attempts += 1;

        let node: Partial<NodeInfo> | undefined;
        try {
            node = await this.deps.resolveNode(peer.did);
        }
        catch (error) {
            this.fail(peer, `DID resolution failed: ${describeError(error)}`);
            return;
        }

        const id = node?.ipfs?.id;
        const addresses = node?.ipfs?.addresses;
        if (!id || !Array.isArray(addresses) || addresses.length === 0) {
            this.fail(peer, 'no IPFS node info in DID document');
            return;
        }

        if (id === this.self.ipfs.id) {
            // Another DID for this node; there is nothing to peer with.
            peer.status = 'ignored';
            peer.reason = 'resolves to this node';
            return;
        }

        const info: NodeInfo = { name: node?.name ?? '', ipfs: { id, addresses } };
        this.resolved.set(peer.did, info);

        try {
            if (!await this.deps.addPeeringPeer(id, addresses)) {
                this.fail(peer, 'no advertised IPFS address was reachable');
                return;
            }
        }
        catch (error) {
            this.fail(peer, `IPFS peering failed: ${describeError(error)}`);
            return;
        }

        peer.status = 'peered';
        peer.reason = undefined;
        this.peerNames.set(id, info.name);
        this.deps.onPeered?.(peer.did, info);
    }

    private fail(peer: PeerState, reason: string): void {
        const retryInMs = Math.min(RETRY_BASE_MS * 2 ** (peer.attempts - 1), RETRY_MAX_MS);
        peer.status = 'retry';
        peer.reason = reason;
        peer.nextAttempt = this.now() + retryInMs;
        this.deps.onFailure?.(peer.did, reason, retryInMs);
    }
}
