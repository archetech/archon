import { timingSafeEqual } from 'crypto';
import type { L402CaveatSet, CaveatContext } from './types.js';

export type { CaveatContext } from './types.js';

export function encodeCaveat(type: string, value: string | number | string[]): string {
    if (Array.isArray(value)) {
        return `${type} = ${value.join(',')}`;
    }
    return `${type} = ${String(value)}`;
}

export function decodeCaveat(condition: string): { type: string; value: string } {
    const eqIndex = condition.indexOf('=');
    if (eqIndex === -1) {
        throw new Error(`Invalid caveat format: ${condition}`);
    }
    const type = condition.slice(0, eqIndex).trim();
    const value = condition.slice(eqIndex + 1).trim();
    return { type, value };
}

export function caveatsToConditions(caveats: L402CaveatSet): string[] {
    const conditions: string[] = [];

    if (caveats.did) {
        conditions.push(encodeCaveat('did', caveats.did));
    }
    if (caveats.scope && caveats.scope.length > 0) {
        conditions.push(encodeCaveat('scope', caveats.scope));
    }
    if (caveats.expiry !== undefined) {
        conditions.push(encodeCaveat('expiry', caveats.expiry));
    }
    if (caveats.maxUses !== undefined) {
        conditions.push(encodeCaveat('max_uses', caveats.maxUses));
    }
    if (caveats.paymentHash) {
        conditions.push(encodeCaveat('payment_hash', caveats.paymentHash));
    }

    return conditions;
}

export function conditionsToCaveats(conditions: string[]): L402CaveatSet {
    const caveats: L402CaveatSet = {};

    for (const condition of conditions) {
        const { type, value } = decodeCaveat(condition);
        switch (type) {
        case 'did':
            caveats.did = value;
            break;
        case 'scope':
            caveats.scope = value.split(',').map(s => s.trim());
            break;
        case 'expiry':
            caveats.expiry = parseInt(value, 10);
            break;
        case 'max_uses':
            caveats.maxUses = parseInt(value, 10);
            break;
        case 'payment_hash':
            caveats.paymentHash = value;
            break;
        }
    }

    return caveats;
}

export function validateCaveatSet(caveats: L402CaveatSet): boolean {
    if (caveats.expiry !== undefined && caveats.expiry <= 0) {
        return false;
    }
    if (caveats.maxUses !== undefined && caveats.maxUses <= 0) {
        return false;
    }
    if (caveats.scope && caveats.scope.length === 0) {
        return false;
    }
    return true;
}

export function isCaveatSatisfied(condition: string, context: CaveatContext): boolean {
    const { type, value } = decodeCaveat(condition);

    switch (type) {
    case 'did':
        return context.did === value;

    case 'scope': {
        if (!context.scope) return false;
        const allowedScopes = value.split(',').map(s => s.trim());
        return allowedScopes.includes(context.scope);
    }

    case 'expiry': {
        const expiryTime = parseInt(value, 10);
        const now = context.currentTime ?? Math.floor(Date.now() / 1000);
        return now < expiryTime;
    }

    case 'max_uses': {
        const maxUses = parseInt(value, 10);
        const currentUses = context.currentUses ?? 0;
        return currentUses < maxUses;
    }

    case 'payment_hash': {
        if (!context.paymentHash || context.paymentHash.length !== value.length) return false;
        const a = Buffer.from(context.paymentHash, 'hex');
        const b = Buffer.from(value, 'hex');
        if (a.length !== b.length) return false;
        return timingSafeEqual(a, b);
    }

    default:
        return false;
    }
}
