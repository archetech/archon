export function redactUrl(rawUrl: string): string {
    try {
        const url = new URL(rawUrl);
        url.username = '';
        url.password = '';
        url.search = '';
        url.pathname = url.pathname.replace(/\/v2\/[^/]+/, '/v2/<redacted>');
        return url.toString().replace('%3Credacted%3E', '<redacted>');
    } catch {
        return rawUrl
            .replace(/\/\/[^:@/?#]+:[^@/?#]+@/, '//<redacted>@')
            .replace(/\/v2\/[^/?#]+/, '/v2/<redacted>')
            .replace(/[?&](api[_-]?key|apikey|key|token|access_token)=[^&#]+/gi, '?$1=<redacted>');
    }
}
