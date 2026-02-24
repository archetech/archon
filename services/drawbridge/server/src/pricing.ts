import type { OperationPricingConfig, OperationPrice } from './types.js';

// Route-to-scope mapping for Gatekeeper API endpoints
const ROUTE_SCOPE_MAP: Record<string, string> = {
    'POST:/api/v1/did': 'createDID',
    'POST:/api/v1/did/generate': 'generateDID',
    'GET:/api/v1/did/:did': 'resolveDID',
    'POST:/api/v1/dids': 'getDIDs',
    'POST:/api/v1/dids/export': 'exportDIDs',
    'POST:/api/v1/dids/import': 'importDIDs',
    'POST:/api/v1/dids/remove': 'removeDIDs',
    'POST:/api/v1/batch/export': 'exportBatch',
    'POST:/api/v1/batch/import': 'importBatch',
    'POST:/api/v1/batch/import/cids': 'importBatchByCids',
    'GET:/api/v1/queue/:registry': 'getQueue',
    'POST:/api/v1/queue/:registry/clear': 'clearQueue',
    'POST:/api/v1/events/process': 'processEvents',
    'GET:/api/v1/registries': 'listRegistries',
    'GET:/api/v1/search': 'searchDIDs',
    'POST:/api/v1/query': 'queryDIDs',
    'POST:/api/v1/ipfs/json': 'addJSON',
    'GET:/api/v1/ipfs/json/:cid': 'getJSON',
    'POST:/api/v1/ipfs/text': 'addText',
    'GET:/api/v1/ipfs/text/:cid': 'getText',
    'POST:/api/v1/ipfs/data': 'addData',
    'GET:/api/v1/ipfs/data/:cid': 'getData',
    'GET:/api/v1/block/:registry/latest': 'getBlock',
    'GET:/api/v1/block/:registry/:blockId': 'getBlock',
    'POST:/api/v1/block/:registry': 'addBlock',
};

function normalizePath(p: string): string {
    return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

// Pre-compute normalized keys for exact match lookup
const NORMALIZED_SCOPE_MAP: Record<string, string> = {};
for (const [pattern, scope] of Object.entries(ROUTE_SCOPE_MAP)) {
    const separatorIdx = pattern.indexOf(':');
    const method = pattern.slice(0, separatorIdx);
    const path = normalizePath(pattern.slice(separatorIdx + 1));
    NORMALIZED_SCOPE_MAP[`${method}:${path}`] = scope;
}

export function routeToScope(method: string, path: string): string {
    const normalizedPath = normalizePath(path);

    // Try exact match first
    const key = `${method}:${normalizedPath}`;
    if (NORMALIZED_SCOPE_MAP[key]) {
        return NORMALIZED_SCOPE_MAP[key];
    }

    // Try parameterized matches
    for (const [pattern, scope] of Object.entries(ROUTE_SCOPE_MAP)) {
        const colonIdx = pattern.indexOf(':');
        const patMethod = pattern.slice(0, colonIdx);
        const patPath = normalizePath(pattern.slice(colonIdx + 1));
        if (patMethod !== method) continue;

        const patParts = patPath.split('/');
        const pathParts = normalizedPath.split('/');

        if (patParts.length !== pathParts.length) continue;

        let match = true;
        for (let i = 0; i < patParts.length; i++) {
            if (patParts[i].startsWith(':')) continue;
            if (patParts[i] !== pathParts[i]) {
                match = false;
                break;
            }
        }

        if (match) return scope;
    }

    return 'unknown';
}

export function getPriceForOperation(
    config: OperationPricingConfig,
    method: string,
    path: string,
): OperationPrice | null {
    const scope = routeToScope(method, path);
    return config.operations[scope] || null;
}

export function loadPricingFromEnv(): OperationPricingConfig {
    const operations: Record<string, OperationPrice> = {};

    const priceCreateDid = process.env.ARCHON_DRAWBRIDGE_PRICE_CREATE_DID;
    if (priceCreateDid) {
        const amount = parseInt(priceCreateDid, 10);
        if (!isNaN(amount) && amount >= 0) {
            operations['createDID'] = { amountSat: amount, description: 'Register a new DID' };
        }
    }

    const priceResolveDid = process.env.ARCHON_DRAWBRIDGE_PRICE_RESOLVE_DID;
    if (priceResolveDid) {
        const amount = parseInt(priceResolveDid, 10);
        if (!isNaN(amount) && amount > 0) {
            operations['resolveDID'] = { amountSat: amount, description: 'Resolve a DID document' };
        }
    }

    // JSON-based pricing config for full control
    const pricingJson = process.env.ARCHON_DRAWBRIDGE_PRICING;
    if (pricingJson) {
        try {
            const parsed = JSON.parse(pricingJson);
            if (parsed.operations) {
                Object.assign(operations, parsed.operations);
            }
        } catch (error) {
            console.warn('Failed to parse ARCHON_DRAWBRIDGE_PRICING JSON:', error);
        }
    }

    return { operations };
}
