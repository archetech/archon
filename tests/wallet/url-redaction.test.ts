import { redactUrl } from '../../services/mediators/satoshi-wallet/src/url-redaction';

describe('redactUrl', () => {
    it('redacts Alchemy path keys', () => {
        expect(redactUrl('https://bitcoin-testnet4.g.alchemy.com/v2/secret-key/api/v2')).toBe(
            'https://bitcoin-testnet4.g.alchemy.com/v2/<redacted>/api/v2',
        );
    });

    it('removes userinfo and query strings', () => {
        expect(redactUrl('https://user:pass@example.com/rpc?apiKey=secret&x=1')).toBe(
            'https://example.com/rpc',
        );
    });
});
