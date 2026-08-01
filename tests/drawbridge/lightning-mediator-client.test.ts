import { jest } from '@jest/globals';

import {
    checkL402Invoice,
    createL402Invoice,
    deletePendingL402Invoice,
    getPendingL402Invoice,
    savePendingL402Invoice,
} from '../../services/drawbridge/server/src/lightning-mediator-client';
import { LightningUnavailableError } from '../../services/drawbridge/server/src/errors';

const baseUrl = 'http://lightning-mediator:4224';
const originalFetch = global.fetch;

function mockFetch(response: Partial<Response> & { json?: () => Promise<any> }) {
    const fn = jest.fn<any>().mockResolvedValue({ ok: true, status: 200, ...response });
    global.fetch = fn as any;
    return fn;
}

afterEach(() => {
    global.fetch = originalFetch;
});

describe('lightning mediator client requests', () => {
    it('posts an invoice request and returns the parsed body', async () => {
        const invoice = { paymentRequest: 'lnbc1...', paymentHash: 'ab'.repeat(32) };
        const fetchMock = mockFetch({ json: async () => invoice });

        await expect(createL402Invoice(baseUrl, 100, 'memo')).resolves.toEqual(invoice);

        const [url, init] = fetchMock.mock.calls[0];
        expect(String(url)).toBe(`${baseUrl}/api/v1/l402/invoice`);
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({ amountSat: 100, memo: 'memo' });
        expect(init.headers['Content-Type']).toBe('application/json');
    });

    it('posts a payment check', async () => {
        const fetchMock = mockFetch({ json: async () => ({ paid: true }) });

        await expect(checkL402Invoice(baseUrl, 'cd'.repeat(32))).resolves.toEqual({ paid: true });
        expect(String(fetchMock.mock.calls[0][0])).toBe(`${baseUrl}/api/v1/l402/check`);
    });

    it('saves a pending invoice', async () => {
        const fetchMock = mockFetch({ json: async () => ({ ok: true, paymentHash: 'ab' }) });

        await expect(savePendingL402Invoice(baseUrl, { paymentHash: 'ab' } as any))
            .resolves.toEqual({ ok: true, paymentHash: 'ab' });
        expect(String(fetchMock.mock.calls[0][0])).toBe(`${baseUrl}/api/v1/l402/pending`);
    });

    it('deletes a pending invoice, encoding the payment hash', async () => {
        const fetchMock = mockFetch({ json: async () => ({ ok: true }) });

        await expect(deletePendingL402Invoice(baseUrl, 'a/b')).resolves.toBeUndefined();
        expect(String(fetchMock.mock.calls[0][0])).toBe(`${baseUrl}/api/v1/l402/pending/a%2Fb`);
        expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
    });

    it('raises LightningUnavailableError with the upstream error message', async () => {
        mockFetch({ ok: false, status: 503, json: async () => ({ error: 'no route' }) });

        await expect(createL402Invoice(baseUrl, 100, 'memo')).rejects.toThrow(LightningUnavailableError);
        await expect(createL402Invoice(baseUrl, 100, 'memo')).rejects.toThrow('no route');
    });

    it('falls back to the status text when the error body is unreadable', async () => {
        mockFetch({
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
            json: async () => { throw new Error('not json'); },
        });

        await expect(createL402Invoice(baseUrl, 100, 'memo')).rejects.toThrow('Internal Server Error');
    });
});

describe('getPendingL402Invoice', () => {
    it('returns the pending invoice when present', async () => {
        const pending = { paymentHash: 'ab'.repeat(32), did: 'did:cid:abc' };
        const fetchMock = mockFetch({ json: async () => pending });

        await expect(getPendingL402Invoice(baseUrl, 'ab'.repeat(32))).resolves.toEqual(pending);
        expect(String(fetchMock.mock.calls[0][0])).toContain('/api/v1/l402/pending/');
    });

    it('returns null on 404 rather than raising', async () => {
        mockFetch({ ok: false, status: 404 });

        await expect(getPendingL402Invoice(baseUrl, 'ab')).resolves.toBeNull();
    });

    it('raises on any other failure', async () => {
        mockFetch({ ok: false, status: 500, json: async () => ({ error: 'boom' }) });

        await expect(getPendingL402Invoice(baseUrl, 'ab')).rejects.toThrow(LightningUnavailableError);
    });

    it('percent-encodes the payment hash in the path', async () => {
        const fetchMock = mockFetch({ json: async () => ({}) });

        await getPendingL402Invoice(baseUrl, 'a b/c');

        expect(String(fetchMock.mock.calls[0][0])).toBe(`${baseUrl}/api/v1/l402/pending/a%20b%2Fc`);
    });
});
