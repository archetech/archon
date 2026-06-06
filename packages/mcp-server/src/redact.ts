const SECRET_ASSIGNMENT = /(ARCHON_(?:ADMIN_API_KEY|PASSPHRASE|ENCRYPTED_PASSPHRASE)|api[_-]?key|apikey|token|access_token|passphrase|password)=([^&\s]+)/gi;

export function redactSecretText(value: unknown): string {
    const text = typeof value === 'string'
        ? value
        : value instanceof Error
            ? value.message
            : JSON.stringify(value);

    return (text || String(value))
        .replace(/\/\/([^:@/\s]+):([^@/\s]+)@/g, '//<redacted>@')
        .replace(/\/v2\/[^/?#\s]+/g, '/v2/<redacted>')
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
