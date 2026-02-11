import { archon, resetAll, freshWalletWithId, parseDid } from './helpers';

afterAll(async () => {
    await resetAll();
});

describe('identity management', () => {
    test('create-id returns a DID', async () => {
        await archon('new-wallet');
        const output = await archon('create-id', '-r', 'local', 'qa-create');
        const did = parseDid(output);

        expect(did).toMatch(/^did:cid:[a-zA-Z0-9]+$/);
    });

    test('list-ids shows current ID', async () => {
        await freshWalletWithId('qa-list');
        const output = await archon('list-ids');

        expect(output).toContain('<<< current');
    });

    test('remove-id removes the ID', async () => {
        await freshWalletWithId('qa-remove');
        const output = await archon('remove-id', 'qa-remove');

        expect(output).toContain('ID qa-remove removed');
    });

    test('resolve-id returns DID document', async () => {
        await freshWalletWithId('qa-resolve');
        const output = await archon('resolve-id');
        const doc = JSON.parse(output);

        expect(doc).toHaveProperty('didDocument');
        expect(doc).toHaveProperty('didDocumentMetadata');
        expect(doc.didDocument).toHaveProperty('id');
        expect(doc.didDocument).toHaveProperty('verificationMethod');
        expect(doc.didDocument).toHaveProperty('authentication');

        const vm = doc.didDocument.verificationMethod[0];
        expect(vm).toHaveProperty('controller');
        expect(vm).toHaveProperty('type');
        expect(vm).toHaveProperty('publicKeyJwk');
        expect(vm.publicKeyJwk).toHaveProperty('kty');
        expect(vm.publicKeyJwk).toHaveProperty('crv');
        expect(vm.publicKeyJwk).toHaveProperty('x');
        expect(vm.publicKeyJwk).toHaveProperty('y');
    });

    test('backup-id returns OK', async () => {
        await freshWalletWithId('qa-backup');
        const output = await archon('backup-id');

        expect(output).toContain('OK');
    });

    test('recover-id restores a removed ID', async () => {
        const did = await freshWalletWithId('qa-recover', 'qa');

        await archon('backup-id');
        await archon('remove-id', 'qa-recover');
        const output = await archon('recover-id', did);

        expect(output).toContain('qa-recover');
    });

    test('rotate-keys changes verification keys', async () => {
        await freshWalletWithId('qa-rotate');

        const before = JSON.parse(await archon('resolve-id'));
        const vmBefore = before.didDocument.verificationMethod[0];

        const rotateOutput = await archon('rotate-keys');
        expect(rotateOutput).toContain('OK');

        const after = JSON.parse(await archon('resolve-id'));
        const vmAfter = after.didDocument.verificationMethod[0];

        expect(vmAfter.id).not.toBe(vmBefore.id);
        expect(vmAfter.publicKeyJwk.x).not.toBe(vmBefore.publicKeyJwk.x);
        expect(vmAfter.publicKeyJwk.y).not.toBe(vmBefore.publicKeyJwk.y);
    });
});
