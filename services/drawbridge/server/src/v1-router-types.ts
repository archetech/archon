import type express from 'express';
import type { Logger } from 'pino';
import type GatekeeperClient from '@didcid/clients/gatekeeper';
import type defaultConfig from './config.js';
import type { L402Options } from './types.js';

export type DrawbridgeApiConfig = typeof defaultConfig;

export interface CreateV1RouterOptions {
    gatekeeper: GatekeeperClient;
    config: DrawbridgeApiConfig;
    logger: Logger;
    l402Options: L402Options;
    authMiddleware: express.RequestHandler[];
    getServiceVersion: () => string;
    serviceCommit: string;
    resolveDidCommEndpoint: () => Promise<string | null>;
    proxyLightningMediatorRequest: (
        req: express.Request,
        res: express.Response,
        prefixToStrip: string,
    ) => Promise<void>;
}
