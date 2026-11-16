// Builds signed Memeplex operations for the benchmark in docs/plans/memeplex-1436.md:
// users, their clients, one grant for each user, and objects of every kind in a fixed
// mix. Nothing here talks to a node. A DID is the CID of its create operation, so the
// operations can name each other before any of them is submitted.
import CipherNode from '@didcid/cipher/node';
import { generateCID } from '@didcid/ipfs/utils';
import { base64url } from 'multiformats/bases/base64';

const cipher = new CipherNode();

// A share of each kind in a thousand objects. Mostly short posts, reactions and tags,
// some replies and ratings, few articles and papers.
export const MIX = [
    ['post', 330], ['reaction', 300], ['reply', 170], ['tag', 80],
    ['rating', 70], ['boost', 30], ['article', 17], ['paper', 3],
];

// A small, fast generator, so that a run can be repeated from its seed.
export function random(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const WORDS = ('archon did identity grant client publish post reply rating review paper essay graph '
    + 'history version chain anchor gossip node key signature wallet schema reader author thread tag '
    + 'open network evidence revision reference content mesh proof registry record index timeline').split(' ');
const EMOJI = ['👍', '❤️', '😂', '🔥', '🎉', '🤔', '👀', '🙏'];

function words(next, count) {
    return Array.from({ length: count }, () => WORDS[Math.floor(next() * WORDS.length)]).join(' ');
}

function sign(operation, keypair, verificationMethod, created) {
    const signature = cipher.signHash(cipher.hashJSON(operation), keypair.privateJwk);
    return {
        ...operation,
        proof: {
            type: 'EcdsaSecp256k1Signature2019',
            created,
            verificationMethod,
            proofPurpose: 'authentication',
            proofValue: base64url.baseEncode(Buffer.from(signature, 'hex')),
        },
    };
}

// The DID a Gatekeeper gives a create operation, and the version ID of that creation.
async function identify(operation) {
    const cid = await generateCID(operation, { canonical: true });
    return { did: `did:cid:${cid}`, versionId: cid };
}

async function agent(registry, created) {
    const keypair = cipher.generateRandomJwk();
    const operation = sign({
        type: 'create', created,
        registration: { version: 1, type: 'agent', registry },
        publicJwk: keypair.publicJwk,
    }, keypair, '#key-1', created);
    return { keypair, operation, ...await identify(operation) };
}

async function asset(controller, registry, data, created) {
    const operation = sign({
        type: 'create', created,
        registration: { version: 1, type: 'asset', registry },
        controller: controller.did,
        data,
    }, controller.keypair, `${controller.did}#key-1`, created);
    return { operation, ...await identify(operation) };
}

// A user, the client it publishes through, and the grant between them.
export async function author(registry, next, created = new Date().toISOString()) {
    const user = await agent(registry, created);
    const client = await agent(registry, created);
    const nonce = base64url.baseEncode(Buffer.from(Array.from({ length: 18 }, () => Math.floor(next() * 256))));
    const grant = await asset(user, registry, { memeplexGrant: { v: 1, client: client.did, nonce } }, created);
    return { user, client, grant, operations: [user.operation, client.operation, grant.operation] };
}

export function pickKind(next) {
    let at = next() * 1000;
    for (const [kind, share] of MIX) {
        if ((at -= share) < 0) return kind;
    }
    return 'post';
}

// One object by this author. `target` is an earlier object, { did, versionId }, and
// is needed for every kind that responds to something.
export async function object(by, kind, target, registry, next, created = new Date().toISOString()) {
    const base = { v: 1, author: by.user.did, grant: by.grant.did };
    const aimed = target ? { target: target.did, targetVersion: target.versionId } : {};
    // A real CID of content that is stored nowhere.
    const absent = () => generateCID({ absent: next() }, { canonical: true });
    let memeplex;
    switch (kind) {
    case 'post':
        memeplex = { ...base, kind: 'post', text: words(next, 8 + Math.floor(next() * 35)), tags: [words(next, 1), words(next, 1)] };
        break;
    case 'boost':
        memeplex = { ...base, kind: 'post', ...aimed };
        break;
    case 'article':
        memeplex = {
            ...base, kind: 'post', title: words(next, 6), subtitle: words(next, 9), summary: words(next, 25),
            content: { cid: await absent(), type: 'text/markdown', bytes: 8000 + Math.floor(next() * 60000) }, tags: [words(next, 1), words(next, 1)],
        };
        break;
    case 'paper':
        memeplex = {
            ...base, kind: 'paper', title: words(next, 8), summary: words(next, 120), authors: [by.user.did],
            content: { cid: await absent(), type: 'text/markdown', bytes: 40000 + Math.floor(next() * 60000) },
            pdf: { cid: await absent(), type: 'application/pdf', bytes: 400000 + Math.floor(next() * 900000) }, tags: [words(next, 1), words(next, 1)],
        };
        break;
    case 'reply':
        memeplex = { ...base, kind: 'reply', ...aimed, text: words(next, 6 + Math.floor(next() * 40)) };
        break;
    case 'rating':
        memeplex = { ...base, kind: 'rating', ...aimed, rating: 1 + Math.floor(next() * 5), min: 1, max: 5 };
        break;
    case 'tag':
        memeplex = { ...base, kind: 'tag', ...aimed, tag: words(next, 1) };
        break;
    case 'reaction':
        memeplex = { ...base, kind: 'tag', ...aimed, tag: EMOJI[Math.floor(next() * EMOJI.length)] };
        break;
    default:
        throw new Error(`unknown kind ${kind}`);
    }
    return { kind, ...await asset(by.client, registry, { memeplex }, created) };
}

// Kinds that respond to an earlier object.
export const RESPONDS = new Set(['boost', 'reply', 'rating', 'tag', 'reaction']);
