import type express from 'express';
import { buildProxyBody } from './herald-proxy.js';
import { resolveUpstreamUrl } from './upstream-url.js';
import { isForwardedRequestHeader, isForwardedResponseHeader } from './response-headers.js';

// Generic reverse proxy to an internal service, stripping a path prefix.
//
// `cookiePath` is for an upstream that sets cookies. Each cookie is passed on
// as a header of its own, and one the upstream set for all its paths is set
// for the mount, so that the browser sends it back to this upstream only and
// not to everything else on the node's host.
export async function proxyRequest(req: express.Request, res: express.Response, baseURL: string, prefixToStrip: string, confineTo?: string, cookiePath?: string) {
    const upstreamUrl = resolveUpstreamUrl(req.originalUrl, prefixToStrip, baseURL, confineTo);
    if (!upstreamUrl) {
        res.status(400).json({ error: 'Invalid path' });
        return;
    }

    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
        if (!value || !isForwardedRequestHeader(name)) {
            continue;
        }
        if (Array.isArray(value)) {
            for (const item of value) {
                headers.append(name, item);
            }
        }
        else {
            headers.set(name, value);
        }
    }

    const body = buildProxyBody(req);

    const upstream = await fetch(upstreamUrl, {
        method: req.method,
        headers,
        body,
        redirect: 'manual',
    });

    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
        if (!isForwardedResponseHeader(key) || (cookiePath !== undefined && key.toLowerCase() === 'set-cookie')) {
            return;
        }
        res.setHeader(key, value);
    });

    if (cookiePath !== undefined) {
        const cookies = upstream.headers.getSetCookie().map(cookie => cookie.replace(/;\s*Path=\/(?=;|$)/i, `; Path=${cookiePath}`));

        if (cookies.length > 0) {
            res.setHeader('Set-Cookie', cookies);
        }
    }
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.send(buffer);
}
