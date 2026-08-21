import { readFileSync } from 'fs';

// #916: onion delivery broke silently when the base image moved to Node 22.
// socksDispatcher comes from fetch-socks, which builds it on its own undici
// (>=7). Node's *built-in* fetch constructs a v6-era request handler, and the
// newer dispatcher rejects it -- "invalid onRequestStart method" -- surfacing as
// a bare `TypeError: fetch failed` in about 10ms, which reads like an
// unreachable Tor destination rather than a wiring bug.
//
// A real end-to-end test would need a live SOCKS proxy and an onion, so this
// guards the invariant that makes it work: any file that builds a SOCKS
// dispatcher must send it through undici's fetch, not the global one.
const SOCKS_USERS = [
    'services/didcomm/server/src/didcomm-api.ts',
    'services/mediators/lightning/src/lightning-mediator.ts',
    'services/herald/server/src/routes.ts',
];

describe('SOCKS egress (#916)', () => {
    it.each(SOCKS_USERS)('%s imports fetch from undici', path => {
        const source = readFileSync(path, 'utf-8');

        // Guard the guard: if a file stops dispatching over SOCKS this test
        // should be removed rather than passing vacuously.
        expect(source).toContain('socksDispatcher');
        expect(source).toMatch(/import \{ fetch(?: as \w+)? \} from 'undici';/);
    });

    it.each(SOCKS_USERS)('%s declares undici so it shares one copy with fetch-socks', path => {
        // Sharing matters as much as importing: two undici copies with different
        // handler interfaces is the whole bug. Declaring it lets npm dedupe
        // fetch-socks onto the same version instead of nesting its own.
        const pkgPath = `${path.split('/src/')[0]}/package.json`;
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

        expect(pkg.dependencies?.['fetch-socks']).toBeDefined();
        expect(pkg.dependencies?.undici).toBeDefined();
    });
});
