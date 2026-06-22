// DIDComm v2 application protocol message builders (didcomm.org). These produce
// the plaintext DIDComm message (type + body, optional thid for responses) that
// is then packed/sent. Pure functions — no keys or network.

export const TRUST_PING_TYPE = 'https://didcomm.org/trust-ping/2.0/ping';
export const TRUST_PING_RESPONSE_TYPE = 'https://didcomm.org/trust-ping/2.0/ping-response';
export const BASIC_MESSAGE_TYPE = 'https://didcomm.org/basicmessage/2.0/message';
export const DISCOVER_FEATURES_QUERIES_TYPE = 'https://didcomm.org/discover-features/2.0/queries';
export const DISCOVER_FEATURES_DISCLOSE_TYPE = 'https://didcomm.org/discover-features/2.0/disclose';
export const OUT_OF_BAND_INVITATION_TYPE = 'https://didcomm.org/out-of-band/2.0/invitation';

export interface DidCommPlaintext {
    type: string;
    body: Record<string, unknown>;
    thid?: string;
    from?: string;
    [key: string]: unknown;
}

export function trustPing(responseRequested = true): DidCommPlaintext {
    return { type: TRUST_PING_TYPE, body: { response_requested: responseRequested } };
}

export function trustPingResponse(thid: string): DidCommPlaintext {
    return { type: TRUST_PING_RESPONSE_TYPE, thid, body: {} };
}

export function basicMessage(content: string): DidCommPlaintext {
    return { type: BASIC_MESSAGE_TYPE, body: { content } };
}

export function discoverFeaturesQuery(match = '*'): DidCommPlaintext {
    return { type: DISCOVER_FEATURES_QUERIES_TYPE, body: { queries: [{ 'feature-type': 'protocol', match }] } };
}

export function discoverFeaturesDisclose(thid: string, protocolIds: string[]): DidCommPlaintext {
    return {
        type: DISCOVER_FEATURES_DISCLOSE_TYPE,
        thid,
        body: { disclosures: protocolIds.map(id => ({ 'feature-type': 'protocol', id })) },
    };
}

export interface OutOfBandBody {
    goal_code?: string;
    goal?: string;
    accept?: string[];
}

export function outOfBandInvitation(from: string, body: OutOfBandBody = {}): DidCommPlaintext {
    return { type: OUT_OF_BAND_INVITATION_TYPE, from, body: { accept: ['didcomm/v2'], ...body } };
}

// Portable base64url (works in node + browser; avoids relying on Buffer's
// 'base64url' encoding being present).
function toBase64Url(bytesJson: string): string {
    return Buffer.from(bytesJson, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(b64url: string): string {
    return Buffer.from(b64url.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

// An Out-of-Band invitation is shared as a URL: <base>?_oob=<base64url(JSON)>.
export function encodeOutOfBandInvitation(invitation: object, base = 'https://didcomm.org'): string {
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}_oob=${toBase64Url(JSON.stringify(invitation))}`;
}

export function decodeOutOfBandInvitation(urlOrOob: string): any {
    const match = urlOrOob.match(/[?&]_oob=([^&]+)/);
    const oob = match ? decodeURIComponent(match[1]) : urlOrOob;
    return JSON.parse(fromBase64Url(oob));
}
