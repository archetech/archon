import { jest } from '@jest/globals';
import {
    CONFIRM_FALLBACK_HEADER,
    resolveFromConfirmFallback,
    shouldTryConfirmFallback,
} from '../../services/gatekeeper/server/src/confirm-fallback';
import { DidCidDocument } from '@didcid/gatekeeper/types';

const DID = 'did:cid:zTestDid';

function doc(confirmed?: boolean): DidCidDocument {
    return {
        didResolutionMetadata: {},
        didDocument: { id: DID },
        didDocumentMetadata: confirmed === undefined ? {} : { confirmed },
    };
}

describe('confirmed resolution fallback', () => {
    it('should not try fallback when confirm is false', () => {
        expect(shouldTryConfirmFallback(doc(false), { confirm: false }, 'https://peer.example')).toBe(false);
    });

    it('should not try fallback when local DID is already confirmed', () => {
        expect(shouldTryConfirmFallback(doc(true), { confirm: true }, 'https://peer.example')).toBe(false);
    });

    it('should not try fallback without a configured fallback URL', () => {
        expect(shouldTryConfirmFallback(doc(false), { confirm: true }, '')).toBe(false);
    });

    it('should not try fallback on fallback requests', () => {
        expect(shouldTryConfirmFallback(doc(false), { confirm: true }, 'https://peer.example', true)).toBe(false);
    });

    it('should try fallback for unconfirmed local DID with confirm requested', () => {
        expect(shouldTryConfirmFallback(doc(false), { confirm: true }, 'https://peer.example')).toBe(true);
    });

    it('should return confirmed fallback documents', async () => {
        const confirmedDoc = doc(true);
        const fetchImpl = jest.fn(async () => new Response(JSON.stringify(confirmedDoc), { status: 200 }));

        const result = await resolveFromConfirmFallback(
            DID,
            { confirm: true, verify: true, versionSequence: 2, versionTime: '2026-05-14T00:00:00Z' },
            'https://peer.example/',
            1000,
            fetchImpl
        );

        expect(result).toEqual(confirmedDoc);
        expect(fetchImpl).toHaveBeenCalledTimes(1);

        const [url, init] = fetchImpl.mock.calls[0];
        expect(String(url)).toBe('https://peer.example/api/v1/did/did%3Acid%3AzTestDid?versionTime=2026-05-14T00%3A00%3A00Z&versionSequence=2&confirm=true&verify=true');
        expect(init?.headers).toStrictEqual({ [CONFIRM_FALLBACK_HEADER]: '1' });
    });

    it('should ignore unconfirmed fallback documents', async () => {
        const fetchImpl = jest.fn(async () => new Response(JSON.stringify(doc(false)), { status: 200 }));

        await expect(resolveFromConfirmFallback(DID, { confirm: true }, 'https://peer.example', 1000, fetchImpl))
            .resolves
            .toBeNull();
    });

    it('should ignore fallback HTTP errors', async () => {
        const fetchImpl = jest.fn(async () => new Response('nope', { status: 500 }));

        await expect(resolveFromConfirmFallback(DID, { confirm: true }, 'https://peer.example', 1000, fetchImpl))
            .resolves
            .toBeNull();
    });
});
