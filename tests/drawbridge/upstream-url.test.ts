import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

import { proxyHeraldRequest } from '../../services/drawbridge/server/src/herald-proxy.ts';
import { resolveUpstreamUrl } from '../../services/drawbridge/server/src/upstream-url.ts';

describe('resolveUpstreamUrl', () => {
    const BASE = 'http://herald:4230';

    it.each([
        ['/names/name/alice?x=1', '/names', 'http://herald:4230/name/alice?x=1'],
        ['/names', '/names', 'http://herald:4230/'],
        ['/names/', '/names', 'http://herald:4230/'],
        ['/names/a/../b', '/names', 'http://herald:4230/b'],
        ['/names/%2e%2e/b', '/names', 'http://herald:4230/b'],
        ['/explorer/assets/app.js', '', 'http://herald:4230/explorer/assets/app.js'],
    ])('resolves %s (prefix %j) on the upstream', (originalUrl, prefix, expected) => {
        expect(resolveUpstreamUrl(originalUrl, prefix, BASE)?.href).toBe(expected);
    });

    // After the prefix is stripped, each of these is a network-path reference
    // that names a host of its own.
    it.each([
        '/names//attacker.example/x',
        '/names///attacker.example/x',
        '/names/\\attacker.example/x',
        '/names//127.0.0.1:6379/',
        '/names//user@attacker.example/',
        '/names//',
    ])('refuses %s', (originalUrl) => {
        expect(resolveUpstreamUrl(originalUrl, '/names', BASE)).toBeNull();
    });

    it('refuses a path that leaves the origin with no prefix to strip', () => {
        expect(resolveUpstreamUrl('//attacker.example/x', '', BASE)).toBeNull();
    });

    // `..` is not resolved by Express before it matches a mount, but `new URL`
    // resolves it, so a confined mount must refuse a result outside its subtree.
    describe('confineTo keeps the result within the mount subtree', () => {
        const LN = 'http://lightning-mediator:4235';

        it.each([
            ['/api/v1/lightning/l402/pending/abc', '/api/v1/lightning', 'http://lightning-mediator:4235/api/v1/lightning/l402/pending/abc'],
            ['/api/v1/lightning', '/api/v1/lightning', 'http://lightning-mediator:4235/api/v1/lightning'],
            ['/api/v1/lightning/supported', '/api/v1/lightning', 'http://lightning-mediator:4235/api/v1/lightning/supported'],
        ])('allows %s', (originalUrl, confineTo, expected) => {
            expect(resolveUpstreamUrl(originalUrl, '', LN, confineTo)?.href).toBe(expected);
        });

        it.each([
            // traversal to the mediator's admin-gated L402 routes
            '/api/v1/lightning/../l402/pending/abc',
            '/api/v1/lightning/%2e%2e/l402/pending/abc',
            '/api/v1/lightning/a/../../l402/check',
            // a sibling prefix that is not a full segment boundary
            '/api/v1/lightning-other/x',
        ])('refuses %s', (originalUrl) => {
            expect(resolveUpstreamUrl(originalUrl, '', LN, '/api/v1/lightning')).toBeNull();
        });

        it('refuses gatekeeper traversal out of the identifiers subtree', () => {
            expect(resolveUpstreamUrl('/1.0/identifiers/../../api/v1/did', '', 'http://gatekeeper:4224', '/1.0/identifiers')).toBeNull();
        });

        it('treats a trailing slash on confineTo the same way', () => {
            expect(resolveUpstreamUrl('/invoice/..', '', LN, '/invoice/')).toBeNull();
            expect(resolveUpstreamUrl('/invoice/did:x', '', LN, '/invoice/')?.pathname).toBe('/invoice/did:x');
        });
    });
});

// The Herald proxy as deployed, in front of a stand-in Herald and a second
// server standing for any other host the node can reach. Requests go out raw
// because HTTP clients normalize these paths before sending them.
describe('proxyHeraldRequest upstream host', () => {
    let herald: Server;
    let other: Server;
    let drawbridge: Server;
    let otherHits: string[];

    async function listen(server: Server): Promise<number> {
        server.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        return (server.address() as AddressInfo).port;
    }

    function rawGet(path: string): Promise<{ status: number; body: string }> {
        const { port } = drawbridge.address() as AddressInfo;
        return new Promise((resolve, reject) => {
            http.get({ host: '127.0.0.1', port, path }, res => {
                let body = '';
                res.on('data', chunk => { body += chunk; });
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
            }).on('error', reject);
        });
    }

    let otherPort: number;

    beforeAll(async () => {
        otherHits = [];
        herald = http.createServer((_req, res) => res.end('herald'));
        other = http.createServer((req, res) => {
            otherHits.push(req.url ?? '');
            res.end('other host');
        });
        const heraldPort = await listen(herald);
        otherPort = await listen(other);

        const app = express();
        app.use('/names', (req, res) => { void proxyHeraldRequest(req, res, `http://127.0.0.1:${heraldPort}`); });
        // A non-stripping mount, confined to its own subtree on the upstream.
        app.use('/.well-known', (req, res) => { void proxyHeraldRequest(req, res, `http://127.0.0.1:${heraldPort}`, '', '/.well-known'); });
        drawbridge = app.listen(0, '127.0.0.1');
        await new Promise(resolve => drawbridge.once('listening', resolve));
    });

    afterAll(async () => {
        await Promise.all([herald, other, drawbridge].map(server => new Promise(resolve => server.close(resolve))));
    });

    it('still proxies an ordinary path to Herald', async () => {
        expect(await rawGet('/names/name/alice')).toEqual({ status: 200, body: 'herald' });
    });

    it.each(['//', '/\\'])('refuses a path that would reach another host through %j', async (lead) => {
        const response = await rawGet(`/names${lead}127.0.0.1:${otherPort}/secret`);

        expect(response.status).toBe(400);
        expect(response.body).not.toContain('other host');
        expect(otherHits).toEqual([]);
    });

    it('proxies an ordinary path on a confined mount', async () => {
        expect(await rawGet('/.well-known/did.json')).toEqual({ status: 200, body: 'herald' });
    });

    // Express matches the `/.well-known` mount on the raw path, before `..` is
    // resolved; the confinement refuses the escape the proxy would otherwise make.
    it.each([
        '/.well-known/../poppy/secret',
        '/.well-known/%2e%2e/poppy/secret',
    ])('refuses traversal out of a confined mount: %s', async (path) => {
        expect((await rawGet(path)).status).toBe(400);
    });
});
