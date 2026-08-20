import {
    trustPing,
    trustPingResponse,
    basicMessage,
    discoverFeaturesQuery,
    discoverFeaturesDisclose,
    outOfBandInvitation,
    encodeOutOfBandInvitation,
    decodeOutOfBandInvitation,
    TRUST_PING_TYPE,
    TRUST_PING_RESPONSE_TYPE,
    BASIC_MESSAGE_TYPE,
    DISCOVER_FEATURES_QUERIES_TYPE,
    DISCOVER_FEATURES_DISCLOSE_TYPE,
    OUT_OF_BAND_INVITATION_TYPE,
    offerCredential,
    requestCredential,
    issueCredentialMessage,
    requestPresentation,
    presentationMessage,
    attachedJson,
    ISSUE_CREDENTIAL_TYPE,
    ISSUE_CREDENTIAL_OFFER_TYPE,
    ISSUE_CREDENTIAL_REQUEST_TYPE,
    PRESENT_PROOF_REQUEST_TYPE,
    PRESENT_PROOF_PRESENTATION_TYPE,
    VC_ATTACHMENT_FORMAT,
    VP_ATTACHMENT_FORMAT,
    mediateRequest,
    mediateGrant,
    mediateDeny,
    keylistUpdate,
    keylistUpdateResponse,
    keylistQuery,
    keylist,
    MEDIATE_REQUEST_TYPE,
    MEDIATE_GRANT_TYPE,
    MEDIATE_DENY_TYPE,
    KEYLIST_UPDATE_TYPE,
    KEYLIST_UPDATE_RESPONSE_TYPE,
    KEYLIST_QUERY_TYPE,
    KEYLIST_TYPE,
} from '../../packages/keymaster/src/didcomm-protocols.ts';

describe('DIDComm protocol builders', () => {
    it('builds trust-ping and ping-response (correlated by thid)', () => {
        expect(trustPing()).toEqual({ type: TRUST_PING_TYPE, body: { response_requested: true } });
        expect(trustPing(false).body.response_requested).toBe(false);

        const response = trustPingResponse('ping-id-1');
        expect(response.type).toBe(TRUST_PING_RESPONSE_TYPE);
        expect(response.thid).toBe('ping-id-1');
    });

    it('builds a basic message', () => {
        expect(basicMessage('hello')).toEqual({ type: BASIC_MESSAGE_TYPE, body: { content: 'hello' } });
    });

    it('builds discover-features queries and disclose', () => {
        const query = discoverFeaturesQuery('https://didcomm.org/trust-ping/*');
        expect(query.type).toBe(DISCOVER_FEATURES_QUERIES_TYPE);
        expect((query.body.queries as any)[0]).toEqual({ 'feature-type': 'protocol', match: 'https://didcomm.org/trust-ping/*' });

        const disclose = discoverFeaturesDisclose('q1', [TRUST_PING_TYPE]);
        expect(disclose.type).toBe(DISCOVER_FEATURES_DISCLOSE_TYPE);
        expect(disclose.thid).toBe('q1');
        expect((disclose.body.disclosures as any)[0]).toEqual({ 'feature-type': 'protocol', id: TRUST_PING_TYPE });
    });

    it('builds an out-of-band invitation and round-trips its URL form', () => {
        const invitation = outOfBandInvitation('did:cid:alice', { goal: 'connect', goal_code: 'aries.rel.build' });
        expect(invitation.type).toBe(OUT_OF_BAND_INVITATION_TYPE);
        expect(invitation.from).toBe('did:cid:alice');
        expect(invitation.body.accept).toEqual(['didcomm/v2']);

        const url = encodeOutOfBandInvitation({ id: 'inv-1', ...invitation }, 'https://example.org/invite');
        expect(url).toContain('_oob=');

        const decoded = decodeOutOfBandInvitation(url);
        expect(decoded.from).toBe('did:cid:alice');
        expect(decoded.body.goal).toBe('connect');

        // also decodes a bare _oob value (no surrounding URL)
        const bare = url.split('_oob=')[1];
        expect(decodeOutOfBandInvitation(bare).type).toBe(OUT_OF_BAND_INVITATION_TYPE);
    });
});

describe('credential-exchange builders (issue-credential / present-proof 3.0)', () => {
    const vc = { issuer: 'did:cid:alice', credentialSubject: { id: 'did:cid:bob' }, proof: { proofValue: 'x' } };

    it('issueCredentialMessage carries the VC as a json attachment', () => {
        const msg = issueCredentialMessage(vc, { comment: 'here you go' });
        expect(msg.type).toBe(ISSUE_CREDENTIAL_TYPE);
        expect((msg.body as any).comment).toBe('here you go');
        expect((msg.body as any).formats[0].format).toBe(VC_ATTACHMENT_FORMAT);
        expect((msg as any).attachments[0].format).toBe(VC_ATTACHMENT_FORMAT);
        expect((msg as any).attachments[0].data.json).toEqual(vc);
        expect(attachedJson(msg as any)).toEqual(vc);
    });

    it('requestPresentation has the right type', () => {
        expect(requestPresentation('prove it').type).toBe(PRESENT_PROOF_REQUEST_TYPE);
    });

    it('presentationMessage carries the VP and correlates via thid', () => {
        const vp = { type: ['VerifiablePresentation'], verifiableCredential: [vc] };
        const msg = presentationMessage(vp, { thid: 'req-1' });
        expect(msg.type).toBe(PRESENT_PROOF_PRESENTATION_TYPE);
        expect(msg.thid).toBe('req-1');
        expect((msg as any).attachments[0].format).toBe(VP_ATTACHMENT_FORMAT);
        expect(attachedJson(msg as any)).toEqual(vp);
    });
});

describe('coordinate-mediation 2.0 builders', () => {
    it('mediate request / grant (routing_did) / deny', () => {
        expect(mediateRequest().type).toBe(MEDIATE_REQUEST_TYPE);
        const grant = mediateGrant('did:cid:mediator', 'req-1');
        expect(grant.type).toBe(MEDIATE_GRANT_TYPE);
        expect(grant.thid).toBe('req-1');
        expect((grant.body as any).routing_did).toBe('did:cid:mediator');
        expect(mediateDeny('req-1').type).toBe(MEDIATE_DENY_TYPE);
    });

    it('keylist-update and response', () => {
        const update = keylistUpdate(['did:cid:bob'], 'add');
        expect(update.type).toBe(KEYLIST_UPDATE_TYPE);
        expect((update.body as any).updates[0]).toEqual({ recipient_did: 'did:cid:bob', action: 'add' });

        const response = keylistUpdateResponse([{ recipient_did: 'did:cid:bob', action: 'add', result: 'success' }], 'u-1');
        expect(response.type).toBe(KEYLIST_UPDATE_RESPONSE_TYPE);
        expect(response.thid).toBe('u-1');
        expect((response.body as any).updated[0].result).toBe('success');
    });

    it('keylist-query and keylist', () => {
        expect(keylistQuery().type).toBe(KEYLIST_QUERY_TYPE);
        const list = keylist(['did:cid:bob']);
        expect(list.type).toBe(KEYLIST_TYPE);
        expect((list.body as any).keys[0]).toEqual({ recipient_did: 'did:cid:bob' });
    });
});

// The builders above are exercised with their optional arguments omitted, which
// leaves every `thid ? ... : {}` and default-parameter branch untaken. These
// cover the other side — the threading and comment paths that message
// correlation actually depends on.

describe('optional and default parameters', () => {
    it('honours a non-default trust ping response flag', () => {
        expect(trustPing().body.response_requested).toBe(true);
        expect(trustPing(false).body.response_requested).toBe(false);
    });

    it('honours a non-default discover-features match', () => {
        const defaulted = discoverFeaturesQuery().body.queries as any[];
        expect(defaulted[0].match).toBe('*');

        const specific = discoverFeaturesQuery('https://didcomm.org/trust-ping/*').body.queries as any[];
        expect(specific[0].match).toBe('https://didcomm.org/trust-ping/*');
        expect(specific[0]['feature-type']).toBe('protocol');
    });

    it('merges an out-of-band body over the default accept list', () => {
        const bare = outOfBandInvitation('did:cid:alice');
        expect(bare.body).toEqual({ accept: ['didcomm/v2'] });

        const withGoal = outOfBandInvitation('did:cid:alice', {
            goal_code: 'issue-vc',
            goal: 'Issue a credential',
        });
        expect(withGoal.body).toEqual({
            accept: ['didcomm/v2'],
            goal_code: 'issue-vc',
            goal: 'Issue a credential',
        });

        // An explicit accept overrides the default rather than appending to it.
        const overridden = outOfBandInvitation('did:cid:alice', { accept: ['didcomm/v1'] });
        expect(overridden.body.accept).toEqual(['didcomm/v1']);
    });
});

describe('out-of-band URL encoding', () => {
    const invitation = { type: OUT_OF_BAND_INVITATION_TYPE, from: 'did:cid:alice', body: {} };

    it('appends _oob with ? on a bare base and & when the base already has a query', () => {
        expect(encodeOutOfBandInvitation(invitation)).toContain('https://didcomm.org?_oob=');

        const custom = encodeOutOfBandInvitation(invitation, 'https://wallet.test/connect');
        expect(custom).toContain('https://wallet.test/connect?_oob=');

        const withQuery = encodeOutOfBandInvitation(invitation, 'https://wallet.test/connect?ref=email');
        expect(withQuery).toContain('?ref=email&_oob=');
    });

    it('produces url-safe base64 with no padding', () => {
        const encoded = encodeOutOfBandInvitation(invitation);
        const oob = encoded.split('_oob=')[1];

        expect(oob).not.toMatch(/[+/=]/);
    });

    it('round-trips through a full URL or a bare _oob value', () => {
        const url = encodeOutOfBandInvitation(invitation, 'https://wallet.test/connect?ref=email');
        expect(decodeOutOfBandInvitation(url)).toEqual(invitation);

        const bare = url.split('_oob=')[1];
        expect(decodeOutOfBandInvitation(bare)).toEqual(invitation);
    });

    it('round-trips a payload containing characters that differ between base64 alphabets', () => {
        // '?' and '~' push the encoder into the +/ range that must be substituted.
        const tricky = { ...invitation, body: { goal: 'a?b~c>d???' } };

        const encoded = encodeOutOfBandInvitation(tricky);
        expect(decodeOutOfBandInvitation(encoded)).toEqual(tricky);
    });
});

describe('issue-credential optional fields', () => {
    it('omits an absent comment and includes a present one', () => {
        expect(offerCredential()).toEqual({ type: ISSUE_CREDENTIAL_OFFER_TYPE, body: {} });
        expect(offerCredential('please accept')).toEqual({
            type: ISSUE_CREDENTIAL_OFFER_TYPE,
            body: { comment: 'please accept' },
        });
    });

    it('threads a request only when a thid is supplied', () => {
        const untethered = requestCredential();
        expect(untethered.thid).toBeUndefined();
        expect(untethered.body).toEqual({});

        const threaded = requestCredential('thid-1');
        expect(threaded.thid).toBe('thid-1');

        const both = requestCredential('thid-1', 'please issue');
        expect(both).toEqual({
            type: ISSUE_CREDENTIAL_REQUEST_TYPE,
            thid: 'thid-1',
            body: { comment: 'please issue' },
        });

        // A comment without a thid must not invent one.
        const commentOnly = requestCredential(undefined, 'please issue');
        expect(commentOnly.thid).toBeUndefined();
        expect(commentOnly.body).toEqual({ comment: 'please issue' });
    });

    it('threads and comments an issued credential independently', () => {
        const credential = { id: 'did:cid:vc' };

        const bare = issueCredentialMessage(credential);
        expect(bare.thid).toBeUndefined();
        expect(bare.body).not.toHaveProperty('comment');

        const threaded = issueCredentialMessage(credential, { thid: 'thid-1' });
        expect(threaded.thid).toBe('thid-1');
        expect(threaded.body).not.toHaveProperty('comment');

        const commented = issueCredentialMessage(credential, { comment: 'here you go' });
        expect(commented.thid).toBeUndefined();
        expect((commented.body as any).comment).toBe('here you go');

        const both = issueCredentialMessage(credential, { thid: 'thid-1', comment: 'here you go' });
        expect(both.thid).toBe('thid-1');
        // The formats block survives alongside the comment.
        expect((both.body as any).formats[0].format).toBe(VC_ATTACHMENT_FORMAT);
        expect(attachedJson(both)).toEqual(credential);
    });
});

describe('present-proof optional fields', () => {
    it('omits an absent comment on a presentation request', () => {
        expect(requestPresentation().body).toEqual({});
        expect(requestPresentation('prove it').body).toEqual({ comment: 'prove it' });
    });

    it('threads and comments a presentation independently', () => {
        const presentation = { id: 'did:cid:vp' };

        const bare = presentationMessage(presentation);
        expect(bare.thid).toBeUndefined();

        const both = presentationMessage(presentation, { thid: 'thid-2', comment: 'as requested' });
        expect(both.thid).toBe('thid-2');
        expect((both.body as any).comment).toBe('as requested');
        expect((both.body as any).formats[0].format).toBe(VP_ATTACHMENT_FORMAT);
        expect(attachedJson(both)).toEqual(presentation);
    });
});

describe('attachedJson lookup', () => {
    it('reads a non-default attachment index', () => {
        const message = {
            attachments: [
                { data: { json: { first: true } } },
                { data: { json: { second: true } } },
            ],
        };

        expect(attachedJson(message)).toEqual({ first: true });
        expect(attachedJson(message, 1)).toEqual({ second: true });
    });

    it('returns undefined rather than throwing on a malformed message', () => {
        expect(attachedJson({} as any)).toBeUndefined();
        expect(attachedJson({ attachments: [] })).toBeUndefined();
        expect(attachedJson({ attachments: [{}] })).toBeUndefined();
        expect(attachedJson({ attachments: [{ data: {} }] })).toBeUndefined();
        expect(attachedJson({ attachments: [{ data: { json: { a: 1 } } }] }, 5)).toBeUndefined();
        expect(attachedJson(null as any)).toBeUndefined();
    });
});

describe('coordinate-mediation threading', () => {
    it('threads a grant only when a thid is supplied', () => {
        const bare = mediateGrant('did:cid:router');
        expect(bare.thid).toBeUndefined();
        expect(bare.body).toEqual({ routing_did: 'did:cid:router' });

        const threaded = mediateGrant('did:cid:router', 'thid-3');
        expect(threaded.thid).toBe('thid-3');
    });

    it('threads a deny only when a thid is supplied', () => {
        expect(mediateDeny().thid).toBeUndefined();
        expect(mediateDeny('thid-4').thid).toBe('thid-4');
    });

    it('defaults keylist updates to add and honours remove', () => {
        const added = keylistUpdate(['did:cid:a', 'did:cid:b']).body.updates as any[];
        expect(added.map(u => u.action)).toEqual(['add', 'add']);
        expect(added.map(u => u.recipient_did)).toEqual(['did:cid:a', 'did:cid:b']);

        const removed = keylistUpdate(['did:cid:a'], 'remove').body.updates as any[];
        expect(removed[0]).toEqual({ recipient_did: 'did:cid:a', action: 'remove' });
    });

    it('threads a keylist update response only when a thid is supplied', () => {
        const updated = [{ recipient_did: 'did:cid:a', action: 'add' as const, result: 'success' as const }];

        expect(keylistUpdateResponse(updated).thid).toBeUndefined();
        expect(keylistUpdateResponse(updated, 'thid-5').thid).toBe('thid-5');
    });

    it('threads a keylist only when a thid is supplied', () => {
        expect(keylist(['did:cid:a']).thid).toBeUndefined();

        const threaded = keylist(['did:cid:a'], 'thid-6');
        expect(threaded.thid).toBe('thid-6');
        expect(threaded.body.keys).toEqual([{ recipient_did: 'did:cid:a' }]);
    });

    it('builds an empty keylist for no recipients', () => {
        expect(keylist([]).body.keys).toEqual([]);
        expect(keylistUpdate([]).body.updates).toEqual([]);
    });
});
