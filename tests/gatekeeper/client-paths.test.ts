import http from 'node:http';
import type { AddressInfo } from 'node:net';
import GatekeeperClient from '@didcid/clients/gatekeeper';
import KeymasterClient from '@didcid/clients/keymaster';
import { segment } from '../../packages/clients/src/path.ts';

// A value put into a request's path is one segment of it, whatever it holds: a
// string in the place of a DID cannot name another of a service's routes. The
// requests are made to a real server, since what matters is the path that
// arrives after the client's own reading of the address.

const TRAVERSAL = 'did:cid:x/../../ipfs/stream/bafyother';

let server: http.Server;
let url: string;
let asked: string[];

beforeAll(async () => {
    server = http.createServer((req, res) => {
        asked.push(`${req.method} ${req.url}`);
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"error":"not found"}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
    asked = [];
});

const tried = async (call: () => Promise<unknown>): Promise<string[]> => {
    await call().catch(() => undefined);

    return asked;
};

describe('a segment of a path', () => {
    it('leaves a DID, a registry and a number as they are', () => {
        expect(segment('did:cid:bagaaieraexample')).toBe('did:cid:bagaaieraexample');
        expect(segment('BTC:mainnet')).toBe('BTC:mainnet');
        expect(segment(12)).toBe('12');
        expect(segment('a..b')).toBe('a..b');
    });

    it('encodes what would end the segment or leave it', () => {
        expect(segment('a/b')).toBe('a%2Fb');
        expect(segment('a?b=c')).toBe('a%3Fb%3Dc');
        expect(segment('a#b')).toBe('a%23b');
        expect(segment('a b')).toBe('a%20b');
        expect(segment('a\\b')).toBe('a%5Cb');
        expect(segment('..')).toBe('%252E%252E');
        expect(segment('.')).toBe('%252E');
    });
});

describe('the Gatekeeper client', () => {
    const client = () => GatekeeperClient.create({ url });

    it('asks for a DID as it was', async () => {
        const gatekeeper = await client();

        expect(await tried(() => gatekeeper.resolveDID('did:cid:bagaaieraexample'))).toStrictEqual(['GET /api/v1/did/did:cid:bagaaieraexample']);
    });

    it('asks for no other route when a string is in the place of a DID', async () => {
        const gatekeeper = await client();

        await tried(() => gatekeeper.resolveDID(TRAVERSAL));
        await tried(() => gatekeeper.resolveDID(TRAVERSAL, { versionSequence: 1 }));
        await tried(() => gatekeeper.resolveDID('..'));

        expect(asked).toStrictEqual([
            'GET /api/v1/did/did:cid:x%2F..%2F..%2Fipfs%2Fstream%2Fbafyother',
            'GET /api/v1/did/did:cid:x%2F..%2F..%2Fipfs%2Fstream%2Fbafyother?versionSequence=1',
            'GET /api/v1/did/%252E%252E',
        ]);
    });

    it('asks for no other route when a string is in the place of a CID, a registry or a block', async () => {
        const gatekeeper = await client();

        await tried(() => gatekeeper.getText('x/../../did/did:cid:y'));
        await tried(() => gatekeeper.getData('x?limit=0'));
        await tried(() => gatekeeper.getJSON('..'));
        await tried(() => gatekeeper.getQueue('BTC:mainnet/../../version'));
        await tried(() => gatekeeper.getBlock('BTC:mainnet', '../../../version' as never));

        expect(asked).toStrictEqual([
            'GET /api/v1/ipfs/text/x%2F..%2F..%2Fdid%2Fdid:cid:y',
            'GET /api/v1/ipfs/data/x%3Flimit%3D0',
            'GET /api/v1/ipfs/json/%252E%252E',
            'GET /api/v1/queue/BTC:mainnet%2F..%2F..%2Fversion',
            'GET /api/v1/block/BTC:mainnet/..%2F..%2F..%2Fversion',
        ]);
    });
});

describe('the Keymaster client', () => {
    const client = () => KeymasterClient.create({ url });

    it('asks for a DID or a name as it was', async () => {
        const keymaster = await client();

        await tried(() => keymaster.resolveDID('did:cid:bagaaieraexample'));
        await tried(() => keymaster.resolveDID('alice'));

        expect(asked).toStrictEqual(['GET /api/v1/did/did:cid:bagaaieraexample', 'GET /api/v1/did/alice']);
    });

    it('asks for no other route when a string is in the place of a DID or a name', async () => {
        const keymaster = await client();

        await tried(() => keymaster.resolveDID('x/../../wallet'));
        await tried(() => keymaster.removeId('../../wallet'));
        await tried(() => keymaster.getAlias('a/b'));
        await tried(() => keymaster.listGroups('did:cid:x&other=1'));

        expect(asked).toStrictEqual([
            'GET /api/v1/did/x%2F..%2F..%2Fwallet',
            'DELETE /api/v1/ids/..%2F..%2Fwallet',
            'GET /api/v1/aliases/a%2Fb',
            'GET /api/v1/groups?owner=did:cid:x%26other%3D1',
        ]);
    });
});
