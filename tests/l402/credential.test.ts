import { L402AccessCredentialSchema, buildL402AccessClaims } from '../../packages/l402/src/credential.js';

describe('L402 Credential', () => {

    describe('L402AccessCredentialSchema', () => {
        it('should have the correct credential type', () => {
            expect(L402AccessCredentialSchema.$credentialType).toEqual([
                'VerifiableCredential',
                'L402AccessCredential',
            ]);
        });

        it('should have the correct context', () => {
            expect(L402AccessCredentialSchema.$credentialContext).toEqual([
                'https://www.w3.org/ns/credentials/v2',
            ]);
        });

        it('should require all necessary fields', () => {
            expect(L402AccessCredentialSchema.required).toContain('paymentMethod');
            expect(L402AccessCredentialSchema.required).toContain('paymentHash');
            expect(L402AccessCredentialSchema.required).toContain('amountSat');
            expect(L402AccessCredentialSchema.required).toContain('scope');
            expect(L402AccessCredentialSchema.required).toContain('macaroonId');
        });

        it('should define paymentMethod as enum', () => {
            expect(L402AccessCredentialSchema.properties.paymentMethod.enum).toEqual([
                'lightning',
                'cashu',
            ]);
        });

        it('should define scope as an array of strings', () => {
            expect(L402AccessCredentialSchema.properties.scope.type).toBe('array');
            expect(L402AccessCredentialSchema.properties.scope.items.type).toBe('string');
        });
    });

    describe('buildL402AccessClaims', () => {
        it('should build claims from payment info', () => {
            const claims = buildL402AccessClaims(
                {
                    method: 'lightning',
                    paymentHash: 'abc123',
                    amountSat: 100,
                },
                'mac-001',
                ['resolveDID', 'getDIDs']
            );

            expect(claims.paymentMethod).toBe('lightning');
            expect(claims.paymentHash).toBe('abc123');
            expect(claims.amountSat).toBe(100);
            expect(claims.scope).toEqual(['resolveDID', 'getDIDs']);
            expect(claims.macaroonId).toBe('mac-001');
        });

        it('should build claims for cashu payment', () => {
            const claims = buildL402AccessClaims(
                {
                    method: 'cashu',
                    paymentHash: 'def456',
                    amountSat: 50,
                },
                'mac-002',
                ['createDID']
            );

            expect(claims.paymentMethod).toBe('cashu');
            expect(claims.amountSat).toBe(50);
        });
    });
});
