const QUOTED_SECRET_ASSIGNMENT = /\b(ARCHON_(?:ADMIN_API_KEY|PASSPHRASE|ENCRYPTED_PASSPHRASE)|api[_-]?key|apikey|token|access_token|passphrase|password)=("[^"]*"|'[^']*')/gi;
const SPACED_SECRET_ASSIGNMENT = /\b(ARCHON_(?:PASSPHRASE|ENCRYPTED_PASSPHRASE)|passphrase|password)=([^&\r\n]*?)(?=\shttps?:\/\/|\s[A-Za-z_][A-Za-z0-9_-]*=|[&\r\n]|$)/gi;
const SECRET_ASSIGNMENT = /\b(ARCHON_ADMIN_API_KEY|api[_-]?key|apikey|token|access_token)=([^&\s]+)/gi;
const URL_TEXT = /https?:\/\/[^\s"'<>]+/gi;
const URL_SECRET_PARAMS = new Set(['api_key', 'apikey', 'access_token', 'token', 'key', 'password', 'passphrase']);
const TOKEN_PATH_HOSTS = [
    /(^|\.)alchemy\.com$/i,
    /(^|\.)infura\.io$/i,
    /(^|\.)quicknode\.com$/i,
];

function redactUrl(rawUrl: string): string {
    try {
        const url = new URL(rawUrl);

        if (url.username || url.password) {
            url.username = '<redacted>';
            url.password = '';
        }

        for (const param of [...url.searchParams.keys()]) {
            if (URL_SECRET_PARAMS.has(param.toLowerCase())) {
                url.searchParams.set(param, '<redacted>');
            }
        }

        if (TOKEN_PATH_HOSTS.some(pattern => pattern.test(url.hostname))) {
            url.pathname = url.pathname.replace(/\/v\d+\/[^/?#]+/gi, match => {
                const [prefix] = match.match(/\/v\d+\//i) ?? ['/'];
                return `${prefix}<redacted>`;
            });
        }

        return url.toString().replace(/%3Credacted%3E/g, '<redacted>');
    } catch {
        return rawUrl;
    }
}

export function redactSecretText(value: unknown): string {
    const text = typeof value === 'string'
        ? value
        : value instanceof Error
            ? value.message
            : JSON.stringify(value);

    return (text || String(value))
        .replace(URL_TEXT, redactUrl)
        .replace(QUOTED_SECRET_ASSIGNMENT, '$1=<redacted>')
        .replace(SPACED_SECRET_ASSIGNMENT, '$1=<redacted>')
        .replace(SECRET_ASSIGNMENT, '$1=<redacted>');
}

export function errorMessage(error: unknown): string {
    if (typeof error === 'object' && error && 'error' in error && typeof error.error === 'string') {
        return redactSecretText(error.error);
    }

    if (typeof error === 'object' && error && 'message' in error && typeof error.message === 'string') {
        return redactSecretText(error.message);
    }

    return redactSecretText(error);
}
