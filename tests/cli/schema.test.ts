import { archon, resetAll, freshWalletWithId, parseDid } from './helpers';

let schemaDid: string;

beforeAll(async () => {
    await freshWalletWithId('qa-schema');
    const output = await archon('create-schema', 'share/schema/social-media.json', 'testing');
    schemaDid = parseDid(output);
});

afterAll(async () => {
    await resetAll();
});

describe('schema management', () => {
    test('create-schema returns a DID', () => {
        expect(schemaDid).toMatch(/^did:cid:[a-zA-Z0-9]+$/);
    });

    test('list-schemas includes the created schema', async () => {
        const output = await archon('list-schemas');
        expect(output).toContain(schemaDid);
    });

    test('get-schema returns schema JSON', async () => {
        const output = await archon('get-schema', schemaDid);
        const schema = JSON.parse(output);

        expect(schema).toHaveProperty('$schema');
        expect(schema).toHaveProperty('type');
        expect(schema).toHaveProperty('properties');
        expect(schema.properties).toHaveProperty('service');
        expect(schema.properties).toHaveProperty('account');
        expect(schema).toHaveProperty('required');
    });

    test('create-schema-template returns a template', async () => {
        const output = await archon('create-schema-template', schemaDid);
        const template = JSON.parse(output);

        expect(template).toHaveProperty('account');
        expect(template).toHaveProperty('service');
        expect(template).toHaveProperty('$schema');
    });
});
