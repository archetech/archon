// Out-of-band invitation encoding for the demo wallets.
//
// This duplicates `encodeOutOfBandInvitation` / `decodeOutOfBandInvitation` from
// @didcid/keymaster rather than importing them: KeymasterUI.jsx is shared with
// the server-wallet demo, which depends only on the thin client package, and
// pulling the keymaster package in for two helpers would drag it into that
// bundle.
//
// Duplication drifts, and drift here would strand invitations between wallets
// silently -- an invitation from one would simply fail to decode in the other.
// So this lives in its own importable module and
// tests/wallet/oob-codec.test.ts compares it against the library implementation.
// Keep it importable; inlining it back into KeymasterUI.jsx would put it beyond
// the reach of that test.

export const OUT_OF_BAND_INVITATION_TYPE = 'https://didcomm.org/out-of-band/2.0/invitation';

// btoa is byte-oriented, so UTF-8 has to be encoded by hand before it and
// decoded after it; the library reaches Buffer for the same job.
function toBase64Url(json) {
    return btoa(unescape(encodeURIComponent(json)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

function fromBase64Url(b64url) {
    return decodeURIComponent(escape(atob(b64url.replace(/-/g, '+').replace(/_/g, '/'))));
}

export function outOfBandInvitation(from, body = {}) {
    return {
        type: OUT_OF_BAND_INVITATION_TYPE,
        from,
        body: { accept: ['didcomm/v2'], ...body },
    };
}

export function encodeOutOfBandInvitation(invitation, base = 'https://didcomm.org') {
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}_oob=${toBase64Url(JSON.stringify(invitation))}`;
}

export function decodeOutOfBandInvitation(urlOrOob) {
    const match = urlOrOob.match(/[?&]_oob=([^&]+)/);
    const oob = match ? decodeURIComponent(match[1]) : urlOrOob;
    return JSON.parse(fromBase64Url(oob));
}
