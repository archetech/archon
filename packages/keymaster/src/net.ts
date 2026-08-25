// Guards for fetches to a caller-supplied host.
//
// Remote name lookup takes a domain from the caller and fetches
// https://<domain>/.well-known/names..., which makes it an SSRF primitive
// unless the target is checked: the classic payload is a cloud metadata
// address such as 169.254.169.254, reachable from inside a container and
// happy to hand out credentials (#252).
//
// This runs in browser wallets as well as Node, so `node:net` is not
// available and the address parsing here is done by hand.

// Every way inet_aton will accept an IPv4 address. `fetch` hands the hostname
// to the platform resolver, which accepts all of these, so a check that only
// understands dotted-decimal is a check that can be walked around:
//
//   2130706433   0177.0.0.1   0x7f000001   127.1
//
// all reach 127.0.0.1. Returns the address as a 32-bit number, or null when
// the string is not an IPv4 address in any of those forms.
function parseIpv4(hostname: string): number | null {
    const parts = hostname.split('.');

    if (parts.length === 0 || parts.length > 4) {
        return null;
    }

    const values: number[] = [];

    for (const part of parts) {
        if (part === '') {
            return null;
        }

        let value: number;

        if (/^0[xX][0-9a-fA-F]+$/.test(part)) {
            value = parseInt(part, 16);
        }
        else if (/^0[0-7]+$/.test(part)) {
            value = parseInt(part, 8);
        }
        else if (/^[0-9]+$/.test(part)) {
            value = parseInt(part, 10);
        }
        else {
            return null;
        }

        if (!Number.isFinite(value) || value < 0) {
            return null;
        }

        values.push(value);
    }

    // With fewer than four parts the last one covers the remaining bytes:
    // 127.1 is 127.0.0.1, and a lone 2130706433 is the whole address.
    const last = values.pop()!;
    const remainingBytes = 4 - values.length;

    if (last >= Math.pow(256, remainingBytes)) {
        return null;
    }

    if (values.some(value => value > 255)) {
        return null;
    }

    let address = last;

    for (let i = 0; i < values.length; i++) {
        address += values[i] * Math.pow(256, 3 - i);
    }

    return address >>> 0;
}

// Ranges that should never be the target of a lookup on behalf of a caller.
// Loopback and the RFC 1918 blocks are the obvious ones; 169.254/16 is the
// link-local range that carries cloud metadata, and the rest are reserved
// space that a public name has no business resolving to.
const BLOCKED_IPV4: Array<[string, number]> = [
    ['0.0.0.0', 8],        // "this host"
    ['10.0.0.0', 8],       // RFC 1918
    ['100.64.0.0', 10],    // carrier-grade NAT
    ['127.0.0.0', 8],      // loopback
    ['169.254.0.0', 16],   // link-local, incl. cloud metadata
    ['172.16.0.0', 12],    // RFC 1918
    ['192.0.0.0', 24],     // IETF protocol assignments
    ['192.168.0.0', 16],   // RFC 1918
    ['198.18.0.0', 15],    // benchmarking
    ['224.0.0.0', 4],      // multicast
    ['240.0.0.0', 4],      // reserved, incl. broadcast
];

function inRange(address: number, network: string, bits: number): boolean {
    const base = parseIpv4(network)!;
    // A /0 would shift by 32, which JavaScript treats as a shift by 0.
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (address & mask) >>> 0 === (base & mask) >>> 0;
}

function isPrivateIpv4(address: number): boolean {
    return BLOCKED_IPV4.some(([network, bits]) => inRange(address, network, bits));
}

// Expands an IPv6 address to its sixteen bytes, or null if it is not one.
// Written out rather than delegated because there is no parser available in
// both runtimes this package targets.
function parseIpv6(hostname: string): number[] | null {
    let text = hostname;

    // A URL keeps IPv6 literals in brackets; a bare address may arrive without.
    if (text.startsWith('[') && text.endsWith(']')) {
        text = text.slice(1, -1);
    }

    // Zone identifiers (fe80::1%eth0) are not part of the address.
    const zone = text.indexOf('%');
    if (zone !== -1) {
        text = text.slice(0, zone);
    }

    if (!text.includes(':')) {
        return null;
    }

    const halves = text.split('::');
    if (halves.length > 2) {
        return null;
    }

    function toGroups(section: string): number[][] | null {
        if (section === '') {
            return [];
        }

        const groups: number[][] = [];

        for (const piece of section.split(':')) {
            // A trailing IPv4 part, as in ::ffff:127.0.0.1, is four more bytes.
            if (piece.includes('.')) {
                const address = parseIpv4(piece);
                if (address === null) {
                    return null;
                }
                groups.push([(address >>> 24) & 0xff, (address >>> 16) & 0xff]);
                groups.push([(address >>> 8) & 0xff, address & 0xff]);
                continue;
            }

            if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) {
                return null;
            }

            const value = parseInt(piece, 16);
            groups.push([(value >> 8) & 0xff, value & 0xff]);
        }

        return groups;
    }

    const head = toGroups(halves[0]);
    const tail = halves.length === 2 ? toGroups(halves[1]) : [];

    if (head === null || tail === null) {
        return null;
    }

    const missing = 8 - head.length - tail.length;

    if (halves.length === 2) {
        if (missing < 0) {
            return null;
        }
    }
    else if (missing !== 0) {
        return null;
    }

    const filled = [...head, ...Array.from({ length: Math.max(missing, 0) }, () => [0, 0]), ...tail];

    return filled.flat();
}

function isPrivateIpv6(bytes: number[]): boolean {
    const isZero = (from: number, to: number) => bytes.slice(from, to).every(byte => byte === 0);

    // ::1 loopback, and :: unspecified.
    if (isZero(0, 15) && (bytes[15] === 1 || bytes[15] === 0)) {
        return true;
    }

    // ::ffff:0:0/96 -- an IPv4 address wearing an IPv6 hat, so judge the IPv4.
    if (isZero(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) {
        const embedded = ((bytes[12] << 24) | (bytes[13] << 16) | (bytes[14] << 8) | bytes[15]) >>> 0;
        return isPrivateIpv4(embedded);
    }

    // fc00::/7 unique local, fe80::/10 link-local.
    if ((bytes[0] & 0xfe) === 0xfc) {
        return true;
    }

    return (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80);
}

// Names that resolve inside a host or a private network by convention. This
// cannot catch a public name pointed at a private address -- that is DNS
// rebinding, and it needs resolve-then-pin rather than a string check -- but
// it does catch the names that are private by definition.
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

export function isPrivateHostname(hostname: string): boolean {
    if (typeof hostname !== 'string' || hostname === '') {
        return true;
    }

    const host = hostname.trim().toLowerCase().replace(/\.$/, '');

    if (host === '' || host === 'localhost') {
        return true;
    }

    const ipv6 = parseIpv6(host);
    if (ipv6) {
        return isPrivateIpv6(ipv6);
    }

    const ipv4 = parseIpv4(host);
    if (ipv4 !== null) {
        return isPrivateIpv4(ipv4);
    }

    return BLOCKED_SUFFIXES.some(suffix => host.endsWith(suffix));
}

const MAX_REDIRECTS = 3;

// Fetches over https, refusing any hop that is not https or that points at a
// private target. Checking only the first URL is not enough: `fetch` follows
// redirects on its own, so a public host answering 302 with a Location of
// http://169.254.169.254/ reaches the address the check exists to keep out.
// The Lightning LUD-16 path already walks redirects this way for the scheme;
// this adds the target check that path does not have.
export async function fetchPublicHttps(target: string, init?: RequestInit): Promise<Response> {
    let current = target;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const url = new URL(current);

        if (url.protocol !== 'https:') {
            throw new Error(`refusing non-https request to ${url.host}`);
        }

        if (isPrivateHostname(url.hostname)) {
            throw new Error(`refusing request to private address ${url.hostname}`);
        }

        const response = await fetch(current, { ...init, redirect: 'manual' });

        // Follow only what is definitely a redirect. Testing for the negative
        // instead would treat an absent or non-numeric status as one and go
        // looking for a Location header that was never there.
        if (!(response.status >= 300 && response.status < 400)) {
            return response;
        }

        const location = response.headers.get('location');

        if (!location) {
            throw new Error(`redirect with no location from ${url.host}`);
        }

        current = new URL(location, current).toString();
    }

    throw new Error(`too many redirects (${MAX_REDIRECTS})`);
}
