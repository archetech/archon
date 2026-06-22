import CipherNode from '@didcid/cipher/node';
import {
    aesKeyWrap,
    aesKeyUnwrap,
    packEncrypted,
    unpackEncrypted,
    signJws,
    verifyJws,
    packDidCommMessage,
    unpackDidCommMessage,
    getEnvelopeInfo,
    didKeyToX25519,
    normalizeX25519PublicKey,
    wrapForward,
    parseForward,
    DIDCOMM_FORWARD_TYPE,
} from '../../packages/cipher/src/didcomm.ts';

const cipher = new CipherNode();
const enc = new TextEncoder();
const dec = new TextDecoder();
const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map(b => parseInt(b, 16)));
const toHex = (a: Uint8Array) => Buffer.from(a).toString('hex').toUpperCase();

const ALICE = 'did:cid:alice';
const BOB = 'did:cid:bob';
const aKid = `${ALICE}#key-agreement-1`;
const bKid = `${BOB}#key-agreement-1`;
const aSig = `${ALICE}#key-signing-1`;

const aliceKA = cipher.generateX25519Jwk(new Uint8Array(32).fill(11));
const bobKA = cipher.generateX25519Jwk(new Uint8Array(32).fill(22));
const aliceSig = cipher.generateJwk(new Uint8Array(32).fill(33));

const recipients = [{ kid: bKid, publicJwk: bobKA.publicJwk }];
const bobPriv = { kid: bKid, privateJwk: bobKA.privateJwk };
const sender = { kid: aKid, privateJwk: aliceKA.privateJwk };
const signer = { kid: aSig, privateJwk: aliceSig.privateJwk };

const ENCS = ['XC20P', 'A256CBC-HS512', 'A256GCM'] as const;

describe('AES Key Wrap (A256KW)', () => {
    it('matches the RFC 3394 §4.6 test vector (256-bit KEK, 128-bit key)', () => {
        const kek = hex('000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F');
        const key = hex('00112233445566778899AABBCCDDEEFF');
        expect(toHex(aesKeyWrap(kek, key))).toBe('64E8C3F9CE0F5BA263E9777905818A2A93C8191E7D6E8AE7');
    });

    it('round-trips a 256-bit and 512-bit key', () => {
        const kek = new Uint8Array(32).fill(7);
        for (const len of [32, 64]) {
            const key = new Uint8Array(len).fill(3);
            expect(toHex(aesKeyUnwrap(kek, aesKeyWrap(kek, key)))).toBe(toHex(key));
        }
    });

    it('rejects a tampered wrapped key', () => {
        const kek = new Uint8Array(32).fill(7);
        const wrapped = aesKeyWrap(kek, new Uint8Array(32).fill(3));
        wrapped[10] ^= 0xff;
        expect(() => aesKeyUnwrap(kek, wrapped)).toThrow();
    });
});

describe('packEncrypted / unpackEncrypted', () => {
    it.each(ENCS)('anoncrypt round-trips with %s', (e) => {
        const packed = packEncrypted(enc.encode('hello-' + e), recipients, null, e);
        const { plaintext, header } = unpackEncrypted(packed, bobPriv);
        expect(dec.decode(plaintext)).toBe('hello-' + e);
        expect(header.alg).toBe('ECDH-ES+A256KW');
        expect(header.skid).toBeUndefined();
    });

    it.each(ENCS)('authcrypt round-trips with %s', (e) => {
        const packed = packEncrypted(enc.encode('hi-' + e), recipients, sender, e);
        const { plaintext, header } = unpackEncrypted(packed, bobPriv, aliceKA.publicJwk);
        expect(dec.decode(plaintext)).toBe('hi-' + e);
        expect(header.alg).toBe('ECDH-1PU+A256KW');
        expect(header.skid).toBe(aKid);
    });

    it('produces the expected anoncrypt header shape', () => {
        const packed = packEncrypted(enc.encode('x'), recipients, null, 'XC20P');
        const j = JSON.parse(packed);
        const h = JSON.parse(Buffer.from(j.protected, 'base64url').toString());
        expect(h).toMatchObject({ typ: 'application/didcomm-encrypted+json', alg: 'ECDH-ES+A256KW', enc: 'XC20P' });
        expect(h.epk).toMatchObject({ kty: 'OKP', crv: 'X25519' });
        expect(h.apv).toBeDefined();
        expect(h.apu).toBeUndefined();
        expect(j.recipients[0].header.kid).toBe(bKid);
    });

    it('produces the expected authcrypt header shape (skid + apu)', () => {
        const packed = packEncrypted(enc.encode('x'), recipients, sender, 'A256CBC-HS512');
        const h = JSON.parse(Buffer.from(JSON.parse(packed).protected, 'base64url').toString());
        expect(h.alg).toBe('ECDH-1PU+A256KW');
        expect(h.skid).toBe(aKid);
        expect(Buffer.from(h.apu, 'base64url').toString()).toBe(aKid);
    });

    it('authcrypt requires the sender public key to unpack', () => {
        const packed = packEncrypted(enc.encode('x'), recipients, sender, 'A256CBC-HS512');
        expect(() => unpackEncrypted(packed, bobPriv)).toThrow(/sender public key/);
    });

    it('rejects tampered ciphertext', () => {
        const packed = packEncrypted(enc.encode('secret'), recipients, sender, 'A256CBC-HS512');
        const j = JSON.parse(packed);
        const ct = Buffer.from(j.ciphertext, 'base64url'); ct[0] ^= 0xff;
        j.ciphertext = ct.toString('base64url');
        expect(() => unpackEncrypted(JSON.stringify(j), bobPriv, aliceKA.publicJwk)).toThrow();
    });
});

describe('JWS (ES256K)', () => {
    it('signs and verifies', () => {
        const jws = signJws(enc.encode('payload'), signer);
        const { payload, kid } = verifyJws(jws, aliceSig.publicJwk);
        expect(dec.decode(payload)).toBe('payload');
        expect(kid).toBe(aSig);
    });

    it('fails verification on a tampered payload', () => {
        const jws = JSON.parse(signJws(enc.encode('payload'), signer));
        jws.payload = Buffer.from('tampered').toString('base64url');
        expect(() => verifyJws(JSON.stringify(jws), aliceSig.publicJwk)).toThrow();
    });
});

describe('packDidCommMessage / unpackDidCommMessage', () => {
    const msg = { id: 'm1', typ: 'application/didcomm-plain+json', type: 'https://x/1/hi', to: [BOB], body: { n: 7 } };

    it('anoncrypt message round-trips', () => {
        const packed = packDidCommMessage(msg, recipients);
        const { message, metadata } = unpackDidCommMessage(packed, bobPriv);
        expect(message.body.n).toBe(7);
        expect(metadata).toMatchObject({ encrypted: true, authenticated: false, nonRepudiation: false });
    });

    it('authcrypt message round-trips and reports the sender', () => {
        const packed = packDidCommMessage({ ...msg, from: ALICE }, recipients, { sender });
        const { message, metadata } = unpackDidCommMessage(packed, bobPriv, { senderKey: aliceKA.publicJwk });
        expect(message.body.n).toBe(7);
        expect(metadata).toMatchObject({ encrypted: true, authenticated: true, nonRepudiation: false, sender: aKid });
    });

    it('sign-then-encrypt round-trips with non-repudiation', () => {
        const packed = packDidCommMessage({ ...msg, from: ALICE }, recipients, { sender, signer });
        const { message, metadata } = unpackDidCommMessage(packed, bobPriv, { senderKey: aliceKA.publicJwk, signerKey: aliceSig.publicJwk });
        expect(message.body.n).toBe(7);
        expect(metadata).toMatchObject({ authenticated: true, nonRepudiation: true, signer: aSig });
    });

    it('a signed message without the signer key throws', () => {
        const packed = packDidCommMessage({ ...msg, from: ALICE }, recipients, { sender, signer });
        expect(() => unpackDidCommMessage(packed, bobPriv, { senderKey: aliceKA.publicJwk })).toThrow(/signer public key/);
    });
});

describe('getEnvelopeInfo', () => {
    it('reports anoncrypt envelope info', () => {
        const info = getEnvelopeInfo(packEncrypted(enc.encode('x'), recipients, null, 'XC20P'));
        expect(info).toMatchObject({ type: 'encrypted', alg: 'ECDH-ES+A256KW', kids: [bKid] });
        expect(info.skid).toBeUndefined();
    });

    it('reports authcrypt skid', () => {
        const info = getEnvelopeInfo(packEncrypted(enc.encode('x'), recipients, sender, 'A256CBC-HS512'));
        expect(info).toMatchObject({ type: 'encrypted', alg: 'ECDH-1PU+A256KW', skid: aKid });
    });

    it('detects a signed envelope', () => {
        expect(getEnvelopeInfo(signJws(enc.encode('x'), signer)).type).toBe('signed');
    });
});

describe('did:key resolution (cross-method)', () => {
    // W3C did:key spec vector: this Ed25519 did:key's keyAgreement is the
    // derived X25519 key z6LSj72tK8brWgZja8NLRwPigth2T9QRiG1uH9oKZuKjdh9p.
    const ED_DIDKEY = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';
    const X25519_FRAG = 'z6LSj72tK8brWgZja8NLRwPigth2T9QRiG1uH9oKZuKjdh9p';

    it('derives the spec X25519 keyAgreement from an Ed25519 did:key', () => {
        const { kid, publicJwk } = didKeyToX25519(ED_DIDKEY);
        expect(kid).toBe(`${ED_DIDKEY}#${X25519_FRAG}`);
        expect(publicJwk.kty).toBe('OKP');
        expect(publicJwk.crv).toBe('X25519');
    });

    it('resolves a standalone X25519 did:key to the same key', () => {
        const fromEd = didKeyToX25519(ED_DIDKEY);
        const fromX = didKeyToX25519(`did:key:${X25519_FRAG}`);
        expect(fromX.publicJwk.x).toBe(fromEd.publicJwk.x);
        expect(fromX.kid).toBe(`did:key:${X25519_FRAG}#${X25519_FRAG}`);
    });

    it('rejects a non-did:key', () => {
        expect(() => didKeyToX25519('did:cid:abc')).toThrow(/did:key/);
    });

    it('normalizes publicKeyJwk and publicKeyMultibase to the same X25519 JWK', () => {
        const { publicJwk } = didKeyToX25519(ED_DIDKEY);
        expect(normalizeX25519PublicKey({ publicKeyJwk: publicJwk })).toStrictEqual(publicJwk);
        expect(normalizeX25519PublicKey({ publicKeyMultibase: X25519_FRAG })).toStrictEqual(publicJwk);
    });

    it('rejects non-X25519 JWK material', () => {
        expect(() => normalizeX25519PublicKey({ publicKeyJwk: { kty: 'EC', crv: 'secp256k1', x: 'a', y: 'b' } })).toThrow();
    });
});

describe('Forward (routing/2.0)', () => {
    const med = cipher.generateX25519Jwk(new Uint8Array(32).fill(0x6d));
    const medKid = 'did:cid:mediator#key-agreement-1';

    it('wraps and parses a Forward, preserving the inner envelope for the recipient', () => {
        const inner = packEncrypted(enc.encode('inner-secret'), recipients, null, 'XC20P');
        const outer = wrapForward(inner, bKid, { kid: medKid, publicJwk: med.publicJwk });

        // the mediator (only) can decrypt the outer Forward
        const { plaintext } = unpackEncrypted(outer, { kid: medKid, privateJwk: med.privateJwk });
        const forward = JSON.parse(dec.decode(plaintext));
        expect(forward.type).toBe(DIDCOMM_FORWARD_TYPE);

        const { next, forwardedMessage } = parseForward(dec.decode(plaintext));
        expect(next).toBe(bKid);

        // the inner envelope still decrypts for Bob (the mediator never read it)
        const { plaintext: innerPt } = unpackEncrypted(forwardedMessage, bobPriv);
        expect(dec.decode(innerPt)).toBe('inner-secret');
    });

    it('rejects a non-Forward plaintext', () => {
        expect(() => parseForward(JSON.stringify({ type: 'x/other', body: {} }))).toThrow(/Forward/);
    });
});
