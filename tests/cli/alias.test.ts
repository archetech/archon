import { archon, resetAll, freshWalletWithId, parseDid } from './helpers';

afterAll(async () => {
    await resetAll();
});

describe('alias management', () => {
    test('add-alias and list-aliases', async () => {
        const did = await freshWalletWithId('qa-alias');

        const addOutput = await archon('add-alias', 'qa', did);
        expect(addOutput).toContain('OK');

        const listOutput = await archon('list-aliases');
        expect(listOutput).toContain('qa');
    });

    test('remove-alias removes the alias', async () => {
        const did = await freshWalletWithId('qa-alias-rm');

        await archon('add-alias', 'qa', did);
        const removeOutput = await archon('remove-alias', 'qa');
        expect(removeOutput).toContain('OK');

        const listOutput = await archon('list-aliases');
        expect(listOutput).not.toContain('qa');
    });
});
