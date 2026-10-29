// Resolve a proxied request's path against its upstream's base URL, stripping
// the mount prefix first.
//
// Two ways a crafted path escapes the route it was mounted on, both closed here:
//
//   * A path that begins `//` (or `/\`, which URL parsing treats the same way)
//     is a network-path reference and resolves to another HOST. Any result
//     outside the upstream's origin is refused.
//
//   * `..` segments are not resolved by Express before it matches a mount, but
//     `new URL` resolves them, so `/api/v1/lightning/../l402/x` matches the
//     public `/lightning` mount yet resolves to `/api/v1/l402/x` on the same
//     upstream -- a different, admin-gated route. When `confineTo` is given,
//     a result outside that upstream PATH subtree is refused.
//
// Prefix-stripping mounts (/names, /didcomm) forward everything after the
// prefix to the upstream root, so there is no narrower subtree to confine them
// to; they pass no `confineTo` and get the origin check alone.
export function resolveUpstreamUrl(
    originalUrl: string,
    prefixToStrip: string,
    baseURL: string,
    confineTo?: string,
): URL | null {
    const path = prefixToStrip
        ? (originalUrl.replace(new RegExp(`^${prefixToStrip}`), '') || '/')
        : originalUrl;
    const base = new URL(baseURL);

    let url: URL;
    try {
        url = new URL(path, base);
    }
    catch {
        return null;
    }

    if (url.origin !== base.origin) {
        return null;
    }

    if (confineTo) {
        const prefix = confineTo.endsWith('/') ? confineTo.slice(0, -1) : confineTo;
        if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) {
            return null;
        }
    }

    return url;
}
