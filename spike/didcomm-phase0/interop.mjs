// Interop oracle: validates the pure-JS cipher DIDComm envelopes
// (packages/cipher/src/didcomm.ts) against the didcomm-node reference library,
// in BOTH directions, for anoncrypt / authcrypt / sign-then-encrypt.
//
// Prereq: build the cipher package first, then run from this directory:
//   (repo root)  npm run build:esm --workspace=packages/cipher
//   (here)       npm ci && node interop.mjs
//
// didcomm-node is a dev/test oracle only — it is NOT a runtime dependency.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Message } = require('didcomm-node');
const C = await import('../../packages/cipher/dist/esm/didcomm.js');
const CipherNode = (await import('../../packages/cipher/dist/esm/cipher-node.js')).default;
const cph = new CipherNode();

const enc = new TextEncoder(), dec = new TextDecoder();
const ALICE = 'did:cid:alice', BOB = 'did:cid:bob';
const aKid = `${ALICE}#key-agreement-1`, bKid = `${BOB}#key-agreement-1`, aSig = `${ALICE}#key-signing-1`;
const aliceKA = cph.generateX25519Jwk(new Uint8Array(32).fill(11));
const bobKA = cph.generateX25519Jwk(new Uint8Array(32).fill(22));
const aliceSig = cph.generateJwk(new Uint8Array(32).fill(33));

const doc = (id, vms, ka, auth = []) => ({ id, keyAgreement: ka, authentication: auth, verificationMethod: vms, service: [] });
const DOCS = {
    [ALICE]: doc(ALICE, [
        { id: aKid, type: 'JsonWebKey2020', controller: ALICE, publicKeyJwk: aliceKA.publicJwk },
        { id: aSig, type: 'JsonWebKey2020', controller: ALICE, publicKeyJwk: aliceSig.publicJwk },
    ], [aKid], [aSig]),
    [BOB]: doc(BOB, [{ id: bKid, type: 'JsonWebKey2020', controller: BOB, publicKeyJwk: bobKA.publicJwk }], [bKid]),
};
const resolver = { async resolve(d) { return DOCS[d] ?? null; } };
const secrets = (m) => ({ async get_secret(id) { return m[id] ?? null; }, async find_secrets(ids) { return ids.filter(i => i in m); } });
const aliceSecrets = secrets({ [aKid]: { id: aKid, type: 'JsonWebKey2020', privateKeyJwk: aliceKA.privateJwk }, [aSig]: { id: aSig, type: 'JsonWebKey2020', privateKeyJwk: aliceSig.privateJwk } });
const bobSecrets = secrets({ [bKid]: { id: bKid, type: 'JsonWebKey2020', privateKeyJwk: bobKA.privateJwk } });

const recipients = [{ kid: bKid, publicJwk: bobKA.publicJwk }];
const sender = { kid: aKid, privateJwk: aliceKA.privateJwk };
const signer = { kid: aSig, privateJwk: aliceSig.privateJwk };
const jwm = (from) => ({ id: 'm1', typ: 'application/didcomm-plain+json', type: 'https://x/1/hi', ...(from ? { from: ALICE } : {}), to: [BOB], body: { hello: 'world', n: 42 } });
const opts = { forward: false };

const results = [];
const check = (name, cond) => results.push([name, !!cond]);

// ours -> lib
{
    const packed = C.packEncrypted(enc.encode(JSON.stringify(jwm(false))), recipients, null, 'XC20P');
    const [m, meta] = await Message.unpack(packed, resolver, bobSecrets, {});
    check('ours anoncrypt        -> lib', m.as_value().body.hello === 'world' && meta.encrypted && !meta.authenticated);
}
{
    const packed = C.packEncrypted(enc.encode(JSON.stringify(jwm(true))), recipients, sender, 'A256CBC-HS512');
    const [m, meta] = await Message.unpack(packed, resolver, bobSecrets, {});
    check('ours authcrypt        -> lib', m.as_value().body.n === 42 && meta.authenticated && m.as_value().from === ALICE);
}
{
    const packed = C.packDidCommMessage(jwm(true), recipients, { sender, signer });
    const [m, meta] = await Message.unpack(packed, resolver, bobSecrets, {});
    check('ours authcrypt+sign   -> lib', m.as_value().body.n === 42 && meta.non_repudiation && meta.sign_from === aSig);
}

// lib -> ours
{
    const [packed] = await new Message(jwm(false)).pack_encrypted(BOB, null, null, resolver, aliceSecrets, opts);
    const { plaintext } = C.unpackEncrypted(packed, { kid: bKid, privateJwk: bobKA.privateJwk });
    check('lib  anoncrypt        -> ours', JSON.parse(dec.decode(plaintext)).body.hello === 'world');
}
{
    const [packed] = await new Message(jwm(true)).pack_encrypted(BOB, ALICE, null, resolver, aliceSecrets, opts);
    const { plaintext } = C.unpackEncrypted(packed, { kid: bKid, privateJwk: bobKA.privateJwk }, aliceKA.publicJwk);
    check('lib  authcrypt        -> ours', JSON.parse(dec.decode(plaintext)).body.n === 42);
}
{
    const [packed] = await new Message(jwm(true)).pack_encrypted(BOB, ALICE, aSig, resolver, aliceSecrets, opts);
    const { message, metadata } = C.unpackDidCommMessage(packed, { kid: bKid, privateJwk: bobKA.privateJwk }, { senderKey: aliceKA.publicJwk, signerKey: aliceSig.publicJwk });
    check('lib  authcrypt+sign   -> ours', message.body.n === 42 && metadata.nonRepudiation && metadata.signer === aSig);
}

let ok = true;
for (const [n, p] of results) { console.log((p ? 'PASS' : 'FAIL').padEnd(5), n); if (!p) ok = false; }
console.log(ok ? '\nALL INTEROP PASS' : '\nINTEROP FAILURES');
process.exit(ok ? 0 : 1);
