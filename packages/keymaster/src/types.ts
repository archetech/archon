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
    // Sign operation proofs under archon-ecdsa-jcs-2019, which puts the proof
    // configuration inside the signature (#1087). Off by default: every node
    // has to accept the form before any wallet emits it, and a node that has
    // not upgraded refuses the operation outright. See #1125.
    boundOperationProofs?: boolean;
}
