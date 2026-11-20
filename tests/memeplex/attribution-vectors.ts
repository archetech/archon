import type { AcceptedEvent, Publication } from '@didcid/memeplex';
import { agent, blockTime, cid, exported, prove } from './grant-vectors.ts';
import type { Signer, Step } from './grant-vectors.ts';

// Builds tests/fixtures/memeplex-v1-attribution-vectors.json: an object's history
// and its grant's, both as a Gatekeeper exports them, with the publication a
// verifier should derive from the pair.
//
// As in grant-vectors.ts, every history is signed with fixed keys, imported into a
// Gatekeeper with its chain receipts, and exported again.

const REGISTRY = 'BTC:mainnet';

// What a case expects of each version: its outcome and, when it is not attributed,
// why. The operation's identity and position are in the history.
export type Expected = { outcome: string; reason?: string; validity?: string; grant?: string; authority?: string };

export interface AttributionCase {
    name: string;
    object: AcceptedEvent[];
    grant: AcceptedEvent[];
    expect: {
        state: Publication['state'];
        current?: number;
        versions: Expected[];
        // The object the publication shows.
        memeplex?: Record<string, unknown>;
    };
}

type Operation = Record<string, unknown>;

// An asset's history under construction: its operations and the block of each.
class History {
    steps: Step[] = [];
    did = '';

    static async create(by: Signer, data: Operation, block?: number, registration: Operation = {}, signedAt?: number) {
        const history = new History();
        const time = blockTime((signedAt ?? block ?? 5000) - 1);
        const operation = prove({
            type: 'create',
            created: time,
            registration: { version: 1, type: 'asset', registry: REGISTRY, ...registration },
            controller: by.did,
            data,
        }, by.keypair, `${by.did}#key-1`, time);

        history.did = `did:cid:${await cid(operation)}`;
        history.steps.push({ operation, block, registry: (registration.registry as string) ?? REGISTRY });
        return history;
    }

    private async add(by: Signer, body: Operation, block?: number, signedAt?: number) {
        const time = blockTime((signedAt ?? block ?? 5000) - 1);
        const operation = prove({ ...body, did: this.did, previd: await cid(this.steps.at(-1)!.operation) },
            by.keypair, `${by.did}#key-1`, time);

        this.steps.push({ operation, block, registry: this.steps[0].registry });
        return this;
    }

    update(by: Signer, doc: Operation, block?: number, signedAt?: number) {
        return this.add(by, { type: 'update', doc }, block, signedAt);
    }

    delete(by: Signer, block?: number) {
        return this.add(by, { type: 'delete' }, block);
    }

    document(controller: Signer, more: Operation = {}) {
        return { '@context': ['https://www.w3.org/ns/did/v1'], id: this.did, controller: controller.did, ...more };
    }
}

export async function build(): Promise<{ description: string; registry: string; cases: AttributionCase[] }> {
    const user = await agent(0x31);
    const client = await agent(0x32);
    const other = await agent(0x33);
    const agents = [user, client, other];
    const nonce = Buffer.from(new Uint8Array(18).fill(9)).toString('base64url');
    const cases: AttributionCase[] = [];
    const target = `did:cid:${await cid({ target: 1 })}`;
    const [version1, version2] = [await cid({ version: 1 }), await cid({ version: 2 })];

    const attributed: Expected = { outcome: 'attributed' };
    const pending: Expected = { outcome: 'pending' };
    const not = (reason: string, detail: Partial<Expected> = {}): Expected => ({ outcome: 'unattributed', reason, ...detail });
    const outside = (authority: string) => not('authority', { authority });
    const follows = not('follows-unattributed');

    const add = async (name: string, object: History, grant: History, expect: AttributionCase['expect']) => {
        cases.push({
            name,
            object: (await exported(agents, object.steps)).history,
            grant: (await exported(agents, grant.steps)).history,
            expect,
        });
    };

    let grants = 0;
    const grantData = (more: Operation = {}, to: Signer = client) =>
        ({ memeplexGrant: { v: 1, client: to.did, nonce: `${nonce}${grants++}`, ...more } });
    const live = () => History.create(user, grantData(), 100);
    const revoked = async (at: number) => (await live()).delete(user, at);

    const post = (grant: History, more: Operation = {}) =>
        ({ memeplex: { v: 1, author: user.did, grant: grant.did, kind: 'post', text: 'First.', ...more } });
    const rating = (grant: History, value: number, more: Operation = {}) => ({
        memeplex: { v: 1, author: user.did, grant: grant.did, kind: 'rating', target, targetVersion: version1, rating: value, min: 1, max: 5, ...more },
    });
    const tag = (grant: History) =>
        ({ memeplex: { v: 1, author: user.did, grant: grant.did, kind: 'tag', target, targetVersion: version1, tag: 'archon' } });

    // Published, edited, withdrawn.
    {
        const grant = await live();
        const data = post(grant);
        await add('created under a live grant', await History.create(client, data, 200), grant,
            { state: 'published', current: 0, versions: [attributed], memeplex: data.memeplex });
    }
    {
        const grant = await live();
        const edited = post(grant, { text: 'Second.' });
        const object = await (await History.create(client, post(grant), 200)).update(client, { didDocumentData: edited }, 300);
        await add('edited', object, grant, { state: 'published', current: 1, versions: [attributed, attributed], memeplex: edited.memeplex });
    }
    {
        const grant = await live();
        const data = post(grant);
        const object = await (await History.create(client, data, 200)).delete(client, 300);
        await add('withdrawn', object, grant, { state: 'withdrawn', current: 1, versions: [attributed, attributed], memeplex: data.memeplex });
    }
    {
        const grant = await live();
        const edited = post(grant, { text: 'Second.' });
        const object = await History.create(client, post(grant), 200);
        await object.update(client, {
            didDocument: object.document(client),
            didDocumentData: edited,
            didDocumentRegistration: { version: 1, type: 'asset', registry: REGISTRY },
        }, 300);
        await add('edited with a whole-document update', object, grant,
            { state: 'published', current: 1, versions: [attributed, attributed], memeplex: edited.memeplex });
    }

    // The plan's example: an edit, a revocation, then a deletion that comes too late.
    {
        const grant = await revoked(400);
        const edited = rating(grant, 2);
        const object = await History.create(client, rating(grant, 4), 200);
        await object.update(client, { didDocumentData: edited }, 300);
        await object.delete(client, 500);
        await add('deleted after its grant was revoked', object, grant,
            { state: 'published', current: 1, versions: [attributed, attributed, outside('after-end')], memeplex: edited.memeplex });
    }
    {
        const grant = await revoked(400);
        const edited = rating(grant, 2);
        const object = await History.create(client, rating(grant, 4), 200);
        await object.update(client, { didDocumentData: edited }, 300);
        await object.delete(client, 350);
        await add('deleted before its grant was revoked', object, grant,
            { state: 'withdrawn', current: 2, versions: [attributed, attributed, attributed], memeplex: edited.memeplex });
    }
    {
        const grant = await revoked(400);
        const data = post(grant);
        const object = await (await History.create(client, data, 200)).update(client, { didDocumentData: post(grant, { text: 'Late.' }) }, 400);
        await add('edited in the block that revoked its grant', object, grant,
            { state: 'published', current: 0, versions: [attributed, outside('after-end')], memeplex: data.memeplex });
    }
    // A signature can be backdated. A block cannot.
    {
        const grant = await revoked(400);
        await add('signed before the revocation, anchored after it', await History.create(client, post(grant), 500, {}, 300), grant,
            { state: 'none', versions: [outside('after-end')] });
    }
    {
        const grant = await live();
        await add('anchored before its grant', await History.create(client, post(grant), 50), grant,
            { state: 'none', versions: [outside('before-grant')] });
    }
    {
        const grant = await live();
        await add('anchored in the block of its grant', await History.create(client, post(grant), 100), grant,
            { state: 'none', versions: [outside('before-grant')] });
    }

    // Whose grant it is.
    {
        const grant = await History.create(other, grantData(), 100);
        await add('a grant its author did not create', await History.create(client, post(grant), 200), grant,
            { state: 'none', versions: [not('author')] });
    }
    {
        const grant = await History.create(other, grantData(), 100);
        await grant.update(other, { didDocument: grant.document(user) }, 150);
        await add('a grant created by another and transferred to the author', await History.create(client, post(grant), 200), grant,
            { state: 'none', versions: [not('author')] });
    }
    {
        const grant = await live();
        await add('created by an agent that is not the client', await History.create(other, post(grant), 200), grant,
            { state: 'none', versions: [not('publisher')] });
    }
    {
        const grant = await live();
        await add('created by the author directly', await History.create(user, post(grant), 200), grant,
            { state: 'none', versions: [not('publisher')] });
    }
    {
        const grant = await History.create(user, grantData({}, user), 100);
        await add('a grant that names its own creator', await History.create(user, post(grant), 200), grant,
            { state: 'none', versions: [not('grant-void', { grant: 'client-is-user' })] });
    }
    {
        const grant = await live();
        const another = await live();
        await add('handed the history of a different grant', await History.create(client, post(grant), 200), another,
            { state: 'none', versions: [not('grant-mismatch')] });
    }

    // Scope and expiry.
    {
        const grant = await History.create(user, grantData({ expiresAt: blockTime(300) }), 100);
        const data = post(grant);
        const object = await (await History.create(client, data, 200)).update(client, { didDocumentData: post(grant, { text: 'Late.' }) }, 350);
        await add('edited after its grant expired', object, grant,
            { state: 'published', current: 0, versions: [attributed, outside('expired')], memeplex: data.memeplex });
    }
    const narrowed = async () => {
        const grant = await live();
        const data = grant.steps[0].operation.data as { memeplexGrant: Operation };
        await grant.update(user, { didDocumentData: { memeplexGrant: { ...data.memeplexGrant, actions: ['memeplex:tag'] } } }, 300);
        return grant;
    };
    {
        const grant = await narrowed();
        const edited = post(grant, { text: 'Second.' });
        const object = await (await History.create(client, post(grant), 200)).update(client, { didDocumentData: edited }, 350);
        await add('edited after the grant stopped permitting its kind', object, grant,
            { state: 'published', current: 1, versions: [attributed, attributed], memeplex: edited.memeplex });
    }
    {
        const grant = await narrowed();
        await add('a kind the grant no longer permits', await History.create(client, post(grant), 350), grant,
            { state: 'none', versions: [outside('scope')] });
    }
    {
        const grant = await narrowed();
        const data = tag(grant);
        await add('a kind the grant still permits', await History.create(client, data, 350), grant,
            { state: 'published', current: 0, versions: [attributed], memeplex: data.memeplex });
    }
    {
        const grant = await narrowed();
        await add('anchored in the block of a scope update', await History.create(client, tag(grant), 300), grant,
            { state: 'none', versions: [outside('unordered')] });
    }

    // Pending evidence.
    {
        const grant = await live();
        await add('creation not anchored', await History.create(client, post(grant)), grant, { state: 'pending', versions: [pending] });
    }
    {
        const grant = await History.create(user, grantData());
        await add('grant not anchored', await History.create(client, post(grant), 200), grant, { state: 'pending', versions: [pending] });
    }
    {
        const grant = await live();
        const data = post(grant);
        const object = await (await History.create(client, data, 200)).update(client, { didDocumentData: post(grant, { text: 'Second.' }) });
        await add('edit not anchored', object, grant, { state: 'published', current: 0, versions: [attributed, pending], memeplex: data.memeplex });
    }

    // An edit that fails ends attribution and erases nothing.
    {
        const grant = await live();
        const data = rating(grant, 4);
        const object = await History.create(client, data, 200);
        await object.update(client, { didDocumentData: rating(grant, 9) }, 300);
        await object.delete(client, 350);
        await add('an invalid edit, then a deletion', object, grant, {
            state: 'published', current: 0, memeplex: data.memeplex,
            versions: [attributed, not('invalid', { validity: 'rating-bounds' }), follows],
        });
    }
    {
        const grant = await live();
        const data = post(grant);
        const object = await (await History.create(client, data, 200)).update(client, { didDocumentData: {} }, 300);
        await add('its object removed from its data', object, grant,
            { state: 'published', current: 0, versions: [attributed, not('invalid', { validity: 'schema' })], memeplex: data.memeplex });
    }
    {
        const grant = await live();
        const data = rating(grant, 4);
        const object = await (await History.create(client, data, 200))
            .update(client, { didDocumentData: rating(grant, 4, { target: `did:cid:${await cid({ target: 2 })}` }) }, 300);
        await add('its target changed', object, grant,
            { state: 'published', current: 0, versions: [attributed, not('identity')], memeplex: data.memeplex });
    }
    {
        const grant = await live();
        const edited = rating(grant, 3, { targetVersion: version2 });
        const object = await (await History.create(client, rating(grant, 4), 200)).update(client, { didDocumentData: edited }, 300);
        await add('its target version changed', object, grant,
            { state: 'published', current: 1, versions: [attributed, attributed], memeplex: edited.memeplex });
    }
    {
        const grant = await live();
        const data = post(grant);
        const object = await History.create(client, data, 200);
        await object.update(client, { didDocument: object.document(other) }, 300);
        await object.update(other, { didDocumentData: post(grant, { text: 'Not mine.' }) }, 350);
        await add('transferred, then edited by its new controller', object, grant,
            { state: 'published', current: 0, versions: [attributed, not('identity'), follows], memeplex: data.memeplex });
    }
    {
        const grant = await live();
        const data = post(grant);
        const object = await (await History.create(client, data, 200))
            .update(client, { didDocumentRegistration: { version: 1, type: 'asset', registry: 'ZEC:mainnet' } }, 300);
        await add('moved to another registry', object, grant,
            { state: 'published', current: 0, versions: [attributed, not('identity')], memeplex: data.memeplex });
    }

    // A creation that cannot be attributed.
    {
        const grant = await live();
        await add('on a registry that is not its grant\'s', await History.create(client, post(grant), 200, { registry: 'ZEC:mainnet' }), grant,
            { state: 'none', versions: [not('registry')] });
    }
    {
        const grant = await live();
        await add('created with validUntil', await History.create(client, post(grant), 200, { validUntil: '2099-01-01T00:00:00Z' }), grant,
            { state: 'none', versions: [not('expires-by-registration')] });
    }
    {
        const grant = await live();
        const object = await (await History.create(client, rating(grant, 9), 200)).update(client, { didDocumentData: rating(grant, 4) }, 300);
        await add('an invalid creation, repaired by an edit', object, grant,
            { state: 'none', versions: [not('invalid', { validity: 'rating-bounds' }), follows] });
    }
    {
        const grant = await live();
        await add('an asset that holds no object', await History.create(client, { note: 'nothing here' }, 200), grant,
            { state: 'none', versions: [not('not-an-object')] });
    }
    {
        const grant = await live();
        await add('a later v', await History.create(client, post(grant, { v: 2 }), 200), grant,
            { state: 'unsupported', versions: [{ outcome: 'unsupported' }] });
    }

    {
        const grant = await live();
        const data = post(grant);
        const object = await History.create(client, data, 200);
        await object.update(client, { didDocumentData: post(grant, { v: 2 }) }, 300);
        await object.delete(client, 350);
        await add('edited to a later v, then deleted', object, grant, {
            state: 'published', current: 0, memeplex: data.memeplex,
            versions: [attributed, { outcome: 'unsupported' }, { outcome: 'unsupported' }],
        });
    }

    return {
        description: 'Memeplex v1 object histories with their grants\' histories, as a Gatekeeper exports them, '
            + 'and the publication derived from each pair. Written by tests/memeplex/attribution-vectors.ts.',
        registry: REGISTRY,
        cases,
    };
}
