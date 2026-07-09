import type Gatekeeper from '@didcid/gatekeeper';
import type promClient from 'prom-client';
import type pino from 'pino';
import type defaultConfig from './config.js';

export type GatekeeperApiConfig = typeof defaultConfig;
export type DidOperationsCounter = promClient.Counter<'operation' | 'registry' | 'status'>;

export interface CreateV1RouterOptions {
    gatekeeper: Gatekeeper;
    config: GatekeeperApiConfig;
    logger: Pick<pino.Logger, 'error'>;
    isReady: () => boolean;
    getStatus: () => Promise<unknown>;
    didOperationsTotal: DidOperationsCounter;
}
