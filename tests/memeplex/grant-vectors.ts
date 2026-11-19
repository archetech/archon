import CipherNode from '@didcid/cipher/node';
import Gatekeeper from '@didcid/gatekeeper';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory.ts';
import MemoryClient from '@didcid/ipfs/memory';
import { generateCID } from '@didcid/ipfs/utils';
import type { EcdsaJwkPair } from '@didcid/cipher/types';
import type { AcceptedEvent, Authority, Grant, Kind } from '@didcid/memeplex';

// Builds tests/fixtures/memeplex-v1-grant-vectors.json: grant histories as a
// Gatekeeper exports them, each with the grant a verifier should read from it and
// the authority it should find at a set of chain positions.
//
// Every history is signed with fixed keys, imported into a Gatekeeper with its
// chain receipts, and exported again. What is recorded is the export, so the
// evidence is of the shape and content a verifier is handed.

const cipher = new CipherNode();
const REGISTRY = 'BTC:mainnet';
const AGENT_TIME = '2026-11-01T00:00:00.000Z';

export interface Probe {
    block: number;
    time: string;
    kind?: Kind;
    expect: Authority;
}

export interface GrantCase {
    name: string;
    did: string;
    history: AcceptedEvent[];
    expect: Grant;
    probes: Probe[];
}

interface Signer {
    did: string;
    keypair: EcdsaJwkPair;
    operation: Record<string, unknown>;
}

function prove(operation: Record<string, unknown>, keypair: EcdsaJwkPair, verificationMethod: string, created: string) {
    const config = {
        type: 'DataIntegrityProof',
        cryptosuite: 'archon-ecdsa-secp256k1-jcs-2026',
        created,
        verificationMethod,
        proofPurpose: 'capabilityInvocation',
    };
    const payload = Buffer.from(cipher.hashJSON(config) + cipher.hashJSON(operation), 'hex');
    const signature = cipher.signHash(cipher.hashMessage(payload), keypair.privateJwk);
    return { ...operation, proof: { ...config, proofValue: Buffer.from(signature, 'hex').toString('base64url') } };
}

const cid = (operation: unknown) => generateCID(operation, { canonical: true } as never);

async function agent(key: number): Promise<Signer> {
    const keypair = cipher.generateJwk(new Uint8Array(32).fill(key));
    const operation = prove({
        type: 'create',
        created: AGENT_TIME,
        registration: { version: 1, type: 'agent', registry: 'hyperswarm' },
        publicJwk: keypair.publicJwk,
    }, keypair, '#key-1', AGENT_TIME);
    return { keypair, operation, did: `did:cid:${await cid(operation)}` };
}

// The time of a block: one a minute from a fixed start.
export const blockTime = (block: number) => new Date(Date.UTC(2026, 10, 2, 0, block)).toISOString();

// One step of a history: an operation and the block that anchors it, or no block
// when it has not been anchored.
interface Step {
    operation: Record<string, unknown>;
    block?: number;
    registry?: string;
}

async function exported(agents: Signer[], steps: Step[]): Promise<{ did: string; history: AcceptedEvent[] }> {
    const registries = [...new Set(['hyperswarm', REGISTRY, 'ZEC:mainnet', ...steps.map(step => step.registry ?? REGISTRY)])];
    const gatekeeper = new Gatekeeper({
        db: new DbJsonMemory('grants'), ipfs: new MemoryClient(), registries, maxQueueSize: 10_000,
        console: { log: () => undefined, error: () => undefined, time: () => undefined, timeEnd: () => undefined } as never,
    });
    const events: Record<string, unknown>[] = agents.map(signer => ({
        registry: 'hyperswarm', time: AGENT_TIME, operation: signer.operation,
    }));

    for (const [index, { operation, block, registry = REGISTRY }] of steps.entries()) {
        const created = (operation.proof as { created: string }).created;
        events.push(block === undefined
            ? { registry: 'hyperswarm', time: created, operation }
            : {
                registry,
                time: blockTime(block),
                ordinal: [block, 0, index],
                registration: { height: block, index: 0, txid: `tx-${block}`, batch: `did:cid:batch-${block}`, opidx: index },
                operation,
            });
    }

    await gatekeeper.importBatch(events as never);
    await gatekeeper.processEvents();

    const did = `did:cid:${await cid(steps[0].operation)}`;
    const history = await gatekeeper.exportDID(did);
    if (history.length !== steps.length) {
        throw new Error(`the Gatekeeper accepted ${history.length} of ${steps.length} operations of ${did}`);
    }
    return { did, history: JSON.parse(JSON.stringify(history)) };
}

export async function build(): Promise<{ description: string; registry: string; cases: GrantCase[] }> {
    const user = await agent(0x21);
    const client = await agent(0x22);
    const other = await agent(0x23);
    const agents = [user, client, other];
    const nonce = Buffer.from(new Uint8Array(18).fill(7)).toString('base64url');
    const cases: GrantCase[] = [];

    // A proof time just before the block that anchors the operation.
    const signedAt = (block?: number) => blockTime((block ?? 500) - 1);
    const create = (data: Record<string, unknown>, by: Signer = user, registration: Record<string, unknown> = {}, block?: number) => prove({
        type: 'create',
        created: signedAt(block),
        registration: { version: 1, type: 'asset', registry: REGISTRY, ...registration },
        controller: by.did,
        data,
    }, by.keypair, `${by.did}#key-1`, signedAt(block));
    const update = async (previous: Record<string, unknown>, doc: Record<string, unknown>, block?: number, by: Signer = user) => prove({
        type: 'update', did: `did:cid:${await cid(await root(previous))}`, previd: await cid(previous), doc,
    }, by.keypair, `${by.did}#key-1`, signedAt(block));
    const revoke = async (previous: Record<string, unknown>, block?: number, by: Signer = user) => prove({
        type: 'delete', did: `did:cid:${await cid(await root(previous))}`, previd: await cid(previous),
    }, by.keypair, `${by.did}#key-1`, signedAt(block));

    // The creation an operation descends from. Operations are linked by previd, so
    // the builder keeps each one's root as it makes it.
    const roots = new Map<Record<string, unknown>, Record<string, unknown>>();
    async function root(operation: Record<string, unknown>): Promise<Record<string, unknown>> {
        return roots.get(operation) ?? operation;
    }
    const chain = async (first: Record<string, unknown>, ...make: ((previous: Record<string, unknown>) => Promise<Record<string, unknown>>)[]) => {
        const operations = [first];
        for (const next of make) {
            const operation = await next(operations.at(-1)!);
            roots.set(operation, first);
            operations.push(operation);
        }
        return operations;
    };

    const grant = { v: 1, client: client.did, nonce };
    const add = async (name: string, steps: Step[], expect: Grant, probes: Probe[] = []) => {
        const { did, history } = await exported(agents, steps);
        cases.push({ name, did, history, expect, probes });
    };
    const at = (block: number, expect: Authority, kind?: Kind): Probe => ({ block, time: blockTime(block), ...(kind ? { kind } : {}), expect });
    const valid = (versions: { block: number; actions?: string[]; expiresAt?: string }[], rest: { ended?: number; pending?: number } = {}): Grant => ({
        status: 'valid',
        user: user.did,
        client: client.did,
        registry: REGISTRY,
        versions: versions.map(({ block, ...scope }) => ({ position: { block, time: blockTime(block) }, ...scope })),
        ...(rest.ended === undefined ? {} : { ended: { block: rest.ended, time: blockTime(rest.ended) } }),
        pending: rest.pending ?? 0,
    });

    // A grant, live.
    {
        const [made] = await chain(create({ memeplexGrant: grant }, user, {}, 100));
        await add('every core kind, live', [{ operation: made, block: 100 }], valid([{ block: 100 }]), [
            at(99, 'before-grant'), at(100, 'before-grant'), at(101, 'permitted'), at(101, 'permitted', 'post'),
            at(5000, 'permitted', 'rating'),
        ]);
    }
    // Not anchored yet.
    {
        const [made] = await chain(create({ memeplexGrant: { ...grant, nonce: `${nonce}a` } }));
        await add('creation not anchored', [{ operation: made }],
            { status: 'pending', user: user.did, client: client.did, registry: REGISTRY });
    }
    // Revoked.
    {
        const [made, gone] = await chain(create({ memeplexGrant: { ...grant, nonce: `${nonce}b` } }, user, {}, 100),
            previous => revoke(previous, 200));
        await add('revoked', [{ operation: made, block: 100 }, { operation: gone, block: 200 }],
            valid([{ block: 100 }], { ended: 200 }),
            [at(150, 'permitted'), at(199, 'permitted'), at(200, 'after-end'), at(201, 'after-end')]);
    }
    // A revocation that is not anchored has no effect yet.
    {
        const [made, gone] = await chain(create({ memeplexGrant: { ...grant, nonce: `${nonce}c` } }, user, {}, 100),
            previous => revoke(previous));
        await add('revocation not anchored', [{ operation: made, block: 100 }, { operation: gone }],
            valid([{ block: 100 }], { pending: 1 }), [at(150, 'permitted'), at(9000, 'permitted')]);
    }
    // Scope narrowed, then widened again.
    {
        const scoped = { ...grant, nonce: `${nonce}d` };
        const [made, narrowed, widened] = await chain(create({ memeplexGrant: scoped }, user, {}, 100),
            previous => update(previous, { didDocumentData: { memeplexGrant: { ...scoped, actions: ['memeplex:tag'] } } }, 200),
            previous => update(previous, { didDocumentData: { memeplexGrant: scoped } }, 300));
        await add('scope narrowed and widened',
            [{ operation: made, block: 100 }, { operation: narrowed, block: 200 }, { operation: widened, block: 300 }],
            valid([{ block: 100 }, { block: 200, actions: ['memeplex:tag'] }, { block: 300 }]),
            [
                at(150, 'permitted', 'post'), at(200, 'unordered', 'tag'), at(250, 'scope', 'post'), at(250, 'scope', 'paper'),
                at(250, 'scope', 'reply'), at(250, 'scope', 'rating'), at(250, 'permitted', 'tag'),
                // An edit or deletion needs the interval alone.
                at(250, 'permitted'), at(300, 'unordered'), at(350, 'permitted', 'post'),
            ]);
    }
    // Expiry, set at creation and then extended.
    {
        const expiring = { ...grant, nonce: `${nonce}e`, expiresAt: blockTime(200) };
        const [made, extended] = await chain(create({ memeplexGrant: expiring }, user, {}, 100),
            previous => update(previous, { didDocumentData: { memeplexGrant: { ...expiring, expiresAt: blockTime(400) } } }, 150));
        await add('expiry extended',
            [{ operation: made, block: 100 }, { operation: extended, block: 150 }],
            valid([{ block: 100, expiresAt: blockTime(200) }, { block: 150, expiresAt: blockTime(400) }]),
            [at(120, 'permitted'), at(199, 'permitted'), at(200, 'permitted'), at(399, 'permitted'), at(400, 'expired'), at(401, 'expired')]);
    }
    {
        const expiring = { ...grant, nonce: `${nonce}f`, expiresAt: blockTime(200) };
        const [made] = await chain(create({ memeplexGrant: expiring }, user, {}, 100));
        await add('expired', [{ operation: made, block: 100 }], valid([{ block: 100, expiresAt: blockTime(200) }]),
            [at(199, 'permitted'), at(200, 'expired'), at(201, 'expired'), { block: 150, time: blockTime(300), expect: 'expired' }]);
    }
    // Anything but a scope update ends the grant.
    {
        const base = { ...grant, nonce: `${nonce}g` };
        const [made, changed] = await chain(create({ memeplexGrant: base }, user, {}, 100),
            previous => update(previous, { didDocumentData: { memeplexGrant: { ...base, client: other.did } } }, 200));
        await add('client changed', [{ operation: made, block: 100 }, { operation: changed, block: 200 }],
            valid([{ block: 100 }], { ended: 200 }), [at(199, 'permitted'), at(200, 'after-end')]);
    }
    {
        const base = { ...grant, nonce: `${nonce}h` };
        const [made, changed] = await chain(create({ memeplexGrant: base }, user, {}, 100),
            previous => update(previous, { didDocumentData: { memeplexGrant: base, note: 'added' } }, 200));
        await add('other data added', [{ operation: made, block: 100 }, { operation: changed, block: 200 }],
            valid([{ block: 100 }], { ended: 200 }));
    }
    {
        const base = { ...grant, nonce: `${nonce}i` };
        const [made, changed] = await chain(create({ memeplexGrant: base }, user, {}, 100),
            previous => update(previous, { didDocumentData: { memeplexGrant: { ...base, actions: [] } } }, 200));
        await add('scope update that is not a valid grant', [{ operation: made, block: 100 }, { operation: changed, block: 200 }],
            valid([{ block: 100 }], { ended: 200 }));
    }
    {
        const base = { ...grant, nonce: `${nonce}j` };
        const [made, changed] = await chain(create({ memeplexGrant: base }, user, {}, 100),
            previous => update(previous, { didDocumentData: {} }, 200));
        await add('grant removed from its data', [{ operation: made, block: 100 }, { operation: changed, block: 200 }],
            valid([{ block: 100 }], { ended: 200 }));
    }
    // A scope update ends nothing, and one after the end is not read.
    {
        const base = { ...grant, nonce: `${nonce}k` };
        const [made, gone, late] = await chain(create({ memeplexGrant: base }, user, {}, 100),
            previous => update(previous, { didDocumentData: { memeplexGrant: { ...base, client: other.did } } }, 200),
            previous => update(previous, { didDocumentData: { memeplexGrant: base } }, 300));
        await add('restored after it ended',
            [{ operation: made, block: 100 }, { operation: gone, block: 200 }, { operation: late, block: 300 }],
            valid([{ block: 100 }], { ended: 200 }), [at(350, 'after-end')]);
    }
    // An update as a Keymaster writes it, with every component, is a scope update
    // when only the scope differs.
    {
        const base = { ...grant, nonce: `${nonce}n` };
        const made = create({ memeplexGrant: base }, user, {}, 100);
        const did = `did:cid:${await cid(made)}`;
        const whole = (data: Record<string, unknown>, document: Record<string, unknown> = {}) => ({
            didDocument: { '@context': ['https://www.w3.org/ns/did/v1'], id: did, controller: user.did, ...document },
            didDocumentData: data,
            didDocumentRegistration: { version: 1, type: 'asset', registry: REGISTRY },
        });
        const [, rescoped, again] = await chain(made,
            previous => update(previous, whole({ memeplexGrant: { ...base, actions: ['memeplex:rate'] } }), 200),
            previous => update(previous, whole({ memeplexGrant: { ...base, actions: ['memeplex:rate'] } }, { service: [] }), 300));
        await add('whole-document scope update, then a document change',
            [{ operation: made, block: 100 }, { operation: rescoped, block: 200 }, { operation: again, block: 300 }],
            valid([{ block: 100 }, { block: 200, actions: ['memeplex:rate'] }], { ended: 300 }),
            [at(250, 'permitted', 'rating'), at(250, 'scope', 'tag'), at(300, 'after-end')]);
    }
    // A transfer ends the grant, to the client included.
    {
        const base = { ...grant, nonce: `${nonce}o` };
        const made = create({ memeplexGrant: base }, user, {}, 100);
        const did = `did:cid:${await cid(made)}`;
        const [, moved] = await chain(made, previous => update(previous, {
            didDocument: { '@context': ['https://www.w3.org/ns/did/v1'], id: did, controller: other.did },
        }, 200));
        await add('transferred', [{ operation: made, block: 100 }, { operation: moved, block: 200 }],
            valid([{ block: 100 }], { ended: 200 }), [at(199, 'permitted'), at(201, 'after-end')]);
    }
    // So does a change of registry.
    {
        const base = { ...grant, nonce: `${nonce}p` };
        const [made, moved] = await chain(create({ memeplexGrant: base }, user, {}, 100),
            previous => update(previous, { didDocumentRegistration: { version: 1, type: 'asset', registry: 'ZEC:mainnet' } }, 200));
        await add('registry changed', [{ operation: made, block: 100 }, { operation: moved, block: 200 }],
            valid([{ block: 100 }], { ended: 200 }), [at(199, 'permitted'), at(200, 'after-end')]);
    }
    // A scope update that is not anchored changes nothing yet.
    {
        const base = { ...grant, nonce: `${nonce}q` };
        const [made, narrowed] = await chain(create({ memeplexGrant: base }, user, {}, 100),
            previous => update(previous, { didDocumentData: { memeplexGrant: { ...base, actions: ['memeplex:tag'] } } }));
        await add('scope update not anchored', [{ operation: made, block: 100 }, { operation: narrowed }],
            valid([{ block: 100 }], { pending: 1 }), [at(9000, 'permitted', 'post')]);
    }
    // Created by someone else and handed to the user: the grant is the creator's.
    {
        const made = create({ memeplexGrant: { ...grant, nonce: `${nonce}r` } }, other, {}, 100);
        const did = `did:cid:${await cid(made)}`;
        const [, moved] = await chain(made, previous => update(previous, {
            didDocument: { '@context': ['https://www.w3.org/ns/did/v1'], id: did, controller: user.did },
        }, 200, other));
        await add('created by another and transferred to the user', [{ operation: made, block: 100 }, { operation: moved, block: 200 }],
            { ...valid([{ block: 100 }], { ended: 200 }), user: other.did } as Grant, [at(250, 'after-end')]);
    }
    // Void from creation.
    {
        const [made] = await chain(create({ memeplexGrant: { ...grant, client: user.did } }, user, {}, 100));
        await add('names its own creator as client', [{ operation: made, block: 100 }], { status: 'void', reason: 'client-is-user' });
    }
    {
        const [made] = await chain(create({ memeplexGrant: { ...grant, nonce: `${nonce}l` } }, user, { validUntil: '2099-01-01T00:00:00Z' }, 100));
        await add('created with validUntil', [{ operation: made, block: 100 }], { status: 'void', reason: 'expires-by-registration' });
    }
    {
        const [made] = await chain(create({ memeplexGrant: { ...grant, nonce: `${nonce}m` } }, user, { registry: 'BTC:signet' }, 100));
        await add('on a testnet', [{ operation: made, block: 100, registry: 'BTC:signet' }], { status: 'void', reason: 'registry' });
    }
    {
        const [made] = await chain(create({ memeplexGrant: { ...grant, actions: [] } }, user, {}, 100));
        await add('creation data is not a valid grant', [{ operation: made, block: 100 }], { status: 'void', reason: 'invalid' });
    }
    {
        const [made] = await chain(create({ note: 'no grant here' }, user, {}, 100));
        await add('an asset that is not a grant', [{ operation: made, block: 100 }], { status: 'void', reason: 'not-a-grant' });
    }
    {
        const [made] = await chain(create({ memeplexGrant: { ...grant, v: 2 } }, user, {}, 100));
        await add('a later v', [{ operation: made, block: 100 }], { status: 'unsupported' });
    }

    return {
        description: 'Memeplex v1 grant histories as a Gatekeeper exports them, with the grant read from each '
            + 'and its authority at chain positions. Written by tests/memeplex/grant-vectors.ts.',
        registry: REGISTRY,
        cases,
    };
}
