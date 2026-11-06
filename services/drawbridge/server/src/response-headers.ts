// Client request headers a proxy must not pass on. fetch sets Host and the length
// itself. Accept-Encoding is the client's, and fetch has to decode the answer:
// offered zstd by a browser over HTTPS, cdk-mintd compresses with it, and Node 22's
// fetch cannot read it, so it left compressed bytes that the header rule below
// then sent unlabelled.
const REQUEST_NOT_FORWARDED = new Set(['host', 'content-length', 'accept-encoding']);

export function isForwardedRequestHeader(name: string): boolean {
    return !REQUEST_NOT_FORWARDED.has(name.toLowerCase());
}

// Upstream response headers a proxy must not pass on. The proxies read the
// upstream body with fetch, which removes the content encodings it negotiated,
// and send it with Express, which frames it itself: forwarding Content-Encoding
// would label the plain body as compressed, and the length and framing headers no
// longer describe what is sent.
const NOT_FORWARDED = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection']);

export function isForwardedResponseHeader(name: string): boolean {
    return !NOT_FORWARDED.has(name.toLowerCase());
}
