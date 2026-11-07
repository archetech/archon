import nock from 'nock';
import { getBalance } from '../../services/mediators/lightning/src/lnbits.ts';
import { LightningUnavailableError } from '../../services/mediators/lightning/src/errors.ts';

const LNBITS = 'http://lnbits.test';

function replies(body: unknown) {
    nock(LNBITS).get('/api/v1/wallet').reply(200, body as nock.Body);
}

afterEach(() => {
    nock.cleanAll();
});

describe('LNbits getBalance', () => {
    it('reports whole sats from the millisatoshi balance', async () => {
        replies({ balance: 1500 });

        await expect(getBalance(LNBITS, 'inkey')).resolves.toBe(1);
    });

    it('reports an empty wallet as zero', async () => {
        replies({ balance: 0 });

        await expect(getBalance(LNBITS, 'inkey')).resolves.toBe(0);
    });

    it('reads balance_msat when balance is absent', async () => {
        replies({ balance_msat: 2000 });

        await expect(getBalance(LNBITS, 'inkey')).resolves.toBe(2);
    });

    it.each([
        ['no balance field', {}],
        ['a null balance', { balance: null }],
        ['a string balance', { balance: '1000' }],
    ])('does not read %s as zero', async (_name, body) => {
        replies(body);

        await expect(getBalance(LNBITS, 'inkey')).rejects.toThrow(LightningUnavailableError);
    });
});
