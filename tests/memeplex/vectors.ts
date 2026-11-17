import CipherNode from '@didcid/cipher/node';
import { generateCID } from '@didcid/ipfs/utils';
import type { EcdsaJwkPair } from '@didcid/cipher/types';
import type { Outcome, SchemaName } from './validate.ts';

// Builds tests/fixtures/memeplex-v1-vectors.json: signed operations that create
// Memeplex objects and grants, valid and invalid, each with the outcome the `v: 1`
// rules give it. Keys and times are fixed, so the same file comes out every time.
//
// Every operation here is one a Gatekeeper accepts. Whether its data is a valid
// Memeplex object is a separate question, and the one these vectors answer.

const cipher = new CipherNode();

// A string of this many code points whose UTF-16 length is greater, so that a
// validator counting UTF-16 units gets the limits wrong.
function codePoints(count: number): string {
    return '🙂'.repeat(Math.min(count, 8)) + 'a'.repeat(Math.max(count - 8, 0));
}
const CREATED = '2026-11-17T00:00:00.000Z';
const REGISTRY = 'BTC:mainnet';

export interface Identity {
    did: string;
    operation: Record<string, unknown>;
}

export interface Case {
    name: string;
    schema: SchemaName;
    // The member of the asset's data the schema applies to.
    member: 'memeplex' | 'memeplexGrant' | 'memeplexGrantRequest';
    expect: Outcome;
    // A grant request travels in a link and is never an operation.
    did?: string;
    operation?: Record<string, unknown>;
    request?: Record<string, unknown>;
}

export interface Vectors {
    description: string;
    registry: string;
    identities: Record<string, Identity>;
    assets: Record<string, Identity>;
    cases: Case[];
}

interface Signer extends Identity {
    keypair: EcdsaJwkPair;
}

function prove(operation: Record<string, unknown>, keypair: EcdsaJwkPair, verificationMethod: string): Record<string, unknown> {
    const config = {
        type: 'DataIntegrityProof',
        cryptosuite: 'archon-ecdsa-secp256k1-jcs-2026',
        created: CREATED,
        verificationMethod,
        proofPurpose: 'capabilityInvocation',
    };
    const payload = Buffer.from(cipher.hashJSON(config) + cipher.hashJSON(operation), 'hex');
    const signature = cipher.signHash(cipher.hashMessage(payload), keypair.privateJwk);
    return { ...operation, proof: { ...config, proofValue: Buffer.from(signature, 'hex').toString('base64url') } };
}

async function identify(operation: Record<string, unknown>): Promise<Identity> {
    return { did: `did:cid:${await generateCID(operation, { canonical: true })}`, operation };
}

async function agent(key: number): Promise<Signer> {
    const keypair = cipher.generateJwk(new Uint8Array(32).fill(key));
    const operation = prove({
        type: 'create',
        created: CREATED,
        registration: { version: 1, type: 'agent', registry: 'hyperswarm' },
        publicJwk: keypair.publicJwk,
    }, keypair, '#key-1');
    return { keypair, ...await identify(operation) };
}

async function asset(controller: Signer, data: Record<string, unknown>): Promise<Identity> {
    return identify(prove({
        type: 'create',
        created: CREATED,
        registration: { version: 1, type: 'asset', registry: REGISTRY },
        controller: controller.did,
        data,
    }, controller.keypair, `${controller.did}#key-1`));
}

function versionId(identity: Identity): string {
    return identity.did.slice('did:cid:'.length);
}

function without(value: Record<string, unknown>, field: string): Record<string, unknown> {
    const { [field]: removed, ...rest } = value;
    void removed;
    return rest;
}

// A value of the right type for each field of the field table, used where a kind
// must not carry the field at all.
const FOREIGN: Record<string, unknown> = {
    text: 'text',
    content: { cid: 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy', type: 'text/markdown', bytes: 1 },
    target: 'did:cid:bagaaieratn3qyhvyjd5nb2wa55knrb5zkx2sscb7hqgq6nxu5pwcd7ymuhpq',
    targetVersion: 'bagaaieratn3qyhvyjd5nb2wa55knrb5zkx2sscb7hqgq6nxu5pwcd7ymuhpq',
    tags: ['archon'],
    title: 'A title',
    subtitle: 'A subtitle',
    summary: 'A summary',
    authors: ['did:cid:bagaaieratn3qyhvyjd5nb2wa55knrb5zkx2sscb7hqgq6nxu5pwcd7ymuhpq'],
    source: { cid: 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy', type: 'application/x-tex', bytes: 1 },
    pdf: { cid: 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy', type: 'application/pdf', bytes: 1 },
    verdict: 'accept',
    rating: 3,
    min: 1,
    max: 5,
    tag: 'archon',
    image: 'did:cid:bagaaieratn3qyhvyjd5nb2wa55knrb5zkx2sscb7hqgq6nxu5pwcd7ymuhpq?versionId=bagaaieratn3qyhvyjd5nb2wa55knrb5zkx2sscb7hqgq6nxu5pwcd7ymuhpq',
};

// The fields each kind may carry and the ones it must, from the field table.
export const KINDS: Record<string, { allowed: string[]; required: string[] }> = {
    post: {
        allowed: ['text', 'content', 'target', 'targetVersion', 'tags', 'title', 'subtitle', 'summary'],
        required: ['author', 'grant'],
    },
    paper: {
        allowed: ['content', 'tags', 'title', 'subtitle', 'summary', 'authors', 'source', 'pdf'],
        required: ['author', 'grant', 'title', 'summary', 'authors', 'content'],
    },
    reply: {
        allowed: ['text', 'content', 'target', 'targetVersion', 'tags', 'verdict'],
        required: ['author', 'grant', 'target', 'targetVersion'],
    },
    rating: {
        allowed: ['target', 'targetVersion', 'rating', 'min', 'max'],
        required: ['author', 'grant', 'target', 'targetVersion', 'rating', 'min', 'max'],
    },
    tag: {
        allowed: ['target', 'targetVersion', 'tag', 'image'],
        required: ['author', 'grant', 'target', 'targetVersion', 'tag'],
    },
};

export async function build(): Promise<Vectors> {
    const alice = await agent(0x01);
    const bob = await agent(0x02);
    const carol = await agent(0x03);
    const dave = await agent(0x04);
    const memepool = await agent(0x11);
    const aliceClient = await agent(0x12);
    const widget = await agent(0x13);

    const nonce = (key: number) => Buffer.from(new Uint8Array(18).fill(key)).toString('base64url');
    const cid = (key: number) => generateCID({ fixture: key });

    const image = await asset(dave, {
        image: { cid: await cid(1), type: 'image/png', bytes: 20480, width: 128, height: 128 },
    });
    const pinned = `${image.did}?versionId=${versionId(image)}`;

    const cases: Case[] = [];

    // Grants first: every object names one.
    const grantCase = async (name: string, user: Signer, expect: Outcome, memeplexGrant: Record<string, unknown>) => {
        const created = await asset(user, { memeplexGrant });
        cases.push({ name: `grant: ${name}`, schema: 'grant', member: 'memeplexGrant', expect, ...created });
        return created;
    };
    const aliceGrant = await grantCase('every core kind', alice, 'valid', { v: 1, client: memepool.did, nonce: nonce(1) });
    const aliceOwnGrant = await grantCase('without a nonce', alice, 'valid', { v: 1, client: aliceClient.did });
    const bobGrant = await grantCase('some actions', bob, 'valid', {
        v: 1, client: memepool.did, actions: ['memeplex:post', 'memeplex:reply', 'memeplex:tag'], nonce: nonce(2),
    });
    const carolGrant = await grantCase('expires', carol, 'valid', {
        v: 1, client: memepool.did, nonce: nonce(3), expiresAt: '2028-02-29T23:59:59.5Z',
    });
    const daveGrant = await grantCase('one action and an extension kind', dave, 'valid', {
        v: 1, client: widget.did, actions: ['memeplex:tag', 'memeplex:rate', pinned], nonce: nonce(4),
    });
    const grant = { v: 1, client: memepool.did, nonce: nonce(5) };
    await grantCase('an unknown field is ignored', alice, 'valid', { ...grant, label: 'phone' });
    await grantCase('lacks client', alice, 'schema', without(grant, 'client'));
    await grantCase('client is not a DID', alice, 'schema', { ...grant, client: 'memepool' });
    await grantCase('no actions listed', alice, 'schema', { ...grant, actions: [] });
    await grantCase('an action twice', alice, 'schema', { ...grant, actions: ['memeplex:tag', 'memeplex:tag'] });
    await grantCase('an unknown action', alice, 'schema', { ...grant, actions: ['memeplex:delete'] });
    await grantCase('an extension kind that is not pinned', alice, 'schema', { ...grant, actions: [image.did] });
    await grantCase('a nonce of fewer than 128 bits', alice, 'schema', { ...grant, nonce: nonce(5).slice(0, 21) });
    await grantCase('a nonce that is not base64url', alice, 'schema', { ...grant, nonce: `${nonce(5).slice(0, 23)}+` });
    await grantCase('an expiry with an offset', alice, 'schema', { ...grant, expiresAt: '2026-12-31T00:00:00+00:00' });
    await grantCase('an expiry without a time', alice, 'schema', { ...grant, expiresAt: '2026-12-31' });
    await grantCase('an expiry on a day that does not exist', alice, 'expiry-instant', { ...grant, expiresAt: '2026-02-30T00:00:00Z' });
    await grantCase('an expiry in a month that does not exist', alice, 'expiry-instant', { ...grant, expiresAt: '2026-13-01T00:00:00Z' });
    await grantCase('an expiry at an hour that does not exist', alice, 'expiry-instant', { ...grant, expiresAt: '2026-12-31T25:00:00Z' });
    await grantCase('a later v', alice, 'unsupported', { ...grant, v: 2 });

    const request = { v: 1, client: memepool.did, name: 'Memepool', nonce: nonce(6) };
    const requestCase = (name: string, expect: Outcome, memeplexGrantRequest: Record<string, unknown>) => {
        cases.push({ name: `grant request: ${name}`, schema: 'grant-request', member: 'memeplexGrantRequest', expect, request: memeplexGrantRequest });
    };
    requestCase('every core kind', 'valid', request);
    requestCase('some actions and an expiry', 'valid', {
        ...request, actions: ['memeplex:post', 'memeplex:reply', 'memeplex:tag'], expiresAt: '2026-12-31T00:00:00Z',
    });
    requestCase('a name of 100 code points', 'valid', { ...request, name: codePoints(100) });
    requestCase('lacks name', 'schema', without(request, 'name'));
    requestCase('lacks nonce', 'schema', without(request, 'nonce'));
    requestCase('lacks client', 'schema', without(request, 'client'));
    requestCase('an empty name', 'schema', { ...request, name: '' });
    requestCase('a name of 101 code points', 'schema', { ...request, name: codePoints(101) });
    requestCase('an expiry on a day that does not exist', 'expiry-instant', { ...request, expiresAt: '2027-02-29T00:00:00Z' });

    // Objects. Each is created by the client that holds its author's grant.
    const by = (user: Signer, held: Identity) => ({ v: 1, author: user.did, grant: held.did });
    const objectCase = async (name: string, client: Signer, expect: Outcome, memeplex: Record<string, unknown>) => {
        const created = await asset(client, { memeplex });
        cases.push({ name, schema: memeplex.kind as SchemaName, member: 'memeplex', expect, ...created });
        return created;
    };
    const markdown = { cid: await cid(2), type: 'text/markdown', bytes: 48213 };

    const post = { ...by(alice, aliceGrant), kind: 'post', text: 'Every post on Memepool is a DID.' };
    const alicePost = await objectCase('post: text and tags', memepool, 'valid', { ...post, tags: ['archon', 'memeplex'] });
    const aimed = { target: alicePost.did, targetVersion: versionId(alicePost) };

    await objectCase('post: embeds an image', memepool, 'valid', {
        ...post, text: `So is this photo.\n\n![A canvas tent full of people facing a projector screen](${pinned})`,
    });
    await objectCase('post: an article', memepool, 'valid', {
        ...by(alice, aliceGrant), kind: 'post',
        title: 'Why every post should be a DID',
        subtitle: 'Objects as identifiers, not rows in someone\'s database',
        summary: 'Permalinks, edit history and provable timestamps for free.',
        content: markdown,
        tags: ['archon', 'publishing'],
    });
    await objectCase('post: a quote post', memepool, 'valid', {
        ...by(bob, bobGrant), kind: 'post', ...aimed, text: 'This is the clearest explanation of the idea so far.',
    });
    await objectCase('post: a plain boost', memepool, 'valid', { ...by(bob, bobGrant), kind: 'post', ...aimed });
    await objectCase('post: text of 10,000 code points', memepool, 'valid', { ...post, text: codePoints(10000) });
    await objectCase('post: empty text', memepool, 'valid', { ...post, text: '' });
    await objectCase('post: 20 tags, one of 64 code points', memepool, 'valid', {
        ...post, tags: [...Array.from({ length: 19 }, (_, i) => `tag-${i}`), codePoints(64)],
    });
    await objectCase('post: a title, subtitle and summary at their limits', memepool, 'valid', {
        ...post, title: codePoints(300), subtitle: codePoints(300), summary: codePoints(5000),
    });
    await objectCase('post: an unknown field is ignored', memepool, 'valid', { ...post, text: 'With a mood.', mood: 'cheerful' });
    await objectCase('post: a CIDv0 content reference', memepool, 'valid', {
        ...by(alice, aliceGrant), kind: 'post',
        content: { ...markdown, cid: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG' },
    });
    await objectCase('post: text and content', memepool, 'schema', { ...post, content: markdown });
    await objectCase('post: no body and no target', memepool, 'schema', without(post, 'text'));
    await objectCase('post: text of 10,001 code points', memepool, 'schema', { ...post, text: codePoints(10001) });
    await objectCase('post: target without targetVersion', memepool, 'schema', { ...post, target: alicePost.did });
    await objectCase('post: targetVersion without target', memepool, 'schema', { ...post, targetVersion: versionId(alicePost) });
    await objectCase('post: targetVersion is a DID', memepool, 'schema', { ...post, ...aimed, targetVersion: alicePost.did });
    await objectCase('post: subtitle without title', memepool, 'schema', { ...post, subtitle: 'A subtitle' });
    await objectCase('post: summary without title', memepool, 'schema', { ...post, summary: 'A summary' });
    await objectCase('post: a title of 301 code points', memepool, 'schema', { ...post, title: codePoints(301) });
    await objectCase('post: a summary of 5,001 code points', memepool, 'schema', {
        ...post, title: 'A title', summary: codePoints(5001),
    });
    await objectCase('post: no tags listed', memepool, 'schema', { ...post, tags: [] });
    await objectCase('post: 21 tags', memepool, 'schema', { ...post, tags: Array.from({ length: 21 }, (_, i) => `tag-${i}`) });
    await objectCase('post: an empty tag', memepool, 'schema', { ...post, tags: [''] });
    await objectCase('post: a tag of 65 code points', memepool, 'schema', { ...post, tags: [codePoints(65)] });
    await objectCase('post: content that is not Markdown', memepool, 'schema', {
        ...without(post, 'text'), content: { ...markdown, type: 'text/html' },
    });
    await objectCase('post: content without bytes', memepool, 'schema', {
        ...without(post, 'text'), content: without(markdown, 'bytes'),
    });
    await objectCase('post: content with negative bytes', memepool, 'schema', {
        ...without(post, 'text'), content: { ...markdown, bytes: -1 },
    });
    await objectCase('post: content whose cid is not a CID', memepool, 'schema', {
        ...without(post, 'text'), content: { ...markdown, cid: 'https://example.com/post.md' },
    });
    await objectCase('post: author is not a DID', memepool, 'schema', { ...post, author: 'alice' });
    await objectCase('post: a later v', memepool, 'unsupported', { ...post, v: 2 });

    const paper = {
        ...by(alice, aliceOwnGrant), kind: 'paper',
        title: 'Convergent Replay of Signed DID Histories',
        summary: 'We show that nodes receiving the same signed operations reach the same histories.',
        authors: [alice.did, bob.did],
        content: { cid: await cid(3), type: 'text/markdown', bytes: 61207 },
    };
    const alicePaper = await objectCase('paper: with a PDF and LaTeX source', aliceClient, 'valid', {
        ...paper,
        pdf: { cid: await cid(4), type: 'application/pdf', bytes: 912340 },
        source: { cid: await cid(5), type: 'application/x-tex', bytes: 84112 },
        tags: ['distributed-systems', 'did'],
    });
    const revision = { target: alicePaper.did, targetVersion: versionId(alicePaper) };
    await objectCase('paper: one author and a source archive', aliceClient, 'valid', {
        ...paper, authors: [alice.did], subtitle: 'A proof', source: { cid: await cid(5), type: 'application/gzip', bytes: 84112 },
    });
    await objectCase('paper: a source that is not LaTeX or an archive', aliceClient, 'schema', {
        ...paper, source: { cid: await cid(5), type: 'application/zip', bytes: 84112 },
    });
    await objectCase('paper: a pdf that is not a PDF', aliceClient, 'schema', {
        ...paper, pdf: { cid: await cid(4), type: 'text/markdown', bytes: 912340 },
    });
    await objectCase('paper: no authors listed', aliceClient, 'schema', { ...paper, authors: [] });
    await objectCase('paper: an author twice', aliceClient, 'schema', { ...paper, authors: [alice.did, alice.did] });
    await objectCase('paper: authors without the author', aliceClient, 'paper-authors', { ...paper, authors: [bob.did, carol.did] });

    const reply = { ...by(bob, bobGrant), kind: 'reply', ...aimed, text: 'Including the reactions?' };
    await objectCase('reply: text', memepool, 'valid', reply);
    await objectCase('reply: content', memepool, 'valid', { ...without(reply, 'text'), content: markdown });
    await objectCase('reply: a review', memepool, 'valid', {
        ...by(carol, carolGrant), kind: 'reply', ...revision,
        verdict: 'minor revisions', text: 'The convergence argument holds, but section 4 assumes a settled prefix.',
    });
    await objectCase('reply: no body', memepool, 'schema', without(reply, 'text'));
    await objectCase('reply: text and content', memepool, 'schema', { ...reply, content: markdown });
    await objectCase('reply: a verdict of 301 code points', memepool, 'schema', { ...reply, verdict: codePoints(301) });

    const rating = { ...by(carol, carolGrant), kind: 'rating', ...revision, rating: 3, min: 1, max: 5 };
    await objectCase('rating: three stars of five', memepool, 'valid', rating);
    await objectCase('rating: a thumbs up', memepool, 'valid', { ...rating, rating: 1, min: 0, max: 1 });
    await objectCase('rating: a centred scale', memepool, 'valid', { ...rating, rating: 0, min: -2, max: 2 });
    await objectCase('rating: at the bottom of its scale', memepool, 'valid', { ...rating, rating: 1 });
    await objectCase('rating: not an integer', memepool, 'schema', { ...rating, rating: 3.5 });
    await objectCase('rating: a string', memepool, 'schema', { ...rating, rating: '3' });
    await objectCase('rating: above its scale', memepool, 'rating-bounds', { ...rating, rating: 6 });
    await objectCase('rating: below its scale', memepool, 'rating-bounds', { ...rating, rating: 0 });
    await objectCase('rating: a scale of one point', memepool, 'rating-bounds', { ...rating, rating: 3, min: 3, max: 3 });
    await objectCase('rating: a scale upside down', memepool, 'rating-bounds', { ...rating, min: 5, max: 1 });

    const tag = { ...by(dave, daveGrant), kind: 'tag', ...aimed, tag: 'cryptography' };
    await objectCase('tag: a word', widget, 'valid', tag);
    await objectCase('tag: a reaction', widget, 'valid', { ...tag, tag: '❤️' });
    await objectCase('tag: a custom emoji', widget, 'valid', { ...tag, tag: ':catjam:', image: pinned });
    await objectCase('tag: a coauthor confirming a revision', memepool, 'valid', {
        ...by(bob, bobGrant), kind: 'tag', ...revision, tag: 'coauthor',
    });
    await objectCase('tag: 64 code points', widget, 'valid', { ...tag, tag: codePoints(64) });
    await objectCase('tag: empty', widget, 'schema', { ...tag, tag: '' });
    await objectCase('tag: 65 code points', widget, 'schema', { ...tag, tag: codePoints(65) });
    await objectCase('tag: an image that is not pinned', widget, 'schema', { ...tag, tag: ':catjam:', image: image.did });
    await objectCase('tag: an image by URL', widget, 'schema', { ...tag, tag: ':catjam:', image: 'https://example.com/catjam.png' });

    // The strictness rule, for every kind: each required field, and each field
    // another kind defines.
    const whole: Record<string, { client: Signer; value: Record<string, unknown> }> = {
        post: { client: memepool, value: post },
        paper: { client: aliceClient, value: paper },
        reply: { client: memepool, value: reply },
        rating: { client: memepool, value: rating },
        tag: { client: widget, value: tag },
    };
    for (const [kind, { allowed, required }] of Object.entries(KINDS)) {
        const { client, value } = whole[kind];
        for (const field of required) {
            await objectCase(`${kind}: lacks ${field}`, client, 'schema', without(value, field));
        }
        for (const field of Object.keys(FOREIGN).filter(name => !allowed.includes(name))) {
            await objectCase(`${kind}: has ${field}`, client, 'schema', { ...value, [field]: FOREIGN[field] });
        }
    }

    const publish = ({ did, operation }: Identity): Identity => ({ did, operation });
    return {
        description: 'Signed Memeplex v1 objects and grants with the outcome of validating each. '
            + 'Written by tests/memeplex/vectors.ts; see tests/memeplex/schemas.test.ts.',
        registry: REGISTRY,
        identities: {
            alice: publish(alice), bob: publish(bob), carol: publish(carol), dave: publish(dave),
            memepool: publish(memepool), aliceClient: publish(aliceClient), widget: publish(widget),
        },
        assets: { image },
        cases,
    };
}
