import type express from 'express';
import { buildProxyBody } from './herald-proxy.js';
import { resolveUpstreamUrl } from './upstream-url.js';

// Generic reverse proxy to an internal service, stripping a path prefix.
export async function proxyRequest(req: express.Request, res: express.Response, baseURL: string, prefixToStrip: string, confineTo?: string) {
    const upstreamUrl = resolveUpstreamUrl(req.originalUrl, prefixToStrip, baseURL, confineTo);
    if (!upstreamUrl) {
        res.status(400).json({ error: 'Invalid path' });
        return;
    }

    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
        if (!value || name === 'host' || name === 'content-length') {
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
        if (key === 'content-length' || key === 'transfer-encoding' || key === 'connection') {
            return;
        }
        res.setHeader(key, value);
    });
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.send(buffer);
}
