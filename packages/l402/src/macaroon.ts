import macaroonsJs from 'macaroons.js';
const { MacaroonsBuilder, MacaroonsVerifier } = macaroonsJs;
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { caveatsToConditions, conditionsToCaveats, isCaveatSatisfied, validateCaveatSet } from './caveats.js';
import { InvalidMacaroonError } from './errors.js';
import type { L402CaveatSet, L402Token, L402MacaroonData, CaveatContext } from './types.js';

export function generateMacaroonId(): string {
    return randomBytes(16).toString('hex');
}

export function createMacaroon(rootSecret: string, location: string, caveats: L402CaveatSet): L402Token {
    if (!validateCaveatSet(caveats)) {
        throw new InvalidMacaroonError('Invalid caveat set');
    }
    const id = generateMacaroonId();

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
                // CaveatPacket has type and rawValue
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

export function verifyMacaroon(
    rootSecret: string,
    macaroonStr: string,
    context: CaveatContext
): L402MacaroonData {
    try {
        const macaroon = MacaroonsBuilder.deserialize(macaroonStr);
        const verifier = new MacaroonsVerifier(macaroon);

        // Add a general satisfier that checks each caveat against our context
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
    const hashBuf = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest();
    const expectedBuf = Buffer.from(paymentHash, 'hex');
    if (hashBuf.length !== expectedBuf.length) {
        return false;
    }
    return timingSafeEqual(hashBuf, expectedBuf);
}
