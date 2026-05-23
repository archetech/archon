import * as bip39 from 'bip39';
import HDKey from 'hdkey';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

export function derivePrivateKey(mnemonic: string, derivationPath: string): `0x${string}` {
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const root = HDKey.fromMasterSeed(seed);
    const child = root.derive(derivationPath);

    if (!child.privateKey) {
        throw new Error(`Could not derive Filecoin private key at ${derivationPath}`);
    }

    return `0x${child.privateKey.toString('hex')}`;
}

export function deriveAddress(mnemonic: string, derivationPath: string): string {
    const privateKey = derivePrivateKey(mnemonic, derivationPath);
    const publicKey = secp256k1.getPublicKey(Buffer.from(privateKey.slice(2), 'hex'), false);
    const address = keccak_256(publicKey.slice(1)).slice(-20);
    return `0x${Buffer.from(address).toString('hex')}`;
}
