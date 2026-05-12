import * as bip39 from 'bip39';
import HDKey from 'hdkey';
import { ECPair, address, crypto, networks } from '@bitgo/utxo-lib';
import type { WalletNetwork } from './config.js';

const MAINNET_VERSIONS = { private: 0x0488ADE4, public: 0x0488B21E };
const TESTNET_VERSIONS = { private: 0x04358394, public: 0x043587CF };

export function getCoinType(network: WalletNetwork): number {
    return network === 'mainnet' ? 133 : 1;
}

export function getHDKeyVersions(network: WalletNetwork) {
    return network === 'mainnet' ? MAINNET_VERSIONS : TESTNET_VERSIONS;
}

export function getZcashNetwork(network: WalletNetwork) {
    return network === 'mainnet' ? networks.zcash : networks.zcashTest;
}

export function deriveAccountKey(mnemonic: string, network: WalletNetwork): HDKey {
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const versions = getHDKeyVersions(network);
    const root = HDKey.fromMasterSeed(seed, versions);
    const coinType = getCoinType(network);
    return root.derive(`m/44'/${coinType}'/0'`);
}

export function deriveChildKey(
    mnemonic: string,
    network: WalletNetwork,
    chain: 0 | 1,
    index: number,
): HDKey {
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const versions = getHDKeyVersions(network);
    const root = HDKey.fromMasterSeed(seed, versions);
    const coinType = getCoinType(network);
    return root.derive(`m/44'/${coinType}'/0'/${chain}/${index}`);
}

export function deriveTransparentAddress(
    mnemonic: string,
    network: WalletNetwork,
    chain: 0 | 1,
    index: number,
): string {
    const child = deriveChildKey(mnemonic, network, chain, index);
    if (!child.privateKey) {
        throw new Error(`Could not derive private key at m/44'/${getCoinType(network)}'/0'/${chain}/${index}`);
    }

    const keyPair = ECPair.fromPrivateKey(child.privateKey);
    const hash = crypto.hash160(keyPair.publicKey);
    const zecNetwork = getZcashNetwork(network);
    return address.toBase58Check(hash, zecNetwork.pubKeyHash, zecNetwork);
}

export function deriveAddressRange(
    mnemonic: string,
    network: WalletNetwork,
    chain: 0 | 1,
    count: number,
): string[] {
    return Array.from({ length: count }, (_, index) => deriveTransparentAddress(mnemonic, network, chain, index));
}

export function getXpub(mnemonic: string, network: WalletNetwork): string {
    return deriveAccountKey(mnemonic, network).publicExtendedKey;
}
