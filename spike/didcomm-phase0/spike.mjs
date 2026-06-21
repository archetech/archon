// DIDComm Phase 0 spike — validate didcomm-node pack/unpack between two
// Archon-shaped DIDs carrying X25519 key-agreement keys, via thin
// DIDResolver / SecretsResolver adapters. Throwaway.
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const { Message } = require('didcomm-node');

// --- keygen via Node crypto, exported as standard JWK (no extra deps) ---
const jwkPair = (type, opts) => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync(type, opts);
  return { pub: publicKey.export({ format: 'jwk' }), priv: privateKey.export({ format: 'jwk' }) };
};
const genX25519 = () => jwkPair('x25519');
const genSecp256k1 = () => jwkPair('ec', { namedCurve: 'secp256k1' });

const ALICE = 'did:cid:alice';
const BOB = 'did:cid:bob';

const aliceKA = genX25519();
const aliceSig = genSecp256k1(); // Archon's existing key type — for signing (ES256K)
const bobKA = genX25519();

const aliceKAId = `${ALICE}#key-agreement-1`;
const aliceSigId = `${ALICE}#key-signing-1`;
const bobKAId = `${BOB}#key-agreement-1`;

// --- Archon-shaped (normalized) DID documents the gatekeeper adapter would emit ---
function didDoc(id, ka, sig) {
  const vm = [{ id: ka.id, type: 'JsonWebKey2020', controller: id, publicKeyJwk: ka.jwk }];
  const doc = {
    id,
    keyAgreement: [ka.id],
    authentication: [],
    verificationMethod: vm,
    service: [{
      id: `${id}#didcomm`,
      type: 'DIDCommMessaging',
      serviceEndpoint: { uri: `https://example.org/didcomm/${id.split(':').pop()}`, accept: ['didcomm/v2'], routing_keys: [] },
    }],
  };
  if (sig) {
    vm.push({ id: sig.id, type: 'JsonWebKey2020', controller: id, publicKeyJwk: sig.jwk });
    doc.authentication.push(sig.id);
  }
  return doc;
}

const DOCS = {
  [ALICE]: didDoc(ALICE, { id: aliceKAId, jwk: aliceKA.pub }, { id: aliceSigId, jwk: aliceSig.pub }),
  [BOB]: didDoc(BOB, { id: bobKAId, jwk: bobKA.pub }),
};

// --- adapters (the two pieces Phase 2 will back with gatekeeper + wallet) ---
class DIDResolver {
  constructor(docs) { this.docs = docs; }
  async resolve(did) { return this.docs[did] ?? null; }
}
class SecretsResolver {
  constructor(secrets) { this.secrets = secrets; }
  async get_secret(id) { return this.secrets[id] ?? null; }
  async find_secrets(ids) { return ids.filter((i) => i in this.secrets); }
}

const resolver = new DIDResolver(DOCS);
const aliceSecrets = new SecretsResolver({
  [aliceKAId]: { id: aliceKAId, type: 'JsonWebKey2020', privateKeyJwk: aliceKA.priv },
  [aliceSigId]: { id: aliceSigId, type: 'JsonWebKey2020', privateKeyJwk: aliceSig.priv },
});
const bobSecrets = new SecretsResolver({
  [bobKAId]: { id: bobKAId, type: 'JsonWebKey2020', privateKeyJwk: bobKA.priv },
});

const PLAINTEXT = 'hello from Archon over DIDComm';
const makeMsg = (withFrom) => new Message({
  id: 'spike-' + crypto.randomUUID(),
  typ: 'application/didcomm-plain+json',
  type: 'https://example.org/spike/1.0/hello',
  ...(withFrom ? { from: ALICE } : {}),
  to: [BOB],
  body: { text: PLAINTEXT },
  created_time: 1718900000,
});

const opts = { forward: false }; // two-party direct delivery; no mediator routing

const ok = (b) => (b ? 'PASS' : 'FAIL');
const m = (meta) => JSON.stringify(meta);

async function run() {
  console.log('node', process.version, '| didcomm-node', require('didcomm-node/package.json').version);
  console.log('alice KA jwk:', JSON.stringify(aliceKA.pub), '\nalice sig jwk:', JSON.stringify(aliceSig.pub), '\n');

  // 1) anoncrypt (ECDH-ES, anonymous sender)
  {
    const [packed] = await makeMsg(false).pack_encrypted(BOB, null, null, resolver, aliceSecrets, opts);
    const [unpacked, meta] = await Message.unpack(packed, resolver, bobSecrets, {});
    const v = unpacked.as_value();
    console.log('[1] anoncrypt          ', ok(v.body.text === PLAINTEXT && meta.encrypted && !meta.authenticated));
    console.log('    meta:', m(meta));
    console.log('    envelope head:', packed.slice(0, 70), '...\n');
  }

  // 2) authcrypt (ECDH-1PU, authenticated sender via X25519)
  {
    const [packed] = await makeMsg(true).pack_encrypted(BOB, ALICE, null, resolver, aliceSecrets, opts);
    const [unpacked, meta] = await Message.unpack(packed, resolver, bobSecrets, {});
    const v = unpacked.as_value();
    console.log('[2] authcrypt          ', ok(v.body.text === PLAINTEXT && meta.encrypted && meta.authenticated && v.from === ALICE));
    console.log('    meta:', m(meta), '\n');
  }

  // 3) authcrypt + sign with Archon's secp256k1 key (ES256K) — the key Archon-specific claim
  {
    const [packed] = await makeMsg(true).pack_encrypted(BOB, ALICE, aliceSigId, resolver, aliceSecrets, opts);
    const [unpacked, meta] = await Message.unpack(packed, resolver, bobSecrets, {});
    const v = unpacked.as_value();
    console.log('[3] authcrypt+sign ES256K', ok(v.body.text === PLAINTEXT && meta.encrypted && meta.authenticated && meta.non_repudiation && meta.sign_from === aliceSigId));
    console.log('    meta:', m(meta), '\n');
  }

  console.log('DONE');
}

run().catch((e) => { console.error('SPIKE ERROR:', e); process.exit(1); });
