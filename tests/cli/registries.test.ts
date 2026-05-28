import { archon } from './helpers';

describe('registries', () => {
    test('list-registries prints supported registries one per line', async () => {
        const output = await archon('list-registries');
        const registries = output.split('\n').filter(Boolean);

        expect(registries.length).toBeGreaterThan(0);
        expect(registries.every(registry => registry.length > 0)).toBe(true);
        expect(output).not.toContain('[');
    });
});
