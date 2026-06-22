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
    issueCredentialMessage,
    requestPresentation,
    presentationMessage,
    attachedJson,
    ISSUE_CREDENTIAL_TYPE,
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
