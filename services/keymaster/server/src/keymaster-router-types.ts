import type DrawbridgeClient from '@didcid/gatekeeper/drawbridge';
import type Keymaster from '@didcid/keymaster';
import type promClient from 'prom-client';
import type defaultConfig from './config.js';

export type KeymasterApiConfig = typeof defaultConfig;
export type WalletOperationsCounter = promClient.Counter<'operation' | 'status'>;

export interface CreateKeymasterRouterOptions {
    getKeymaster: () => Keymaster;
    getGatekeeper: () => DrawbridgeClient;
    config: KeymasterApiConfig;
    walletOperationsTotal: WalletOperationsCounter;
    didNotFound: { error: string };
    isReady: () => boolean;
    getServiceVersion: () => string;
    serviceCommit: string;
}
