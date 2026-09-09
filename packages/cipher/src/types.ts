import type { HDKey } from '@scure/bip32';

export interface HDKeyJSON {
    xpriv: string,
    xpub: string,
    chainCode?: string,
    depth?: number,
    index?: number,
    parentFingerprint?: number,
}

export interface EcdsaJwkPublic {
    kty: 'EC',
    crv: 'secp256k1',
    x: string,
    y: string,
}

export interface EcdsaJwkPrivate extends EcdsaJwkPublic {
    d: string,
}

export interface EcdsaJwkPair {
    publicJwk: EcdsaJwkPublic,
    privateJwk: EcdsaJwkPrivate,
}

export interface OkpJwkPublic {
    kty: 'OKP',
    crv: 'X25519',
    x: string,
}

export interface OkpJwkPrivate extends OkpJwkPublic {
    d: string,
}

export interface OkpJwkPair {
    publicJwk: OkpJwkPublic,
    privateJwk: OkpJwkPrivate,
}

// Ed25519 signing keys. Kept apart from the Okp* triple above, which is pinned
// to X25519 for key agreement -- the two curves are never interchangeable and
// widening `crv` there would loosen every DIDComm consumer of it.
export interface Ed25519JwkPublic {
    kty: 'OKP',
    crv: 'Ed25519',
    x: string,
}

export interface Ed25519JwkPrivate extends Ed25519JwkPublic {
    d: string,
}

export interface Ed25519JwkPair {
    publicJwk: Ed25519JwkPublic,
    privateJwk: Ed25519JwkPrivate,
}

export interface NostrKeys {
    npub: string,
    pubkey: string,
}

export interface NostrEvent {
    id?: string,
    pubkey?: string,
    created_at: number,
    kind: number,
    tags: string[][],
    content: string,
    sig?: string,
}

export interface ProofOfWork {
    difficulty: number,
    nonce: string,
}

export interface Cipher {
    generateMnemonic(): string,

    generateHDKey(mnemonic: string): HDKey,
    generateHDKeyJSON(json: HDKeyJSON): HDKey,

    generateJwk(privateKeyBytes: Uint8Array): EcdsaJwkPair,
    generateRandomJwk(): EcdsaJwkPair,
    generateX25519Jwk(seedBytes: Uint8Array): OkpJwkPair,
    generateEd25519Jwk(seedBytes: Uint8Array): Ed25519JwkPair,
    signEd25519(message: Uint8Array, privateJwk: Ed25519JwkPrivate): Uint8Array,
    verifyEd25519(message: Uint8Array, signature: Uint8Array, publicJwk: Ed25519JwkPublic): boolean,
    convertJwkToCompressedBytes(jwk: EcdsaJwkPublic): Uint8Array,
    jwkToNostr(publicJwk: EcdsaJwkPublic): NostrKeys,
    nsecToJwk(nsec: string): EcdsaJwkPair,

    hashMessage(msg: string | Uint8Array): string,
    // eddsa-jcs-2022 canonicalizes the proof config and the document
    // separately, so callers holding this interface need the step on its own
    // rather than only through hashJSON.
    canonicalizeJSON(json: unknown): string,
    hashJSON(obj: unknown): string,

    signHash(msgHash: string, privateJwk: EcdsaJwkPrivate): string,
    signSchnorr(msgHash: string, privateJwk: EcdsaJwkPrivate): string,
    verifySig(msgHash: string, sigHex: string, publicJwk: EcdsaJwkPublic): boolean,

    jwkToNsec(privateJwk: EcdsaJwkPrivate): string,

    encryptBytes(
        recipientPubKey: EcdsaJwkPublic,
        data: Uint8Array,
    ): string,

    decryptBytes(
        recipientPrivKey: EcdsaJwkPrivate,
        ciphertext: string,
        legacyPubKey?: EcdsaJwkPublic,
    ): Uint8Array,

    encryptMessage(
        recipientPubKey: EcdsaJwkPublic,
        message: string,
    ): string,

    decryptMessage(
        recipientPrivKey: EcdsaJwkPrivate,
        ciphertext: string,
        legacyPubKey?: EcdsaJwkPublic,
    ): string,

    decryptBytesLegacy(
        pubKey: EcdsaJwkPublic,
        privKey: EcdsaJwkPrivate,
        ciphertext: string,
    ): Uint8Array,

    decryptMessageLegacy(
        pubKey: EcdsaJwkPublic,
        privKey: EcdsaJwkPrivate,
        ciphertext: string,
    ): string,

    generateRandomSalt(): string,

    addProofOfWork(obj: unknown, difficulty: number): unknown,
    checkProofOfWork(obj: unknown): boolean,
}
