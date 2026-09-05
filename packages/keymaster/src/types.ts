import type { Cipher } from '@didcid/cipher/types';
import type { GatekeeperInterface } from '@didcid/clients/gatekeeper-types';
import type { WalletBase } from '@didcid/clients/keymaster-types';

export type * from '@didcid/clients/keymaster-types';

export interface KeymasterOptions {
    passphrase: string;
    gatekeeper: GatekeeperInterface;
    wallet: WalletBase;
    cipher: Cipher;
    defaultRegistry?: string;
    maxAliasLength?: number;
    // Whether an empty wallet store is a first run or a lost one cannot be
    // decided from the store: both read as absent. So the surface decides.
    // Off by default, because the surfaces that legitimately provision a wallet
    // are few and known, while every other caller reaching an empty store has
    // lost one -- and silently minting a fresh mnemonic there replaces the
    // node's identity. See #1037.
    createWalletIfMissing?: boolean;
}
