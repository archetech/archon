import { archon, resetAll, freshWalletWithId, parseDid } from './helpers';

afterAll(async () => {
    await resetAll();
});

describe('encryption', () => {
    test('encrypt-file returns a DID', async () => {
        const did = await freshWalletWithId('qa-encrypt');
        const output = await archon('encrypt-file', 'share/schema/social-media.json', did);
        const encryptedDid = parseDid(output);

        expect(encryptedDid).toMatch(/^did:cid:[a-zA-Z0-9]+$/);
    });
});
