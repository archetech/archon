import type { Cipher } from '@didcid/cipher/types';
import type { GatekeeperInterface } from '@didcid/clients/gatekeeper';
import type { WalletBase } from '@didcid/clients/keymaster';

export * from '@didcid/clients/keymaster';

export interface KeymasterOptions {
    passphrase: string;
    gatekeeper: GatekeeperInterface;
    wallet: WalletBase;
    cipher: Cipher;
    defaultRegistry?: string;
    maxAliasLength?: number;
}
