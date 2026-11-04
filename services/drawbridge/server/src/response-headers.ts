// Upstream response headers a proxy must not pass on. The proxies read the
// upstream body with fetch, which removes any content encoding, and send it
// with Express, which frames it itself: forwarding Content-Encoding would label
// the plain body as compressed, and the length and framing headers no longer
// describe what is sent.
const NOT_FORWARDED = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection']);

export function isForwardedResponseHeader(name: string): boolean {
    return !NOT_FORWARDED.has(name.toLowerCase());
}
