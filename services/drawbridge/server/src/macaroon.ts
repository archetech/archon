import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import macaroonsJs from 'macaroons.js';
import { InvalidMacaroonError } from './errors.js';
import type { L402CaveatSet, L402Token, L402MacaroonData, CaveatContext } from './types.js';

const { MacaroonsBuilder, MacaroonsVerifier } = macaroonsJs;

// --- Caveat encoding/decoding ---

function encodeCaveat(type: string, value: string | number | string[]): string {
    if (Array.isArray(value)) {
        return `${type} = ${value.join(',')}`;
    }
    return `${type} = ${String(value)}`;
}

function decodeCaveat(condition: string): { type: string; value: string } {
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

function conditionsToCaveats(conditions: string[]): L402CaveatSet {
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
        case 'expiry': {
            const expiry = parseInt(value, 10);
            if (!isNaN(expiry)) caveats.expiry = expiry;
            break;
        }
        case 'max_uses': {
            const maxUses = parseInt(value, 10);
            if (!isNaN(maxUses)) caveats.maxUses = maxUses;
            break;
        }
        case 'payment_hash':
            caveats.paymentHash = value;
            break;
        }
    }

    return caveats;
}

function validateCaveatSet(caveats: L402CaveatSet): boolean {
    if (caveats.expiry !== undefined && caveats.expiry <= 0) {
        return false;
    }
    if (caveats.maxUses !== undefined && caveats.maxUses <= 0) {
        return false;
    }
    return !(caveats.scope && caveats.scope.length === 0);
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

// --- Macaroon operations ---

export function createMacaroon(rootSecret: string, location: string, caveats: L402CaveatSet): L402Token {
    if (!validateCaveatSet(caveats)) {
        throw new InvalidMacaroonError('Invalid caveat set');
    }
    const id = randomBytes(16).toString('hex');

    let builder = new MacaroonsBuilder(location, rootSecret, id);

    const conditions = caveatsToConditions(caveats);
    for (const condition of conditions) {
        builder = builder.add_first_party_caveat(condition);
    }

    const macaroon = builder.getMacaroon();
    const serialized = macaroon.serialize();

    return {
        id,
        macaroon: serialized,
    };
}

export function extractCaveats(macaroonStr: string): L402CaveatSet {
    try {
        const macaroon = MacaroonsBuilder.deserialize(macaroonStr);
        const conditions: string[] = [];
        const caveatPackets = macaroon.caveatPackets;

        if (caveatPackets) {
            for (const packet of caveatPackets) {
                if (packet.getValueAsText) {
                    conditions.push(packet.getValueAsText());
                }
            }
        }

        return conditionsToCaveats(conditions);
    } catch (error) {
        throw new InvalidMacaroonError('Failed to extract caveats from macaroon');
    }
}

export function getMacaroonId(macaroonStr: string): string {
    try {
        const macaroon = MacaroonsBuilder.deserialize(macaroonStr);
        return macaroon.identifier;
    } catch {
        throw new InvalidMacaroonError('Malformed macaroon');
    }
}

export function verifyMacaroon(
    rootSecret: string,
    macaroonStr: string,
    context: CaveatContext
): L402MacaroonData {
    try {
        const macaroon = MacaroonsBuilder.deserialize(macaroonStr);
        const verifier = new MacaroonsVerifier(macaroon);

        verifier.satisfyGeneral((caveat: string) => {
            return isCaveatSatisfied(caveat, context);
        });

        const valid = verifier.isValid(rootSecret);
        const caveats = extractCaveats(macaroonStr);

        return {
            id: macaroon.identifier,
            caveats,
            valid,
        };
    } catch (error) {
        if (error instanceof InvalidMacaroonError) {
            throw error;
        }
        throw new InvalidMacaroonError('Failed to verify macaroon');
    }
}

export function verifyPreimage(preimage: string, paymentHash: string): boolean {
    if (!/^[0-9a-f]+$/i.test(preimage) || preimage.length === 0) {
        return false;
    }
    if (!/^[0-9a-f]+$/i.test(paymentHash) || paymentHash.length === 0) {
        return false;
    }
    const hashBuf = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest();
    const expectedBuf = Buffer.from(paymentHash, 'hex');
    if (hashBuf.length !== expectedBuf.length) {
        return false;
    }
    return timingSafeEqual(hashBuf, expectedBuf);
}
