import * as bip39 from 'bip39';
import HDKey from 'hdkey';
import { Wallet } from 'ethers';

export function derivePrivateKey(mnemonic: string, derivationPath: string): string {
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const root = HDKey.fromMasterSeed(seed);
    const child = root.derive(derivationPath);

    if (!child.privateKey) {
        throw new Error(`Could not derive Ethereum private key at ${derivationPath}`);
    }

    return `0x${child.privateKey.toString('hex')}`;
}

export function deriveWallet(mnemonic: string, derivationPath: string): Wallet {
    return new Wallet(derivePrivateKey(mnemonic, derivationPath));
}
