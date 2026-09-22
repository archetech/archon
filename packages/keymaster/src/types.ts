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
    // Node hosts inject socket-level DNS protection; browsers retain URL checks.
    fetchPublicHttps?: (target: string, init?: RequestInit) => Promise<Response>;
}
