import { archon, archonFails } from './helpers.ts';

// A command that reports a failure has to fail the process too, or
// `archon create-id alice && next` runs next after alice failed (#1054).
// Asserted against the real binary, since the status is what a shell sees and
// nothing about it is visible from the output.

describe('exit status', () => {
    test('a command that cannot do what it was asked exits non-zero', async () => {
        const { status, stderr } = await archonFails('resolve-did', 'did:cid:doesnotexist');

        expect(status).toBe(1);
        expect(stderr).toContain('cannot resolve did:cid:doesnotexist');
    });

    test('a command that succeeds exits zero', async () => {
        // archon() rejects on a non-zero status, so reaching the assertion at
        // all is the check. Which registries a node reports is its own
        // configuration, so only that it reported some is asserted here.
        const output = await archon('list-registries');

        expect(output.split('\n').filter(Boolean).length).toBeGreaterThan(0);
    });
});
