import { jest } from '@jest/globals';
import { requireAdminKeyFor } from '../../services/mediators/filecoin-wallet/src/auth.ts';
import { deriveAddress, derivePrivateKey } from '../../services/mediators/filecoin-wallet/src/derivation.ts';

function response() {
    return {
        statusCode: 200,
        body: undefined as unknown,
        status(code: number) {
            this.statusCode = code;
            return this;
        },
        json(payload: unknown) {
            this.body = payload;
            return this;
        },
    };
}

describe('filecoin wallet admin auth', () => {

    it('rejects /wallet/pin requests without an admin key', () => {
        const middleware = requireAdminKeyFor('secret');
        const res = response();
        const next = jest.fn();

        middleware({ headers: {} } as any, res as any, next);

        expect(res.statusCode).toBe(401);
        expect(next).not.toHaveBeenCalled();
    });

    it('accepts /wallet/pin requests with the configured admin key', () => {
        const middleware = requireAdminKeyFor('secret');
        const res = response();
        const next = jest.fn();

        middleware({ headers: { 'x-archon-admin-key': 'secret' } } as any, res as any, next);

        expect(res.statusCode).toBe(200);
        expect(next).toHaveBeenCalledTimes(1);
    });
});

describe('filecoin wallet derivation', () => {

    it('derives a stable Filecoin payment key from a mnemonic', () => {
        const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
        const path = "m/44'/461'/0'/0/0";

        expect(derivePrivateKey(mnemonic, path)).toMatch(/^0x[0-9a-f]{64}$/);
        expect(deriveAddress(mnemonic, path)).toMatch(/^0x[0-9a-fA-F]{40}$/);
        expect(deriveAddress(mnemonic, path)).toBe(deriveAddress(mnemonic, path));
    });
});
