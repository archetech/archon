import Gatekeeper from '@didcid/gatekeeper';
import Keymaster from '@didcid/keymaster';
import CipherNode from '@didcid/cipher/node';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import WalletJsonMemory from '@didcid/keymaster/wallet/json-memory';
import HeliaClient from '@didcid/ipfs/helia';
import { readFileSync } from 'fs';
import { jest } from '@jest/globals';
import { isPrivateHostname, fetchPublicHttps } from '@didcid/common/net';

// Remote name lookup fetches https://<domain>/.well-known/names from a domain
// the caller supplies, which makes the target check the only thing standing
// between the API and the host's own network (#252).
//
// The check this replaced was a prefix regex -- /^(localhost|127\.|10\.|...)/ --
// so it read the start of the string rather than the address. Every case in the
// first list below walked straight past it, including 169.254.169.254, the
// cloud metadata address the issue named first.

// Cases come from a fixture the Python suite reads too. When each port kept its
// own list they agreed on everything either had thought of and diverged on six
// neither had -- the IPv4 documentation ranges, IPv6 multicast, and 2001:db8::/32
// (#252). A shared list is the only thing that makes "the ports agree" checkable
// rather than asserted.
const fixture = JSON.parse(readFileSync('tests/fixtures/private-hostnames.json', 'utf-8')) as {
    blocked: string[];
    allowed: string[];
};

describe('isPrivateHostname', () => {
    it('has cases to check', () => {
        // Guard the guard: an empty fixture would make both checks vacuous.
        expect(fixture.blocked.length).toBeGreaterThan(30);
        expect(fixture.allowed.length).toBeGreaterThan(10);
    });

    it.each(fixture.blocked)('rejects %j', (hostname) => {
        expect(isPrivateHostname(hostname)).toBe(true);
    });

    // A guard that also blocks what it exists to permit is not usable, and the
    // neighbours of the blocked ranges are the easy mistake: 11.x is not 10.x,
    // 172.32 is outside the /12, 169.253 is not link-local.
    it.each(fixture.allowed)('allows %j', (hostname) => {
        expect(isPrivateHostname(hostname)).toBe(false);
    });
});

// The unit tests above prove the predicate. These prove it is actually reached:
// it used to be defined once and called once, on a private method, while the
// three public entry points that fetch a caller-supplied host went unchecked.
describe('the public lookup methods reject private targets', () => {
    let ipfs: HeliaClient;
    let keymaster: Keymaster;

    beforeAll(async () => {
        ipfs = new HeliaClient();
        await ipfs.start();
    });

    afterAll(async () => {
        if (ipfs) {
            await ipfs.stop();
        }
    });

    beforeEach(async () => {
        const db = new DbJsonMemory('test');
        const gatekeeper = new Gatekeeper({ db, ipfs, registries: ['local', 'hyperswarm'] });
        keymaster = new Keymaster({
            gatekeeper,
            wallet: new WalletJsonMemory(),
            cipher: new CipherNode(),
            passphrase: 'passphrase',
        });
        await keymaster.createId('Alice', { registry: 'local' });
    });

    const targets = ['127.0.0.1', 'localhost', '169.254.169.254', '2130706433', '[::1]', 'metadata.google.internal'];

    // Matching the message, not just "it threw". A lookup of 127.0.0.1 with no
    // server behind it throws either way, so a bare toThrow() would pass with
    // the guard removed and prove nothing.
    const refused = /Invalid parameter: domain/;

    it.each(targets)('getAddress refuses %s', async (host) => {
        await expect(keymaster.getAddress(host)).rejects.toThrow(refused);
    });

    it.each(targets)('importAddress refuses %s', async (host) => {
        await expect(keymaster.importAddress(host)).rejects.toThrow(refused);
    });

    it.each(targets)('checkAddress refuses alice@%s', async (host) => {
        await expect(keymaster.checkAddress(`alice@${host}`)).rejects.toThrow(refused);
    });
});

// A hostname check on the first URL is undone by a redirect: fetch follows them
// on its own, so a public host answering 302 with a Location of
// http://169.254.169.254/ reaches the address the check just rejected. Each hop
// is therefore re-checked, and non-https hops are refused outright.
describe('fetchPublicHttps re-checks every hop', () => {
    const realFetch = global.fetch;

    afterEach(() => {
        global.fetch = realFetch;
    });

    function redirectTo(location: string) {
        return jest.fn(async () => new Response(null, { status: 302, headers: { location } })) as any;
    }

    it('refuses a redirect to a private address', async () => {
        global.fetch = redirectTo('https://169.254.169.254/latest/meta-data/');

        await expect(fetchPublicHttps('https://example.com/.well-known/names'))
            .rejects.toThrow(/private address 169\.254\.169\.254/);
    });

    it('refuses a redirect that drops to http', async () => {
        global.fetch = redirectTo('http://example.com/');

        await expect(fetchPublicHttps('https://example.com/.well-known/names'))
            .rejects.toThrow(/non-https/);
    });

    it('refuses a private target on the first request', async () => {
        global.fetch = jest.fn(async () => new Response('{}', { status: 200 })) as any;

        await expect(fetchPublicHttps('https://127.0.0.1/.well-known/names'))
            .rejects.toThrow(/private address/);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('stops rather than following a redirect loop forever', async () => {
        global.fetch = redirectTo('https://example.com/again');

        await expect(fetchPublicHttps('https://example.com/.well-known/names'))
            .rejects.toThrow(/too many redirects/);
    });

    // 304 sits in the 3xx range but is not a redirect and carries no Location.
    // Treating the whole range as redirects turned it into a "redirect with no
    // location" error, where plain fetch would have returned the response.
    it.each([304, 300, 305])('returns a non-redirect 3xx (%i) rather than erroring', async (status) => {
        global.fetch = jest.fn(async () => new Response(null, { status })) as any;

        const response = await fetchPublicHttps('https://example.com/.well-known/names');

        expect(response.status).toBe(status);
    });

    it('returns an ordinary response untouched', async () => {
        global.fetch = jest.fn(async () => new Response('{"names":{}}', { status: 200 })) as any;

        const response = await fetchPublicHttps('https://example.com/.well-known/names');

        expect(response.status).toBe(200);
        // toEqual, not toStrictEqual: response.json() builds the object in
        // another realm, so the prototypes differ even though the data matches.
        await expect(response.json()).resolves.toEqual({ names: {} });
    });
});
