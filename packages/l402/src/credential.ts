import type { L402AccessCredentialSubject } from './types.js';

export const L402AccessCredentialSchema = {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "$credentialType": ["VerifiableCredential", "L402AccessCredential"],
    "$credentialContext": ["https://www.w3.org/ns/credentials/v2"],
    "properties": {
        "paymentMethod": {
            "type": "string",
            "enum": ["lightning", "cashu"]
        },
        "paymentHash": {
            "type": "string"
        },
        "amountSat": {
            "type": "number"
        },
        "scope": {
            "type": "array",
            "items": { "type": "string" }
        },
        "macaroonId": {
            "type": "string"
        }
    },
    "required": ["paymentMethod", "paymentHash", "amountSat", "scope", "macaroonId"]
};

export function buildL402AccessClaims(
    payment: { method: 'lightning' | 'cashu'; paymentHash: string; amountSat: number },
    macaroonId: string,
    scope: string[]
): L402AccessCredentialSubject {
    return {
        paymentMethod: payment.method,
        paymentHash: payment.paymentHash,
        amountSat: payment.amountSat,
        scope,
        macaroonId,
    };
}
