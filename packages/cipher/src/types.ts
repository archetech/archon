import type HDKeyNode from 'hdkey';
import type HDKeyBrowser from '@didcid/browser-hdkey';

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

export interface NostrKeys {
    npub: string,
    pubkey: string,
}

export interface ProofOfWork {
    difficulty: number,
    nonce: string,
}

export interface Cipher {
    generateMnemonic(): string,

    generateHDKey(mnemonic: string): HDKeyNode | HDKeyBrowser,
    generateHDKeyJSON(json: HDKeyJSON): HDKeyNode | HDKeyBrowser,

    generateJwk(privateKeyBytes: Uint8Array): EcdsaJwkPair,
    generateRandomJwk(): EcdsaJwkPair,
    convertJwkToCompressedBytes(jwk: EcdsaJwkPublic): Uint8Array,
    jwkToNostr(publicJwk: EcdsaJwkPublic): NostrKeys,

    hashMessage(msg: string | Uint8Array): string,
    hashJSON(obj: unknown): string,

    signHash(msgHash: string, privateJwk: EcdsaJwkPrivate): string,
    verifySig(msgHash: string, sigHex: string, publicJwk: EcdsaJwkPublic): boolean,

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
