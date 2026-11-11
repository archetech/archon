import { jest } from '@jest/globals';
import { Amount, getEncodedToken, PaymentRequest } from '@cashu/cashu-ts';
import {
    CashuPaymentRefusedError,
    CashuPaymentUnavailableError,
    cashuPaymentRequest,
    checkCashuToken,
    keymasterCashuPayments,
    normalizeMintUrl,
} from '../../services/drawbridge/server/src/cashu-payment.ts';

const MINT = 'https://node.example/cashu';

function token(options: { mint?: string; unit?: string; amounts?: number[]; secret?: string } = {}): string {
    return getEncodedToken({
        mint: options.mint ?? MINT,
        unit: options.unit ?? 'sat',
        proofs: (options.amounts ?? [8, 2]).map(amount => ({
            id: '009a1f293253e41e',
            amount: Amount.from(amount),
            secret: options.secret ?? `secret-${amount}`,
            C: '02' + '11'.repeat(32),
        })),
    });
}

describe('cashuPaymentRequest', () => {
    it('asks for the price in sats, once, at the node mint only', () => {
        const encoded = cashuPaymentRequest(21, MINT);
        expect(encoded.startsWith('creqA')).toBe(true);

        const request = PaymentRequest.fromEncodedRequest(encoded);
        expect(request.amount?.toNumber()).toBe(21);
        expect(request.unit).toBe('sat');
        expect(request.mints).toEqual([MINT]);
        expect(request.singleUse).toBe(true);
        // NUT-24 payments travel in the header, so no transport is named.
        expect(request.transport).toBeUndefined();
    });
});

describe('checkCashuToken', () => {
    it('accepts a token from the node mint for at least the price', () => {
        expect(() => checkCashuToken(token(), 10, MINT)).not.toThrow();
        expect(() => checkCashuToken(token(), 7, MINT)).not.toThrow();
    });

    it('accepts the mint URL spelled with a trailing slash or another case of host', () => {
        expect(() => checkCashuToken(token({ mint: 'https://NODE.example/cashu/' }), 10, MINT)).not.toThrow();
    });

    it.each([
        ['not a token', 'cashuBnot-a-token', 'does not hold a Cashu token'],
        ['another mint', token({ mint: 'https://other.example/cashu' }), 'not from the accepted mint'],
        ['another unit', token({ unit: 'usd' }), "unit must be sat"],
        ['too little', token({ amounts: [8] }), 'holds 8 sat; the price is 10 sat'],
        ['a P2PK lock', token({ secret: '["P2PK",{"nonce":"00","data":"02aa"}]' }), 'spending conditions'],
    ])('refuses %s', (_case, value, message) => {
        expect(() => checkCashuToken(value, 10, MINT)).toThrow(CashuPaymentRefusedError);
        expect(() => checkCashuToken(value, 10, MINT)).toThrow(message);
    });
});

describe('normalizeMintUrl', () => {
    it("names a mint as Keymaster's wallet does", () => {
        expect(normalizeMintUrl('https://Node.Example:443/cashu/')).toBe('https://node.example/cashu');
        expect(normalizeMintUrl('not a url')).toBeNull();
    });
});

describe('keymasterCashuPayments', () => {
    function keymaster() {
        return {
            listCashuMints: jest.fn<(name?: string) => Promise<Array<{ url: string; error?: string }>>>(),
            receiveCashu: jest.fn<(token: string, name?: string) => Promise<{ amount: number }>>(),
        };
    }

    it('is ready only while the node identity holds the node mint, checking at most once a minute', async () => {
        const km = keymaster();
        const warn = jest.fn();
        km.listCashuMints.mockResolvedValue([{ url: 'https://other.example/cashu' }]);
        const payments = keymasterCashuPayments(km, 'node-id', MINT, { warn });

        expect(await payments.ready()).toBe(false);
        expect(km.listCashuMints).toHaveBeenCalledWith('node-id');
        expect(warn).toHaveBeenCalledTimes(1);

        km.listCashuMints.mockResolvedValue([{ url: `${MINT}/` }]);
        expect(await payments.ready()).toBe(false);
        expect(km.listCashuMints).toHaveBeenCalledTimes(1);
    });

    it('is ready when the node mint is listed without an error', async () => {
        const km = keymaster();
        km.listCashuMints.mockResolvedValue([{ url: MINT }]);
        expect(await keymasterCashuPayments(km, 'node-id', MINT).ready()).toBe(true);

        const failing = keymaster();
        failing.listCashuMints.mockResolvedValue([{ url: MINT, error: 'mint unreachable' }]);
        expect(await keymasterCashuPayments(failing, 'node-id', MINT).ready()).toBe(false);

        const unreachable = keymaster();
        unreachable.listCashuMints.mockRejectedValue(new Error('connect ECONNREFUSED'));
        expect(await keymasterCashuPayments(unreachable, 'node-id', MINT).ready()).toBe(false);
    });

    it('redeems the token into the node identity and returns what was received', async () => {
        const km = keymaster();
        km.receiveCashu.mockResolvedValue({ amount: 2 });
        expect(await keymasterCashuPayments(km, 'node-id', MINT).redeem('cashuBtoken')).toBe(2);
        expect(km.receiveCashu).toHaveBeenCalledWith('cashuBtoken', 'node-id');
    });

    it('shares one lookup between concurrent readiness checks', async () => {
        const km = keymaster();
        let answer: (mints: Array<{ url: string }>) => void = () => {};
        km.listCashuMints.mockReturnValue(new Promise(resolve => { answer = resolve; }));
        const payments = keymasterCashuPayments(km, 'node-id', MINT);

        const checks = [payments.ready(), payments.ready(), payments.ready()];
        answer([{ url: MINT }]);

        expect(await Promise.all(checks)).toEqual([true, true, true]);
        expect(km.listCashuMints).toHaveBeenCalledTimes(1);
    });

    it('refuses a token Keymaster refuses, passing on its reason', async () => {
        const km = keymaster();
        km.receiveCashu.mockRejectedValue({ error: 'Error: Cashu token already spent' });
        const redeem = keymasterCashuPayments(km, 'node-id', MINT).redeem('cashuBtoken');
        await expect(redeem).rejects.toThrow(CashuPaymentRefusedError);
        await expect(keymasterCashuPayments(km, 'node-id', MINT).redeem('cashuBtoken'))
            .rejects.toThrow('Cashu token already spent');
    });

    it('is unavailable when the mint or Keymaster cannot be reached', async () => {
        const mintDown = keymaster();
        mintDown.receiveCashu.mockRejectedValue({ error: 'Error: Cashu mint unavailable: connect ECONNREFUSED' });
        await expect(keymasterCashuPayments(mintDown, 'node-id', MINT).redeem('cashuBtoken'))
            .rejects.toThrow(CashuPaymentUnavailableError);

        const keymasterDown = keymaster();
        keymasterDown.receiveCashu.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), { request: {} }));
        await expect(keymasterCashuPayments(keymasterDown, 'node-id', MINT).redeem('cashuBtoken'))
            .rejects.toThrow(CashuPaymentUnavailableError);
    });
});
