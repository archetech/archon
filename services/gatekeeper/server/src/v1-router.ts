import express from 'express';
import type { CreateV1RouterOptions } from './v1-router-types.js';
import { createHealthRouter } from './v1-health-router.js';
import { createDidRouter } from './v1-did-router.js';
import { createSyncRouter } from './v1-sync-router.js';
import { createIpfsRouter } from './v1-ipfs-router.js';
import { createBlockRouter } from './v1-block-router.js';
import { createSearchRouter } from './v1-search-router.js';

export type { CreateV1RouterOptions } from './v1-router-types.js';

export function createV1Router(options: CreateV1RouterOptions): express.Router {
    const router = express.Router();

    router.use(createHealthRouter(options));
    router.use(createDidRouter(options));
    router.use(createSyncRouter(options));
    router.use(createIpfsRouter(options));
    router.use(createBlockRouter(options));
    router.use(createSearchRouter(options));

    return router;
}
