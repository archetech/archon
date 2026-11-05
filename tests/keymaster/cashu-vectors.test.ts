import { readFileSync } from 'node:fs';
import * as bip39 from '@scure/bip39';
import {
    OutputData,
    blindMessage,
    createBlindSignature,
    createDLEQProof,
    deriveSecretAndBlindingFactor,
    getDecodedToken,
    getEncodedToken,
    getKeysetIdInt,
    getTokenMetadata,
    hasValidDleq,
    hashToCurve,
    hash_e,
    pointFromHex,
    verifyMintQuoteSignature,
    hasP2PKSignedProof,
} from '@cashu/cashu-ts';
import { normalizeMintUrl, p2pkLock, proofY } from '../../packages/keymaster/src/cashu.ts';
import { CashuMintUnsupportedError } from '@didcid/common/errors';

// The same two files drive python/keymaster/tests/test_cashu_vectors.py. The NUT
// file is the published specification vectors; the generated file is cashu-ts's
// output for fixed inputs, from tests/keymaster/generate-cashu-vectors.mjs.
const nut = JSON.parse(readFileSync('tests/fixtures/cashu-nut-vectors.json', 'utf-8'));
const generated = JSON.parse(readFileSync('tests/fixtures/cashu-generated-vectors.json', 'utf-8'));

const fromHex = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'));
const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const plain = (proof: any) => ({ id: proof.id, amount: Number(proof.amount.toString()), secret: proof.secret, C: proof.C });

describe('NUT specification vectors', () => {
    it('hashes to the curve', () => {
        for (const { message, point } of nut.nut00.hashToCurve) {
            expect(hashToCurve(fromHex(message)).toHex(true)).toBe(point);
        }
    });

    it('blinds', () => {
        for (const { x, r, B_ } of nut.nut00.blind) {
            expect(blindMessage(fromHex(x), BigInt(`0x${r}`)).B_.toHex(true)).toBe(B_);
        }
    });

    it('signs', () => {
        for (const { k, B_, C_ } of nut.nut00.sign) {
            expect(createBlindSignature(pointFromHex(B_), fromHex(k), 'id').C_.toHex(true)).toBe(C_);
        }
    });

    it('decodes V3 tokens, padded or not, and rejects a wrong prefix', () => {
        const { encoded, decoded, invalid, paddedAndNot } = nut.nut00.tokenV3;
        for (const token of [encoded, ...paddedAndNot]) {
            const result = getDecodedToken(token, []);
            expect(result.mint).toBe(decoded.token[0].mint);
            expect(result.proofs.map(plain)).toEqual(decoded.token[0].proofs);
        }
        for (const token of invalid) {
            expect(() => getTokenMetadata(token)).toThrow();
        }
    });

    it('decodes V4 tokens', () => {
        for (const { encoded, mint, proofs, memo } of [nut.nut00.tokenV4.single, nut.nut00.tokenV4.multi]) {
            const result = getDecodedToken(encoded, []);
            expect(result).toMatchObject({ mint, unit: 'sat' });
            expect(result.memo).toBe(memo);
            expect(result.proofs.map(plain)).toEqual(proofs);
        }
    });

    it('computes the DLEQ challenge', () => {
        const { R1, R2, K, C_, hash } = nut.nut12.hashE;
        expect(toHex(hash_e([R1, R2, K, C_].map(pointFromHex)))).toBe(hash);
    });

    it('derives the DLEQ nonce deterministically', () => {
        const { a, B_, e, s } = nut.nut12.deterministic;
        const proof = createDLEQProof(pointFromHex(B_), fromHex(a));
        expect(toHex(proof.e)).toBe(e);
        expect(toHex(proof.s)).toBe(s);
    });

    it('verifies a DLEQ proof on a proof, and rejects a changed one', () => {
        const { A, proof } = nut.nut12.proof;
        const keyset = { id: proof.id, keys: { [proof.amount]: A } };
        expect(hasValidDleq(proof, keyset)).toBe(true);
        const forged = { ...proof, dleq: { ...proof.dleq, s: proof.dleq.e } };
        expect(hasValidDleq(forged, keyset)).toBe(false);
    });

    it('maps a keyset id to its derivation integer', () => {
        const { id, int } = nut.nut13.keysetIdInt;
        expect(Number(getKeysetIdInt(id))).toBe(int);
    });

    it.each(['v00', 'v01'])('derives %s secrets and blinding factors', (version) => {
        const seed = bip39.mnemonicToSeedSync(nut.nut13.mnemonic);
        const { keyset, secrets, rs } = nut.nut13[version];
        secrets.forEach((secret: string, counter: number) => {
            const derived = deriveSecretAndBlindingFactor(seed, keyset, counter);
            expect(toHex(derived.secret)).toBe(secret);
            expect(toHex(derived.blindingFactor)).toBe(rs[counter]);
        });
    });
});

describe.each(['v00', 'v01'])('generated %s vectors', (version) => {
    const vectors = generated[version];

    it('reproduces every output from the mnemonic', () => {
        const seed = bip39.mnemonicToSeedSync(generated.mnemonic);
        for (const output of vectors.outputs) {
            const data = OutputData.createSingleDeterministicData(output.amount, seed, output.counter, vectors.keyset);
            expect(data.blindedMessage.B_).toBe(output.B_);
            const keys = { id: vectors.keyset, keys: { [output.amount]: output.mintPublicKey } };
            const proof = data.toProof(output.signature, keys);
            expect(proof.secret).toBe(output.secret);
            expect(proof.C).toBe(output.C);
            expect(proofY(proof.secret)).toBe(output.Y);
        }
    });

    it('round-trips the token, with its DLEQ proofs', () => {
        const decoded = getDecodedToken(vectors.token, [vectors.keyset]);
        expect(decoded.proofs.map(plain)).toEqual(vectors.tokenProofs.map(plain));
        expect(decoded.proofs.map(proof => proof.dleq)).toEqual(vectors.tokenProofs.map((proof: any) => proof.dleq));
        expect(getEncodedToken(decoded)).toBe(vectors.token);
    });

    it('verifies the NUT-20 signature', () => {
        const { quote, blinded, signature } = vectors.nut20;
        const pubkey = '034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa';
        expect(verifyMintQuoteSignature(pubkey, quote, blinded, signature)).toBe(true);
        expect(verifyMintQuoteSignature(pubkey, `${quote}x`, blinded, signature)).toBe(false);
    });
});

it('normalizes a token\'s mint URL the way the wallet does', () => {
    expect(normalizeMintUrl(getTokenMetadata(nut.nut00.tokenV3.encoded).mint)).toBe('https://8333.space:3338');
});

describe('NUT-11 vectors', () => {
    const p2pk = JSON.parse(readFileSync('tests/fixtures/cashu-p2pk-vectors.json', 'utf-8'));
    const proof = { id: '009a1f293253e41e', amount: 8, C: `02${'00'.repeat(32)}`, secret: p2pk.secret };

    it.each(['typescriptWitness', 'pythonWitness'])('verifies the signature in %s', (field) => {
        expect(hasP2PKSignedProof(p2pk.publicKey, { ...proof, witness: p2pk[field] } as never)).toBe(true);
        expect(hasP2PKSignedProof(p2pk.refundKey, { ...proof, witness: p2pk[field] } as never)).toBe(false);
    });

    it('reads the spending conditions', () => {
        expect(p2pkLock(p2pk.secret)).toEqual(p2pk.conditions);
        for (const other of p2pk.others) {
            expect(p2pkLock(other.secret)).toEqual(other.conditions);
        }
    });

    it.each(['407915bc212be61a77e3e6d2aeb4c727980bda51cd06a6afc29e2861768a7837', '12e5', '123'])('treats %s as an ordinary secret', (secret) => {
        expect(p2pkLock(secret)).toBeUndefined();
    });

    it.each(p2pk.malformed as string[])('refuses the malformed secret %s', (secret) => {
        expect(() => p2pkLock(secret)).toThrow(CashuMintUnsupportedError);
    });

    it('refuses a spending condition it does not implement', () => {
        expect(() => p2pkLock(p2pk.unsupported)).toThrow(CashuMintUnsupportedError);
    });
});
