import type express from 'express';

// Forwarding to Herald, kept apart from the app so the proxy itself can be
// exercised end to end against a running Herald in tests.

export function buildProxyBody(req: express.Request): BodyInit | undefined {
    if (req.method === 'GET' || req.method === 'HEAD') {
        return undefined;
    }

    const contentType = req.headers['content-type'] || '';

    if (Buffer.isBuffer(req.body)) {
        return new Uint8Array(req.body);
    }

    if (typeof req.body === 'string') {
        return req.body;
    }

    if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
        if (contentType.includes('application/x-www-form-urlencoded')) {
            return new URLSearchParams(
                Object.entries(req.body).flatMap(([key, value]) => {
                    if (Array.isArray(value)) {
                        return value.map(item => [key, String(item)] as [string, string]);
                    }
                    return [[key, String(value)] as [string, string]];
                })
            ).toString();
        }
        return JSON.stringify(req.body);
    }

    return undefined;
}

export async function proxyHeraldRequest(req: express.Request, res: express.Response, heraldURL: string, prefixToStrip = '/names') {
    const upstreamPath = prefixToStrip
        ? (req.originalUrl.replace(new RegExp(`^${prefixToStrip}`), '') || '/')
        : req.originalUrl;
    const upstreamUrl = new URL(upstreamPath, heraldURL);

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
    if (body && !headers.has('content-type')) {
        headers.set('content-type', 'application/json');
    }

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

    const setCookies = (upstream.headers as any).getSetCookie?.();
    if (Array.isArray(setCookies) && setCookies.length > 0) {
        res.setHeader('Set-Cookie', setCookies);
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.send(buffer);
}
