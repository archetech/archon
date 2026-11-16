import { Swarm, SwarmKeyPair, TopicSwarm } from '../../services/mediators/hyperswarm/src/swarm.ts';

// The mediator made a new swarm, with a new key pair, each time it rejoined its
// topic, so a node came back as a peer the others had never seen (#1636).

const TOPIC = Buffer.from('topic');

interface Connection {
    remotePublicKey: Buffer;
}

function setup() {
    const log: string[] = [];
    const swarms: FakeSwarm[] = [];
    let made = 0;

    class FakeSwarm implements Swarm<Connection> {
        keyPair: SwarmKeyPair;
        listener?: (conn: Connection) => void;
        destroyed = false;

        constructor(keyPair?: SwarmKeyPair) {
            made += 1;
            // Left to itself a swarm chooses a key pair nobody has seen before.
            this.keyPair = keyPair ?? { publicKey: Buffer.from(`key-${made}`) };
            log.push(`create ${this.keyPair.publicKey}`);
            swarms.push(this);
        }

        on(_event: 'connection', listener: (conn: Connection) => void) {
            this.listener = listener;
        }

        join(topic: Buffer, opts: { client: boolean; server: boolean }) {
            log.push(`join ${topic} client=${opts.client} server=${opts.server}`);
            return { flushed: async () => { log.push('flushed'); } };
        }

        async destroy() {
            await Promise.resolve();
            this.destroyed = true;
            log.push(`destroyed ${this.keyPair.publicKey}`);
        }
    }

    const connections: Connection[] = [];
    const swarm = new TopicSwarm<Connection>({
        create: keyPair => new FakeSwarm(keyPair),
        topic: TOPIC,
        onConnection: conn => connections.push(conn),
    });
    return { swarm, swarms, log, connections };
}

describe('TopicSwarm', () => {
    it('joins the topic as a client and a server and reports its public key', async () => {
        const { swarm, log } = setup();

        expect((await swarm.join()).toString()).toBe('key-1');
        expect(log).toEqual(['create key-1', 'join topic client=true server=true', 'flushed']);
    });

    it('is the same peer after joining again', async () => {
        const { swarm, swarms } = setup();

        const first = await swarm.join();
        const second = await swarm.join();
        const third = await swarm.join();

        expect(second).toEqual(first);
        expect(third).toEqual(first);
        expect(swarms).toHaveLength(3);
        expect(swarms.map(made => made.keyPair)).toEqual([swarms[0].keyPair, swarms[0].keyPair, swarms[0].keyPair]);
    });

    it('waits for the old swarm to go before making the new one', async () => {
        const { swarm, log } = setup();

        await swarm.join();
        log.length = 0;
        await swarm.join();

        expect(log).toEqual(['destroyed key-1', 'create key-1', 'join topic client=true server=true', 'flushed']);
    });

    it('passes on connections from the current swarm', async () => {
        const { swarm, swarms, connections } = setup();
        const conn = { remotePublicKey: Buffer.from('peer') };

        await swarm.join();
        await swarm.join();
        swarms[1].listener?.(conn);

        expect(connections).toEqual([conn]);
    });

    it('destroys the swarm once, and not at all before joining', async () => {
        const { swarm, swarms } = setup();

        await swarm.destroy();
        expect(swarms).toHaveLength(0);

        await swarm.join();
        await swarm.destroy();
        await swarm.destroy();

        expect(swarms[0].destroyed).toBe(true);
        expect(swarms).toHaveLength(1);
    });
});
