import { GRANT_LINK_PREFIX, MAX_GRANT_LINK_LENGTH, decodeGrantLink, encodeGrantLink } from '@didcid/memeplex';

// Grant links: docs/plans/memeplex-reference-1436.md, "Grant request flow".

const CLIENT = 'did:cid:bagaaieraclientclientclientclientclientclientclientclientcli';
const request = {
    v: 1,
    client: CLIENT,
    name: 'Memepool',
    actions: ['memeplex:post', 'memeplex:reply', 'memeplex:tag'],
    nonce: 'Qm9vdHN0cmFwIG5vbmNlMTIz',
};

function linkOf(payload: string): string {
    return GRANT_LINK_PREFIX + Buffer.from(payload, 'utf8').toString('base64url');
}

it('carries a request there and back', () => {
    const link = encodeGrantLink(request);

    expect(link.startsWith('archon://grant?request=')).toBe(true);
    expect(link).not.toMatch(/[=+/]$/);
    expect(decodeGrantLink(link)).toStrictEqual({ request });
});

it('carries the request under memeplexGrantRequest, as unpadded base64url JSON', () => {
    const encoded = encodeGrantLink(request).slice(GRANT_LINK_PREFIX.length);

    expect(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))).toStrictEqual({ memeplexGrantRequest: request });
});

it('carries a name outside ASCII', () => {
    const named = { ...request, name: 'Mémépool 模因池 🌊' };

    expect(decodeGrantLink(encodeGrantLink(named))).toStrictEqual({ request: named });
});

it('will not make a link for an invalid request, or one too long', () => {
    expect(() => encodeGrantLink({ ...request, nonce: 'short' })).toThrow('not a valid grant request');

    const actions = Array.from({ length: 30 }, (_, index) =>
        `did:cid:schema${index}?versionId=b${'a'.repeat(58)}`);
    expect(() => encodeGrantLink({ ...request, actions })).toThrow('over the limit');
});

it.each([
    ['another archon link', 'archon://auth?challenge=did:cid:abc', 'not-a-grant-link'],
    ['a web link', 'https://example.com/?request=abc', 'not-a-grant-link'],
    ['nothing', '', 'not-a-grant-link'],
    ['a request that is not base64url', `${GRANT_LINK_PREFIX}not base64!`, 'undecodable'],
    ['a padded request', `${linkOf(JSON.stringify({ memeplexGrantRequest: request }) + ' ')}=`, 'undecodable'],
    ['a request that is not JSON', linkOf('{"memeplexGrantRequest":'), 'undecodable'],
    ['bytes that are not UTF-8', `${GRANT_LINK_PREFIX}${Buffer.from([0xff, 0xfe, 0xfd]).toString('base64url')}`, 'undecodable'],
    ['a request with no memeplexGrantRequest', linkOf(JSON.stringify(request)), 'invalid-request'],
    ['a JSON value that is not an object', linkOf('[1]'), 'invalid-request'],
])('refuses %s', (_name, link, error) => {
    expect(decodeGrantLink(link)).toMatchObject({ error });
});

it('says how a request is invalid', () => {
    const link = linkOf(JSON.stringify({ memeplexGrantRequest: { ...request, expiresAt: '2027-02-30T00:00:00Z' } }));

    expect(decodeGrantLink(link)).toStrictEqual({ error: 'invalid-request', validity: 'expiry-instant' });
    expect(decodeGrantLink(linkOf(JSON.stringify({ memeplexGrantRequest: { ...request, v: 2 } }))))
        .toStrictEqual({ error: 'invalid-request', validity: 'unsupported' });
});

it('refuses a link over the limit whatever it carries', () => {
    const link = encodeGrantLink(request);
    const long = link + 'A'.repeat(MAX_GRANT_LINK_LENGTH - link.length + 1);

    expect(decodeGrantLink(long)).toStrictEqual({ error: 'too-long' });
});
