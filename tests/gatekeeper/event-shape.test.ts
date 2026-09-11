import Gatekeeper from '@didcid/gatekeeper';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory.ts';
import MemoryClient from '@didcid/ipfs/memory';
import proofVectors from './proof-vectors.json' with { type: 'json' };
import fixture from './event-shape-vectors.json' with { type: 'json' };

interface ShapeVector {
    base: string;
    name: string;
    path: string[];
    value?: unknown;
    delete?: boolean;
    valid: boolean;
    note?: string;
}

const vectors = fixture.vectors as ShapeVector[];
const bases = fixture.bases as Record<string, string>;
const operations = proofVectors as unknown as Record<string, { operation: unknown }>;

const gatekeeper = new Gatekeeper({
    db: new DbJsonMemory('test'),
    ipfs: new MemoryClient(),
    registries: ['local', 'hyperswarm'],
});

function mutate(vector: ShapeVector): unknown {
    const event: Record<string, unknown> = {
        ...fixture.event,
        operation: JSON.parse(JSON.stringify(operations[bases[vector.base]].operation)),
    };

    if (vector.path.length === 0) {
        return event;
    }

    let node = event;

    for (const key of vector.path.slice(0, -1)) {
        node = node[key] as Record<string, unknown>;
    }

    const last = vector.path[vector.path.length - 1];

    if (vector.delete) {
        delete node[last];
    }
    else {
        node[last] = vector.value;
    }

    return event;
}

// The Rust port checks the same file, so a change here has to be made in both
// ports or one of the two suites fails.
describe('verifyEvent shapes', () => {

    it.each(vectors.map(vector => [`${vector.base}: ${vector.name}`, vector] as const))(
        '%s',
        async (_name, vector) => {
            expect(await gatekeeper.verifyEvent(mutate(vector) as never)).toBe(vector.valid);
        }
    );
});
