import { Keypair } from '@solana/web3.js';
import { mnemonicToSeedSync } from 'bip39';
import { derivePath } from 'ed25519-hd-key';

export function deriveKeypair(mnemonic: string, derivationPath: string): Keypair {
    const seed = mnemonicToSeedSync(mnemonic);
    const derived = derivePath(derivationPath, seed.toString('hex'));
    return Keypair.fromSeed(derived.key);
}
