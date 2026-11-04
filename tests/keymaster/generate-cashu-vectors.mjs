// Writes tests/fixtures/cashu-generated-vectors.json: what cashu-ts produces for
// fixed inputs, which the Python port must reproduce byte for byte. Mint keys are
// derived from a fixed seed, so the file only changes if cashu-ts's cryptography
// or token encoding does.
//
//   node tests/keymaster/generate-cashu-vectors.mjs

import { writeFileSync } from 'node:fs';
import * as bip39 from '@scure/bip39';
import {
    OutputData,
    createBlindSignature,
    createDLEQProof,
    createNewMintKeys,
    getEncodedToken,
    hashToCurve,
    pointFromHex,
    serializeMintKeys,
    signMintQuote,
} from '@cashu/cashu-ts';

const MNEMONIC = 'half depart obvious quality work element tank gorilla view sugar picture humble';
const MINT = 'https://mint.example/cashu';

const toHex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

function scenario(keyset, amounts) {
    const seed = bip39.mnemonicToSeedSync(MNEMONIC);
    const keys = { id: keyset.keysetId, keys: serializeMintKeys(keyset.pubKeys) };
    const outputs = amounts.map((amount, counter) => {
        const data = OutputData.createSingleDeterministicData(amount, seed, counter, keyset.keysetId);
        const B_ = pointFromHex(data.blindedMessage.B_);
        const { C_ } = createBlindSignature(B_, keyset.privKeys[amount], keyset.keysetId);
        const dleq = createDLEQProof(B_, keyset.privKeys[amount]);
        const signature = {
            id: keyset.keysetId,
            amount,
            C_: C_.toHex(true),
            dleq: { e: toHex(dleq.e), s: toHex(dleq.s) },
        };
        const proof = data.toProof(signature, keys);
        return {
            counter,
            amount,
            B_: data.blindedMessage.B_,
            mintKey: toHex(keyset.privKeys[amount]),
            mintPublicKey: keys.keys[amount],
            signature,
            secret: proof.secret,
            r: proof.dleq.r,
            Y: hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true),
            C: proof.C,
        };
    });

    const proofs = outputs.map(output => ({
        id: keyset.keysetId,
        amount: output.amount,
        secret: output.secret,
        C: output.C,
        dleq: { ...output.signature.dleq, r: output.r },
    }));
    const quote = `quote-${keyset.keysetId.slice(0, 8)}`;
    const blinded = outputs.map(output => ({ amount: output.amount, id: keyset.keysetId, B_: output.B_ }));
    const quoteKey = '11'.repeat(32);

    return {
        keyset: keyset.keysetId,
        outputs,
        token: getEncodedToken({ mint: MINT, unit: 'sat', proofs }),
        tokenWithoutDleq: getEncodedToken({ mint: MINT, unit: 'sat', proofs }, { removeDleq: true }),
        tokenProofs: proofs,
        // BIP-340 signing uses fresh auxiliary randomness, so this is checked by
        // verifying it, not by comparing bytes.
        nut20: { quote, blinded, quoteKey, signature: signMintQuote(quoteKey, quote, blinded) },
    };
}

const seedByte = fill => new Uint8Array(32).fill(fill);
const vectors = {
    mnemonic: MNEMONIC,
    mint: MINT,
    v01: scenario(createNewMintKeys(8, seedByte(7), { input_fee_ppk: 0, unit: 'sat' }), [1, 2, 4, 8]),
    v00: scenario(createNewMintKeys(8, seedByte(9), { input_fee_ppk: 0, unit: 'sat', versionByte: 0 }), [1, 2, 4, 8]),
};

writeFileSync('tests/fixtures/cashu-generated-vectors.json', `${JSON.stringify(vectors, null, 2)}\n`);
