export interface SwarmKeyPair {
    publicKey: Buffer;
    secretKey?: Buffer;
}

/** As much of a Hyperswarm as joining a topic needs. */
export interface Swarm<Connection> {
    keyPair: SwarmKeyPair;
    on(event: 'connection', listener: (conn: Connection) => void): void;
    join(topic: Buffer, opts: { client: boolean; server: boolean }): { flushed(): Promise<void> };
    destroy(): Promise<void>;
}

export interface TopicSwarmDeps<Connection> {
    /** Makes a swarm. Given a key pair, the swarm is the peer that key pair names. */
    create(keyPair?: SwarmKeyPair): Swarm<Connection>;
    topic: Buffer;
    onConnection(conn: Connection): void;
}

/**
 * The node's membership of its Hyperswarm topic.
 *
 * Joining again makes a new swarm, and a swarm left to choose its own key pair
 * is a new peer each time. A node that starts before any other is on the topic
 * rejoins at least once, so without the key pair being kept its peers would know
 * it under one key and then another (#1636).
 *
 * A node that had peers and lost them all is another matter. A peer running a
 * mediator that does not listen for connection errors keeps a failed connection
 * for good, and never hears a node that connects again under the key that
 * connection had. Such a node has to come back as a new peer to be heard.
 */
export class TopicSwarm<Connection> {
    private swarm: Swarm<Connection> | null = null;
    private keyPair: SwarmKeyPair | undefined;

    constructor(private readonly deps: TopicSwarmDeps<Connection>) {}

    /**
     * Joins the topic, leaving it first if already joined. Returns the node's
     * public key, which is the one it had unless it joins as a new peer.
     */
    async join(options: { asNewPeer?: boolean } = {}): Promise<Buffer> {
        // The old swarm is the same peer as the new one, so it has to be gone first.
        await this.destroy();

        if (options.asNewPeer) {
            this.keyPair = undefined;
        }

        const swarm = this.deps.create(this.keyPair);
        this.keyPair = swarm.keyPair;
        this.swarm = swarm;

        swarm.on('connection', conn => this.deps.onConnection(conn));
        await swarm.join(this.deps.topic, { client: true, server: true }).flushed();

        return swarm.keyPair.publicKey;
    }

    async destroy(): Promise<void> {
        const swarm = this.swarm;
        this.swarm = null;
        await swarm?.destroy();
    }
}
