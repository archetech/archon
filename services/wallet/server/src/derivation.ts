import * as bip39 from 'bip39';
import HDKey from 'hdkey';
import type { WalletNetwork } from './config.js';

const MAINNET_VERSIONS = { private: 0x0488ADE4, public: 0x0488B21E }; // xprv / xpub
const TESTNET_VERSIONS = { private: 0x04358394, public: 0x043587CF }; // tprv / tpub

export function getCoinType(network: WalletNetwork): number {
    if (network === 'mainnet') return 0;
    if (network === 'liquid') return 1776;
    return 1;
}

export function getHDKeyVersions(network: WalletNetwork) {
    return (network === 'mainnet' || network === 'liquid')
        ? MAINNET_VERSIONS
        : TESTNET_VERSIONS;
}

export function deriveAccountKey(mnemonic: string, network: WalletNetwork): HDKey {
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const versions = getHDKeyVersions(network);
    const root = HDKey.fromMasterSeed(seed, versions);
    const coinType = getCoinType(network);
    return root.derive(`m/84'/${coinType}'/0'`);
}

export function getMasterFingerprint(mnemonic: string, network: WalletNetwork): string {
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const versions = getHDKeyVersions(network);
    const root = HDKey.fromMasterSeed(seed, versions);
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(root.fingerprint);
    return buf.toString('hex');
}

export function getXpub(mnemonic: string, network: WalletNetwork): string {
    const account = deriveAccountKey(mnemonic, network);
    return account.publicExtendedKey;
}

export function buildDescriptors(
    mnemonic: string,
    network: WalletNetwork,
): { external: string; internal: string } {
    const xpub = getXpub(mnemonic, network);
    const fingerprint = getMasterFingerprint(mnemonic, network);
    const coinType = getCoinType(network);
    const origin = `${fingerprint}/84h/${coinType}h/0h`;

    return {
        external: `wpkh([${origin}]${xpub}/0/*)`,
        internal: `wpkh([${origin}]${xpub}/1/*)`,
    };
}
