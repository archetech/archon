// Node-only transport for caller-controlled public HTTPS URLs. Never install a
// global dispatcher: trusted internal service traffic must keep its own policy.
import { lookup } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import { Agent } from 'undici';
import { fetchPublicHttps as followPublicRedirects, isPrivateHostname } from './net.js';

export { isPrivateHostname } from './net.js';

export const publicLookup: LookupFunction = (hostname, options, callback) => {
    lookup(hostname, { all: true }, (error, addresses) => {
        if (error) { callback(error, '', 0); return; }
        if (!addresses.length || addresses.some(({ address }) => !isIP(address) || isPrivateHostname(address))) {
            callback(new Error(`refusing DNS resolution to private address for ${hostname}`), '', 0);
            return;
        }
        // Return precisely the validated answers to the socket's lookup hook;
        // there is no second hostname lookup between validation and connection.
        const family = options.family;
        const candidates = family === 4 || family === 6
            ? addresses.filter(address => address.family === family) : addresses;
        if (!candidates.length) { callback(new Error(`no matching address for ${hostname}`), '', 0); return; }
        if ((options as { all?: boolean }).all) {
            callback(null, candidates, 0);
        } else {
            callback(null, candidates[0].address, candidates[0].family);
        }
    });
};

// Undici 6 matches the built-in fetch dispatcher contract on our pinned Node 22.
const publicAgent = new Agent({ connect: { lookup: publicLookup } });

export async function fetchPublicHttpsOnce(target: string, init?: RequestInit): Promise<Response> {
    const url = new URL(target);
    // IP literals bypass DNS lookup in the connector, so validate them here too.
    if (url.protocol !== 'https:' || isPrivateHostname(url.hostname)) {
        throw new Error(`refusing request to non-public HTTPS target ${url.host}`);
    }
    return fetch(target, { ...init, redirect: 'manual', dispatcher: publicAgent } as RequestInit);
}

export function fetchPublicHttps(target: string, init?: RequestInit): Promise<Response> {
    return followPublicRedirects(target, init, fetchPublicHttpsOnce as typeof fetch);
}
