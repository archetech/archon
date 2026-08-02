import { redactSecretText, errorMessage } from '../../packages/mcp-server/src/redact.ts';

// These assertions deliberately check that the secret is ABSENT from the output,
// not merely that a placeholder appears — a redactor that emits "<redacted>" while
// still leaking the value elsewhere in the string would otherwise pass.
function expectRedacted(output: string, secret: string) {
    expect(output).not.toContain(secret);
    expect(output).toContain('<redacted>');
}

describe('redactSecretText: assignments', () => {
    it('redacts a bare assignment for every recognised key', () => {
        const keys = [
            'ARCHON_ADMIN_API_KEY', 'ARCHON_PASSPHRASE', 'ARCHON_ENCRYPTED_PASSPHRASE',
            'api_key', 'api-key', 'apikey', 'token', 'access_token',
            'passphrase', 'password', 'mnemonic',
            'recovery_phrase', 'recovery-phrase', 'recoveryPhrase',
            'nsec', 'bolt11', 'adminKey', 'invoiceKey',
        ];

        for (const key of keys) {
            const output = redactSecretText(`${key}=SUPERSECRET`);
            expect([key, output]).toEqual([key, `${key}=<redacted>`]);
        }
    });

    it('is case-insensitive on the key', () => {
        expectRedacted(redactSecretText('TOKEN=SUPERSECRET'), 'SUPERSECRET');
        expectRedacted(redactSecretText('PassPhrase=SUPERSECRET'), 'SUPERSECRET');
    });

    it('redacts single- and double-quoted values whole', () => {
        expectRedacted(redactSecretText('token="secret with spaces"'), 'secret with spaces');
        expectRedacted(redactSecretText("token='secret with spaces'"), 'secret with spaces');
    });

    it('redacts an unquoted multi-word passphrase up to the next assignment or EOL', () => {
        expectRedacted(
            redactSecretText('mnemonic=abandon abandon abandon about'),
            'abandon abandon abandon about',
        );

        const followed = redactSecretText('passphrase=my secret words user=alice');
        expect(followed).not.toContain('my secret words');
        expect(followed).toContain('user=alice');

        const beforeUrl = redactSecretText('passphrase=my secret words https://example.test/x');
        expect(beforeUrl).not.toContain('my secret words');
        expect(beforeUrl).toContain('https://example.test/x');
    });

    it('leaves unrelated assignments alone', () => {
        const output = redactSecretText('user=alice registry=hyperswarm count=3');

        expect(output).toBe('user=alice registry=hyperswarm count=3');
        expect(output).not.toContain('<redacted>');
    });

    it('redacts several secrets in one string', () => {
        const output = redactSecretText('token=aaa password=bbb user=carol');

        expect(output).not.toContain('aaa');
        expect(output).not.toContain('bbb');
        expect(output).toContain('user=carol');
    });
});

describe('redactSecretText: URLs', () => {
    it('strips basic-auth credentials', () => {
        const bothParts = redactSecretText('see https://alice:hunter2@example.test/path');
        expect(bothParts).not.toContain('hunter2');
        expect(bothParts).not.toContain('alice');

        // A username with no password, and a password with no username.
        const userOnly = redactSecretText('https://alice@example.test/path');
        expect(userOnly).not.toContain('alice');

        const passOnly = redactSecretText('https://:hunter2@example.test/path');
        expect(passOnly).not.toContain('hunter2');
    });

    it('redacts secret query parameters and keeps the rest', () => {
        for (const param of ['api_key', 'apikey', 'access_token', 'token', 'key', 'password', 'passphrase']) {
            const output = redactSecretText(`https://example.test/x?${param}=SUPERSECRET&page=2`);
            expect([param, output.includes('SUPERSECRET')]).toEqual([param, false]);
            expect(output).toContain('page=2');
        }
    });

    it('matches secret parameters case-insensitively', () => {
        const output = redactSecretText('https://example.test/x?API_KEY=SUPERSECRET');

        expect(output).not.toContain('SUPERSECRET');
    });

    it('emits a readable placeholder rather than a percent-encoded one', () => {
        const output = redactSecretText('https://example.test/x?token=SUPERSECRET');

        expect(output).toContain('<redacted>');
        expect(output).not.toContain('%3Credacted%3E');
    });

    it('redacts an API key carried in the path for known provider hosts', () => {
        for (const host of [
            'eth-mainnet.alchemy.com',
            'alchemy.com',
            'mainnet.infura.io',
            'infura.io',
            'x.quicknode.com',
        ]) {
            const output = redactSecretText(`https://${host}/v2/SUPERSECRET`);
            expect([host, output.includes('SUPERSECRET')]).toEqual([host, false]);
            expect(output).toContain('/v2/<redacted>');
        }
    });

    it('leaves the path alone for other hosts', () => {
        const output = redactSecretText('https://example.test/v2/not-a-secret');

        expect(output).toContain('/v2/not-a-secret');
    });

    it('does not treat a lookalike host as a provider host', () => {
        // The patterns anchor on `(^|.)alchemy.com$`, so this must not match.
        const output = redactSecretText('https://alchemy.com.evil.test/v2/PUBLICVALUE');

        expect(output).toContain('PUBLICVALUE');
    });

    it('leaves an unparsable URL-like string untouched', () => {
        // http:// with nothing after it fails the URL constructor, hitting the catch.
        const output = redactSecretText('http://');

        expect(output).toBe('http://');
    });
});

describe('redactSecretText: input types', () => {
    it('reads the message off an Error', () => {
        const output = redactSecretText(new Error('failed with token=SUPERSECRET'));

        expectRedacted(output, 'SUPERSECRET');
    });

    it('serialises a plain object and redacts inside it', () => {
        const output = redactSecretText({ note: 'token=SUPERSECRET' });

        expect(output).not.toContain('SUPERSECRET');
        expect(output).toContain('note');
    });

    it('falls back to String(value) when serialisation yields nothing usable', () => {
        // JSON.stringify(undefined) is undefined, and an empty string is falsy, so
        // both fall through to String(value) rather than producing "undefined".
        expect(redactSecretText(undefined)).toBe('undefined');
        expect(redactSecretText('')).toBe('');
        expect(redactSecretText(null)).toBe('null');
    });

    it('handles numbers and booleans', () => {
        expect(redactSecretText(42)).toBe('42');
        expect(redactSecretText(false)).toBe('false');
    });
});

describe('errorMessage', () => {
    it('prefers an `error` string property', () => {
        const output = errorMessage({ error: 'boom token=SUPERSECRET', message: 'ignored' });

        expect(output).toContain('boom');
        expect(output).not.toContain('SUPERSECRET');
        expect(output).not.toContain('ignored');
    });

    it('falls back to a `message` string property', () => {
        const output = errorMessage({ message: 'boom token=SUPERSECRET' });

        expect(output).toContain('boom');
        expect(output).not.toContain('SUPERSECRET');
    });

    it('ignores a non-string error property and uses message instead', () => {
        const output = errorMessage({ error: { nested: true }, message: 'the real message' });

        expect(output).toBe('the real message');
    });

    it('reads an Error instance through its message property', () => {
        expect(errorMessage(new Error('plain failure'))).toBe('plain failure');
    });

    it('serialises anything else', () => {
        expect(errorMessage('a bare string')).toBe('a bare string');
        expect(errorMessage(null)).toBe('null');
        expect(errorMessage(undefined)).toBe('undefined');
        expect(errorMessage(404)).toBe('404');
        expect(errorMessage({ status: 500 })).toContain('500');
    });

    it('redacts secrets regardless of which shape carried them', () => {
        for (const input of [
            { error: 'passphrase=hunter2' },
            { message: 'passphrase=hunter2' },
            new Error('passphrase=hunter2'),
            'passphrase=hunter2',
        ]) {
            expect(errorMessage(input)).not.toContain('hunter2');
        }
    });
});
