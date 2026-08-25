import Gatekeeper from '@didcid/gatekeeper';
import Keymaster from '@didcid/keymaster';
import CipherNode from '@didcid/cipher/node';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory';
import WalletJsonMemory from '@didcid/keymaster/wallet/json-memory';
import HeliaClient from '@didcid/ipfs/helia';
import { jest } from '@jest/globals';
import { isPrivateHostname, fetchPublicHttps } from '../../packages/keymaster/src/net.js';

// Remote name lookup fetches https://<domain>/.well-known/names from a domain
// the caller supplies, which makes the target check the only thing standing
// between the API and the host's own network (#252).
//
// The check this replaced was a prefix regex -- /^(localhost|127\.|10\.|...)/ --
// so it read the start of the string rather than the address. Every case in the
// first list below walked straight past it, including 169.254.169.254, the
// cloud metadata address the issue named first.

describe('isPrivateHostname', () => {
    describe('rejects', () => {
        const cases: Array<[string, string]> = [
            ['localhost', 'localhost'],
            ['a trailing dot on localhost', 'localhost.'],
            ['mixed case', 'LOCALHOST'],
            ['loopback', '127.0.0.1'],
            ['RFC 1918 ten', '10.0.0.1'],
            ['RFC 1918 172', '172.16.0.1'],
            ['RFC 1918 192.168', '192.168.1.1'],
            ['link-local, the metadata address', '169.254.169.254'],
            ['carrier-grade NAT', '100.64.0.1'],
            ['this-host', '0.0.0.0'],
            ['multicast', '224.0.0.1'],
            ['IETF protocol assignments', '192.0.0.1'],
            ['benchmarking', '198.18.0.1'],
            // inet_aton accepts all of these and the resolver honours them, so
            // a check that only understands dotted-decimal is not a check.
            ['loopback as one decimal', '2130706433'],
            ['loopback in octal', '0177.0.0.1'],
            ['loopback in hex', '0x7f000001'],
            ['loopback with implied bytes', '127.1'],
            ['IPv6 loopback', '::1'],
            ['IPv6 loopback in brackets', '[::1]'],
            ['IPv6 unspecified', '::'],
            ['IPv6 unique local', 'fc00::1'],
            ['IPv6 link-local', 'fe80::1'],
            ['IPv6 link-local with a zone', 'fe80::1%eth0'],
            ['IPv4-mapped loopback', '[::ffff:127.0.0.1]'],
            ['IPv4-mapped metadata address', '::ffff:169.254.169.254'],
            ['a .internal name', 'metadata.google.internal'],
            ['an mDNS name', 'printer.local'],
            ['a .localhost name', 'api.localhost'],
            ['the empty string', ''],
        ];

        it.each(cases)('%s', (_label, hostname) => {
            expect(isPrivateHostname(hostname)).toBe(true);
        });
    });

    describe('allows', () => {
        // The guard is worthless if it also blocks the lookups it exists to
        // permit, and the ranges next to the blocked ones are the easy mistake:
        // 11.x is not 10.x, 172.32 is outside the /12, and 169.253 is not
        // link-local.
        const cases: Array<[string, string]> = [
            ['an ordinary domain', 'example.com'],
            ['a subdomain', 'names.example.org'],
            ['a public resolver', '8.8.8.8'],
            ['another public address', '1.1.1.1'],
            ['a public IPv6 address', '2606:2800:220:1:248:1893:25c8:1946'],
            ['the address above the RFC 1918 ten block', '11.0.0.1'],
            ['the address below it', '9.255.255.255'],
            ['just outside the 172.16/12 block', '172.32.0.1'],
            ['just below it', '172.15.255.255'],
            ['just outside link-local', '169.253.0.1'],
            ['a name merely containing a blocked word', 'localhost.example.com'],
            ['a punycode domain', 'xn--bcher-kva.example'],
        ];

        it.each(cases)('%s', (_label, hostname) => {
            expect(isPrivateHostname(hostname)).toBe(false);
        });
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

    it('returns an ordinary response untouched', async () => {
        global.fetch = jest.fn(async () => new Response('{"names":{}}', { status: 200 })) as any;

        const response = await fetchPublicHttps('https://example.com/.well-known/names');

        expect(response.status).toBe(200);
        // toEqual, not toStrictEqual: response.json() builds the object in
        // another realm, so the prototypes differ even though the data matches.
        await expect(response.json()).resolves.toEqual({ names: {} });
    });
});
