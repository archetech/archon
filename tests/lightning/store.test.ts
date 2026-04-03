import { normalizePublishedLightningKey } from '../../services/mediators/lightning/src/store';

describe('normalizePublishedLightningKey', () => {
    it('returns the DID suffix for a full did:cid identifier', () => {
        expect(normalizePublishedLightningKey('did:cid:bagaaieratestrecipient')).toBe('bagaaieratestrecipient');
    });

    it('returns the original value when given a DID suffix', () => {
        expect(normalizePublishedLightningKey('bagaaieratestrecipient')).toBe('bagaaieratestrecipient');
    });
});
