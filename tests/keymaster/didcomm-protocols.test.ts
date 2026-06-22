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
