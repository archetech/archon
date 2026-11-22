import { GRANT_LINK_PREFIX, grantLink, parseGrantLink, readGrantRequest } from '@didcid/memeplex';

// The grant link, and what a wallet reads from the request it names:
// docs/plans/memeplex-reference-1436.md, "Grant request flow". Requests made
// and resolved by a Keymaster and a Gatekeeper are in client.test.ts.

const REQUEST = 'did:cid:bagaaierarequestrequestrequestrequestrequestrequestrequestre';
const CLIENT = 'did:cid:bagaaieraclientclientclientclientclientclientclientclientcli';
const request = { v: 1, name: 'Memepool', actions: ['memeplex:post', 'memeplex:reply'], registries: ['BTC:mainnet'] };

const resolved = (more: Record<string, unknown> = {}) => ({
    didDocument: { id: REQUEST, controller: CLIENT },
    didDocumentData: { memeplexGrantRequest: request },
    didDocumentRegistration: { type: 'asset', registry: 'hyperswarm' },
    didDocumentMetadata: { versionSequence: '1' },
    ...more,
});

it('names a request by its DID', () => {
    expect(grantLink(REQUEST)).toBe(`${GRANT_LINK_PREFIX}${REQUEST}`);
    expect(grantLink(REQUEST)).toBe(`archon://auth?grant=${REQUEST}`);
    expect(() => grantLink('the request')).toThrow('names the DID');
});

it('reads the DID from a link, or takes the DID alone', () => {
    expect(parseGrantLink(grantLink(REQUEST))).toBe(REQUEST);
    expect(parseGrantLink(`  ${grantLink(REQUEST)}\n`)).toBe(REQUEST);
    expect(parseGrantLink(REQUEST)).toBe(REQUEST);
    // As a URL library writes it.
    expect(parseGrantLink(`archon://auth?grant=${encodeURIComponent(REQUEST)}`)).toBe(REQUEST);
});

it.each([
    ['nothing', ''],
    ['another archon link', `archon://accept?credential=${REQUEST}`],
    ['a link that names a challenge', `archon://auth?challenge=${REQUEST}`],
    ['a link with no request', GRANT_LINK_PREFIX],
    ['a request that is not a DID', `${GRANT_LINK_PREFIX}eyJ2IjoxfQ`],
    ['a DID with more after it', `${grantLink(REQUEST)}&x=1`],
    ['a value that is not text', 7],
])('reads no request from %s', (_name, link) => {
    expect(parseGrantLink(link)).toBeUndefined();
});

it('reads what a request asks for, and that its controller asks', () => {
    expect(readGrantRequest(resolved())).toStrictEqual({ did: REQUEST, client: CLIENT, request });
    expect(readGrantRequest(resolved({ didDocumentMetadata: { versionSequence: 1 } }))).toMatchObject({ client: CLIENT });
});

it.each([
    ['nothing resolved', undefined, { error: 'not-found' }],
    ['a document with no DID', resolved({ didDocument: {} }), { error: 'not-found' }],
    ['a deleted request', resolved({ didDocumentMetadata: { versionSequence: '2', deactivated: true } }), { error: 'deactivated' }],
    ['an agent', resolved({ didDocumentRegistration: { type: 'agent' } }), { error: 'not-an-asset' }],
    ['an asset with no controller', resolved({ didDocument: { id: REQUEST } }), { error: 'not-an-asset' }],
    ['a later version', resolved({ didDocumentMetadata: { versionSequence: '2' } }), { error: 'changed' }],
    ['a version that does not say which it is', resolved({ didDocumentMetadata: {} }), { error: 'changed' }],
    ['an asset that is not a request', resolved({ didDocumentData: { memeplex: {} } }), { error: 'invalid-request', validity: 'schema' }],
    ['data that is a list', resolved({ didDocumentData: [request] }), { error: 'invalid-request', validity: 'schema' }],
    ['a request with no registries', resolved({ didDocumentData: { memeplexGrantRequest: { v: 1, name: 'Memepool' } } }), { error: 'invalid-request', validity: 'schema' }],
    ['a later v', resolved({ didDocumentData: { memeplexGrantRequest: { ...request, v: 2 } } }), { error: 'invalid-request', validity: 'unsupported' }],
])('reads no request from %s', (_name, document, expected) => {
    expect(readGrantRequest(document as never)).toStrictEqual(expected);
});
